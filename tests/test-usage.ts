import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createKiroUsageProvider } from "../src/usage.ts"

const BASE = "https://management.us-east-1.kiro.dev"
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("Kiro usage provider", () => {
  it("reports monthly credits and bonus credits for an OAuth session", async () => {
    const seen: string[] = []
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => undefined,
      now: () => 1_000,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        seen.push(url.pathname)
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer oauth-token")
        if (url.pathname === "/List-Available-Profiles") return json({ profiles: [{ arn: PROFILE_ARN }] })
        if (url.pathname === "/Get-Usage-Limits" && url.searchParams.get("profileArn") === PROFILE_ARN
          && url.searchParams.get("resourceType") === "CREDIT") {
          return json({
            subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
            userInfo: { userId: "user-1" },
            usageBreakdownList: [{
              resourceType: "CREDIT",
              displayName: "Credits",
              currentUsageWithPrecision: 450,
              usageLimitWithPrecision: 1000,
              nextDateReset: 1_800_000_000,
              freeTrialInfo: { currentUsage: 100, usageLimit: 100, freeTrialExpiry: 1_790_000_000 },
            }],
          })
        }
        return json({}, 404)
      }) as typeof fetch,
    })

    const params = { provider: "kiro", credential: { type: "oauth" as const, accessToken: "oauth-token" } }
    assert.equal(provider.supports(params), true)
    const report = await provider.fetchUsage(params)

    assert.deepEqual(seen, ["/List-Available-Profiles", "/Get-Usage-Limits"])
    assert.equal(report?.metadata?.planType, "KIRO PRO")
    assert.equal(report?.limits.length, 2)
    const [monthly, bonus] = report!.limits
    assert.deepEqual(monthly.amount, {
      used: 450, limit: 1000, remaining: 550, usedFraction: 0.45, remainingFraction: 0.55, unit: "credits",
    })
    assert.equal(monthly.status, "ok")
    assert.equal(monthly.window?.resetsAt, 1_800_000_000_000)
    assert.equal(bonus.status, "exhausted")
    assert.equal(bonus.window?.resetLabel, "expires")
    // The plan labels the limit, and without a credential id the Kiro user id identifies the account.
    assert.equal(monthly.scope.tier, "KIRO PRO")
    assert.equal(monthly.scope.accountId, "user-1")
    assert.equal(report?.metadata?.accountId, "user-1")

    // OMP pairs a report with its credential by account id, so the credential's id takes precedence.
    const paired = await provider.fetchUsage({
      provider: "kiro",
      credential: { type: "oauth", accessToken: "oauth-token", accountId: "kiro" },
    })
    assert.equal(paired?.metadata?.accountId, "kiro")
    assert.equal(paired?.limits[0].scope.accountId, "kiro")
  })

  it("uses the saved profile without listing profiles", async () => {
    const seen: string[] = []
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(new URL(String(input)).pathname)
        return json({ usageBreakdown: { resourceType: "CREDIT", currentUsage: 95, usageLimit: 100 } })
      }) as typeof fetch,
    })
    const report = await provider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: "t" } })
    assert.deepEqual(seen, ["/Get-Usage-Limits"])
    assert.equal(report?.limits[0].status, "warning")
  })

  it("throws on an HTTP failure so OMP keeps the last good report", async () => {
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async () => json({ message: "denied" }, 403)) as typeof fetch,
    })
    await assert.rejects(
      provider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: "t" } }),
      /Kiro usage request failed \(403\)/,
    )
  })

  it("does not support other providers or missing credentials", () => {
    const provider = createKiroUsageProvider({ managementBase: BASE, getProfileArn: () => undefined })
    assert.equal(provider.supports({ provider: "other", credential: { type: "oauth", accessToken: "t" } }), false)
    assert.equal(provider.supports({ provider: "kiro", credential: { type: "api_key", apiKey: " " } }), false)
  })
})
