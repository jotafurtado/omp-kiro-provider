/**
 * Kiro usage provider for OMP's `/usage` and `omp usage`.
 *
 * Calls Kiro's management API `GET /Get-Usage-Limits` with the account profile
 * and maps the credit buckets into OMP's normalized UsageReport shape.
 * Types mirror @oh-my-pi/pi-ai structurally so the extension stays dependency-free.
 */

import { resolveKiroProfileArn } from "./dynamic-models.ts"

const PROVIDER = "kiro"
const WARNING_FRACTION = 0.9
const DEFAULT_TIMEOUT_MS = 10_000

type UsageStatus = "ok" | "warning" | "exhausted" | "unknown"

export interface UsageCredential {
  type: "api_key" | "oauth"
  apiKey?: string
  accessToken?: string
  accountId?: string
}

export interface UsageFetchParams {
  provider: string
  credential: UsageCredential
}

export interface UsageLimit {
  id: string
  label: string
  scope: { provider: string; windowId?: string; tier?: string; accountId?: string }
  window?: { id: string; label: string; resetsAt?: number; resetLabel?: string }
  amount: {
    used?: number
    limit?: number
    remaining?: number
    usedFraction?: number
    remainingFraction?: number
    unit: "credits" | "unknown"
  }
  status?: UsageStatus
  notes?: string[]
}

export interface UsageReport {
  provider: string
  fetchedAt: number
  limits: UsageLimit[]
  notes?: string[]
  metadata?: Record<string, unknown>
}

export interface KiroUsageOptions {
  managementBase: string
  getProfileArn: () => string | undefined
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

interface UsageBreakdown {
  resourceType?: string
  displayName?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentOverages?: number
  currentOveragesWithPrecision?: number
  nextDateReset?: number | string
  freeTrialInfo?: {
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    freeTrialExpiry?: number | string
  }
}

interface UsageLimitsResponse {
  nextDateReset?: number | string
  usageBreakdown?: UsageBreakdown
  usageBreakdownList?: UsageBreakdown[]
  subscriptionInfo?: { subscriptionTitle?: string }
  overageConfiguration?: { overageStatus?: string }
  userInfo?: { userId?: string }
}

/** Kiro sends epoch seconds or ISO strings; OMP wants epoch milliseconds. */
function toEpochMs(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function buildLimit(args: {
  id: string
  label: string
  used?: number
  limit?: number
  window: { id: string; label: string; resetsAt?: number; resetLabel?: string }
  unit: UsageLimit["amount"]["unit"]
  notes?: string[]
  tier?: string
  accountId?: string
}): UsageLimit {
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined
  const usedFraction = limit !== undefined && args.used !== undefined ? args.used / limit : undefined
  let status: UsageStatus = "unknown"
  if (usedFraction !== undefined) {
    status = usedFraction >= 1 ? "exhausted" : usedFraction >= WARNING_FRACTION ? "warning" : "ok"
  }
  const window = { ...args.window }
  if (window.resetsAt === undefined) delete window.resetsAt
  return {
    id: args.id,
    label: args.label,
    scope: {
      provider: PROVIDER,
      windowId: window.id,
      ...(args.tier ? { tier: args.tier } : {}),
      ...(args.accountId ? { accountId: args.accountId } : {}),
    },
    window,
    amount: {
      ...(args.used !== undefined ? { used: args.used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(limit !== undefined && args.used !== undefined ? { remaining: Math.max(0, limit - args.used) } : {}),
      ...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
      unit: args.unit,
    },
    status,
    ...(args.notes?.length ? { notes: args.notes } : {}),
  }
}

export function toUsageReport(raw: UsageLimitsResponse, fetchedAt: number, credentialAccountId?: string): UsageReport {
  const buckets = raw.usageBreakdownList?.length
    ? raw.usageBreakdownList
    : raw.usageBreakdown ? [raw.usageBreakdown] : []
  const plan = raw.subscriptionInfo?.subscriptionTitle
  // OMP pairs a report with its credential by account id, so the credential's id wins over Kiro's user id.
  const accountId = credentialAccountId?.trim()
    || (typeof raw.userInfo?.userId === "string" ? raw.userInfo.userId.trim() : "")
    || undefined
  const limits = buckets.flatMap((bucket, index) => {
    const id = bucket.resourceType || `usage-${index}`
    const unit = bucket.resourceType === "CREDIT" ? "credits" : "unknown"
    const overages = finite(bucket.currentOveragesWithPrecision ?? bucket.currentOverages)
    const result = [buildLimit({
      id: `kiro:${id}`,
      label: bucket.displayName || "Credits",
      used: finite(bucket.currentUsageWithPrecision ?? bucket.currentUsage),
      limit: finite(bucket.usageLimitWithPrecision ?? bucket.usageLimit),
      window: { id: "monthly", label: "Monthly", resetsAt: toEpochMs(bucket.nextDateReset ?? raw.nextDateReset) },
      unit,
      notes: overages && overages > 0 ? [`Overages: ${overages}`] : undefined,
      tier: plan,
      accountId,
    })]
    // Free-trial bonus credits expire on their own date instead of resetting monthly.
    const trial = bucket.freeTrialInfo
    if (trial) {
      result.push(buildLimit({
        id: `kiro:${id}:bonus`,
        label: "Bonus credits",
        used: finite(trial.currentUsageWithPrecision ?? trial.currentUsage),
        limit: finite(trial.usageLimitWithPrecision ?? trial.usageLimit),
        window: { id: "bonus", label: "Bonus", resetsAt: toEpochMs(trial.freeTrialExpiry), resetLabel: "expires" },
        unit,
        tier: plan,
        accountId,
      }))
    }
    return result
  })
  return {
    provider: PROVIDER,
    fetchedAt,
    limits,
    ...(raw.overageConfiguration?.overageStatus === "ENABLED" ? { notes: ["Overages enabled"] } : {}),
    metadata: {
      source: "kiro-management",
      ...(plan ? { planType: plan } : {}),
      ...(accountId ? { accountId } : {}),
    },
  }
}

export function createKiroUsageProvider(options: KiroUsageOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const accessOf = (credential: UsageCredential) =>
    (credential.type === "api_key" ? credential.apiKey : credential.accessToken)?.trim()

  return {
    id: PROVIDER,
    cacheVersion: 2,
    supports: ({ provider, credential }: UsageFetchParams) => provider === PROVIDER && Boolean(accessOf(credential)),
    async fetchUsage({ credential }: UsageFetchParams): Promise<UsageReport | null> {
      const apiKey = accessOf(credential)
      if (!apiKey) return null
      const profileArn = await resolveKiroProfileArn({
        apiKey,
        apiBase: options.managementBase,
        fetchImpl,
        timeoutMs,
        profileArn: options.getProfileArn(),
      })
      if (!profileArn) throw new Error("No accessible Kiro profile found for usage lookup.")

      const url = new URL(`${options.managementBase.replace(/\/+$/, "")}/Get-Usage-Limits`)
      url.searchParams.set("origin", "KIRO_CLI")
      url.searchParams.set("profileArn", profileArn)
      url.searchParams.set("resourceType", "CREDIT")
      url.searchParams.set("isEmailRequired", "false")
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Throw so OMP logs the failure and keeps serving the last good report.
      if (!response.ok) throw new Error(`Kiro usage request failed (${response.status})`)
      return toUsageReport(await response.json() as UsageLimitsResponse, now(), credential.accountId)
    },
  }
}
