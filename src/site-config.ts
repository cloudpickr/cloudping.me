export function getGaId(): string | undefined {
  const id = process.env.NEXT_PUBLIC_GA_ID
  if (id && /^G-[A-Z0-9]+$/i.test(id)) return id
  return undefined
}

export function getSiteUrl(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_URL
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export const DEFAULT_HEALTH_JSON_URL = 'https://raw.githubusercontent.com/cloudpickr/cloudping.me/status/latest.json'
export const DEFAULT_ORIGIN_HISTORY_BASE = 'https://raw.githubusercontent.com/cloudpickr/cloudping.me/status/h'

export function getHealthJsonUrl(): string {
  return process.env.NEXT_PUBLIC_HEALTH_JSON_URL || DEFAULT_HEALTH_JSON_URL
}

export function getOriginHistoryBase(): string {
  return process.env.NEXT_PUBLIC_STATUS_ORIGIN_HISTORY_BASE || DEFAULT_ORIGIN_HISTORY_BASE
}
