export type OverlayModel = {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export type LiveModel = {
  id: string
  name: string
  reasoning?: boolean
  input?: ("text" | "image")[]
  contextWindow?: number
  maxTokens?: number
}

export type FetchDynamicKiroModelsOptions = {
  apiKey?: string
  apiBase: string
  overlay: readonly OverlayModel[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
  profileArn?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8192

function buildListAvailableModelsUrl(apiBase: string, profileArn: string): string {
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/List-Available-Models`)
  url.searchParams.set("origin", "KIRO_CLI")
  url.searchParams.set("profileArn", profileArn)
  return url.toString()
}

export function parseLiveModels(payload: unknown): LiveModel[] | null {
  if (!isRecord(payload)) return null
  const raw = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.availableModels)
      ? payload.availableModels
      : null
  if (!raw) return null

  const models: LiveModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = toOverlayModelId(nonEmptyString(entry.modelId) ?? nonEmptyString(entry.id))
    if (!id || seen.has(id)) continue
    seen.add(id)

    const live: LiveModel = {
      id,
      name: nonEmptyString(entry.modelName) ?? nonEmptyString(entry.name) ?? id,
    }
    const reasoning = readLiveReasoning(entry)
    if (reasoning !== undefined) live.reasoning = reasoning
    if (Array.isArray(entry.supportedInputTypes)) {
      live.input = entry.supportedInputTypes.some((type) => String(type).toUpperCase() === "IMAGE") ? ["text", "image"] : ["text"]
    }
    const limits = isRecord(entry.tokenLimits) ? entry.tokenLimits : undefined
    if (limits) {
      const contextWindow = positiveInt(limits.maxInputTokens)
      const maxTokens = positiveInt(limits.maxOutputTokens)
      if (contextWindow !== undefined) live.contextWindow = contextWindow
      if (maxTokens !== undefined) live.maxTokens = maxTokens
    }
    models.push(live)
  }
  return models
}

export function mergeLiveWithOverlay(
  overlay: readonly OverlayModel[],
  live: readonly LiveModel[],
): OverlayModel[] {
  const overlayById = new Map(overlay.map((model) => [model.id, model]))
  const result = copyOverlay(overlay)
  for (const item of live) {
    if (overlayById.has(item.id)) continue
    const unknown: OverlayModel = {
      id: item.id,
      name: item.name || item.id,
      reasoning: item.reasoning === true,
      input: item.input ? [...item.input] : ["text"],
      contextWindow: item.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: item.maxTokens ?? DEFAULT_MAX_TOKENS,
      cost: { ...ZERO_COST },
    }
    overlayById.set(item.id, unknown)
    result.push(unknown)
  }
  return result
}

export async function fetchDynamicKiroModels(
  options: FetchDynamicKiroModelsOptions,
): Promise<OverlayModel[]> {
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) return []

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  try {
    const profileArn = await resolveKiroProfileArn(options)
    if (!profileArn) return []
    const { body: payload } = await requestManagement(
      fetchImpl,
      buildListAvailableModelsUrl(options.apiBase, profileArn),
      apiKey,
      timeoutMs,
      maxBodyBytes,
    )
    const live = parseLiveModels(payload)
    return live?.length ? mergeLiveWithOverlay(options.overlay, live) : []
  } catch {
    return []
  }
}

export async function resolveKiroProfileArn(
  options: Omit<FetchDynamicKiroModelsOptions, "overlay">,
): Promise<string | undefined> {
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) return undefined
  const isApiKey = apiKey.startsWith("ksk_")
  if (!isApiKey) {
    const override = nonEmptyString((options.env ?? process.env).KIRO_PROFILE_ARN)
    if (override) return override
    if (options.profileArn?.trim()) return options.profileArn.trim()
  }
  const { status, body: profile, message } = await requestManagement(
    options.fetchImpl ?? fetch,
    isApiKey
      ? `${options.apiBase.replace(/\/+$/, "")}/`
      : `${options.apiBase.replace(/\/+$/, "")}/List-Available-Profiles`,
    apiKey,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    isApiKey
      ? { "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetProfile" }
      : { "Content-Type": "application/json" },
    options.signal,
  )
  // Builder ID tokens are not allowed to list profiles; they all share one public profile.
  if (!isApiKey && status === 403 && message?.toLowerCase().includes("not authorized to access this feature")) {
    return BUILDER_ID_PROFILE_ARN
  }
  if (!isRecord(profile)) return undefined
  if (isApiKey) {
    return isRecord(profile.profile) ? nonEmptyString(profile.profile.arn) : undefined
  }
  // Organization accounts may expose several profiles; the first one listed is used.
  const profiles = Array.isArray(profile.profiles) ? profile.profiles : []
  for (const entry of profiles) {
    if (!isRecord(entry)) continue
    const profileArn = nonEmptyString(entry.arn)
    if (profileArn) return profileArn
  }
  return undefined
}

function copyOverlay(overlay: readonly OverlayModel[]): OverlayModel[] {
  return overlay.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }))
}

type ManagementResponse = { status: number; body: unknown; message?: string }

async function requestManagement(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  maxBodyBytes: number,
  postHeaders?: Record<string, string>,
  outerSignal?: AbortSignal,
): Promise<ManagementResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  if (outerSignal?.aborted) controller.abort()
  else outerSignal?.addEventListener("abort", onOuterAbort, { once: true })
  try {
    const response = await fetchImpl(url, {
      method: postHeaders ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...postHeaders,
      },
      ...(postHeaders ? { body: "{}" } : {}),
      signal: controller.signal,
    })
    if (!is2xx(response)) {
      // Error bodies are small; read them so callers can tell "not authorized" from "invalid token".
      const errorBody = await readBoundedJson(response, maxBodyBytes, controller.signal).catch(() => undefined)
      await response.body?.cancel().catch(() => {})
      return { status: response.status, body: undefined, message: isRecord(errorBody) ? nonEmptyString(errorBody.message) : undefined }
    }
    return { status: response.status, body: await readBoundedJson(response, maxBodyBytes, controller.signal) }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener("abort", onOuterAbort)
  }
}

async function readBoundedJson(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  if (signal.aborted) return undefined
  const declared = response.headers?.get?.("content-length")
  if (declared) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBodyBytes) return undefined
  }

  const stream = response.body
  const bytes = stream && typeof stream.getReader === "function"
    ? await readBoundedStream(stream, maxBodyBytes, signal)
    : await readBoundedBuffer(response, maxBodyBytes, signal)
  if (!bytes) return undefined

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", onAbort)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) return undefined
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  return concatBytes(chunks, total)
}

async function readBoundedBuffer(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (signal.aborted) return undefined
  const bytes = typeof response.arrayBuffer === "function"
    ? new Uint8Array(await response.arrayBuffer())
    : new TextEncoder().encode(await response.text())
  if (signal.aborted || bytes.byteLength > maxBodyBytes) return undefined
  return bytes
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function is2xx(response: Response): boolean {
  if (response.ok === true) return true
  return typeof response.status === "number" && response.status >= 200 && response.status < 300
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toOverlayModelId(id: string | undefined): string | undefined {
  return id?.replace(/(\d)\.(\d)(?!\d)/g, "$1-$2")
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function readLiveReasoning(item: Record<string, unknown>): boolean | undefined {
  if (typeof item.reasoning === "boolean") return item.reasoning
  if (typeof item.thinking === "boolean") return item.thinking
  if (typeof item.supportsThinking === "boolean") return item.supportsThinking
  const capabilities = item.capabilities
  if (isRecord(capabilities) && typeof capabilities.thinking === "boolean") return capabilities.thinking
  // Kiro's management catalog advertises thinking through the per-model request schema.
  const schema = item.additionalModelRequestFieldsSchema
  if (isRecord(schema) && isRecord(schema.properties) && isRecord(schema.properties.thinking)
    && schema.properties.thinking.type === "object") return true
  return undefined
}
