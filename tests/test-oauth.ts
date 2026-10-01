import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import type { AssistantMessageEvent, AssistantMessageLike } from "../src/types.ts"

// Isolate the public login/refresh API from the developer's credentials.
const home = mkdtempSync(join(tmpdir(), "omp-kiro-oauth-"))
const previousHome = process.env.HOME
const previousProfile = process.env.USERPROFILE
process.env.HOME = home
process.env.USERPROFILE = home
const { login, refreshToken } = await import("../src/oauth.ts")
const { createStreamKiro } = await import("../src/core.ts")
after(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  rmSync(home, { recursive: true, force: true })
})

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("organization login", () => {
  it("authorizes in the SSO region and renews with the persisted OIDC registration", async (t) => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const answers = ["5", "https://example.awsapps.com/start", "eu-west-1", ""]
    let browserUrl: string | undefined
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify",
        verificationUriComplete: "https://example.com/verify?code=CODE", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") return response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 })
      return response({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })
    })
    const credentials = await login({
      onPrompt: async () => answers.shift() ?? "",
      onAuth: ({ url }) => { browserUrl = url },
    })
    assert.notEqual(typeof credentials, "string")
    if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
    assert.equal(credentials.access, "access")
    assert.equal(credentials.refresh, "refresh")
    assert.equal(browserUrl, "https://example.com/verify?code=CODE")
    assert.equal(requests[0].url, "https://oidc.eu-west-1.amazonaws.com/client/register")
    assert.equal(requests[0].body.issuerUrl, "https://example.awsapps.com/start")
    assert.equal(requests[1].body.startUrl, "https://example.awsapps.com/start")
    const renewed = await refreshToken(credentials)
    assert.equal(renewed.access, "renewed")
    assert.equal(renewed.refresh, "rotated")
    assert.deepEqual(requests[3], {
      url: "https://oidc.eu-west-1.amazonaws.com/token",
      body: { grantType: "refresh_token", clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
    })
  })

  it("uses the default region when blank and propagates denied authorization", async (t) => {
    const answers = ["5", "https://example.awsapps.com/start", "   ", ""]
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      assert.equal(new URL(String(input)).hostname, "oidc.us-east-1.amazonaws.com")
      if (String(input).endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (String(input).endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify", interval: 0, expiresIn: 600,
      })
      return response({ error: "access_denied" }, 400)
    })
    await assert.rejects(login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} }), /Authorization denied/)
  })

  it("rejects a missing organization URL", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request") })
    for (const answers of [["5", ""]]) {
      await assert.rejects(login({
        onPrompt: async () => answers.shift() ?? "",
        onAuth: () => { throw new Error("Unexpected browser login") },
      }), /IAM Identity Center/)
    }
  })

  it("streams a discovered Opus model using the organization profile", async () => {
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
    let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
    const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
    const events: AssistantMessageEvent[] = []
    const streamKiro = createStreamKiro({
      apiBase: "https://runtime.us-east-1.kiro.dev",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.hostname === "management.us-east-1.kiro.dev" && url.pathname === "/List-Available-Profiles") {
          return response({ profiles: [{ arn: profileArn }] })
        }
        const payload = JSON.parse(String(init?.body)) as {
          profileArn?: string
          conversationState?: { currentMessage?: { userInputMessage?: { modelId?: string } } }
        }
        if (url.hostname !== "runtime.us-east-1.kiro.dev" || payload.profileArn !== profileArn
          || payload.conversationState?.currentMessage?.userInputMessage?.modelId !== "claude-opus-5.5") {
          return response({ message: "Invalid model or missing profile" }, 400)
        }
        return new Response('{"content":"OK"}')
      }) as typeof fetch,
      createStream: () => ({
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }),
      cwd: () => home,
      now: () => Date.now(),
      uuid: () => "test-conversation",
      env: { OMP_KIRO_STREAM_GATE: "0" },
      authPaths: [],
      homeDir: home,
      calculateCost: () => {},
    })
    const output = await streamKiro({
      id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    }, { messages: [{ role: "user", content: "Reply OK" }] }, { apiKey: "organization-token" }).result()
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content, [{ type: "text", text: "OK" }])
  })
})
