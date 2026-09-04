// Polls OhLab's static announcements feed from the main process (so the renderer CSP stays 'self').
// Updates are handled independently by electron-updater through the GitHub publish provider.
import { platform } from './platform'
import type { Announcement, UpdatePolicy } from '../shared/types'

const ANNOUNCEMENTS_URL =
  'https://raw.githubusercontent.com/Cardenas-SA-SL/OhLab/main/docs/announcements.json'
const CACHE_MS = 5 * 60 * 1000

export interface CheckResult {
  messages: Announcement[]
  update: UpdatePolicy
}

const EMPTY: CheckResult = { messages: [], update: { minSupported: null, mandatory: false } }

// Dev builds never contact the production announcement feed. The existing privacy kill switches
// remain hard opt-outs for all background product communication.
function allowed(): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  return platform().isPackaged
}

function sanitize(data: unknown): CheckResult {
  if (!data || typeof data !== 'object') return EMPTY
  const d = data as Record<string, unknown>
  const rawMessages = Array.isArray(data) ? data : Array.isArray(d.messages) ? d.messages : []
  const messages: Announcement[] = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.id === 'string' && typeof m.title === 'string')
    .map((m) => ({
      id: m.id as string,
      title: m.title as string,
      body: typeof m.body === 'string' ? m.body : undefined,
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : undefined,
      level: m.level === 'success' || m.level === 'warning' ? m.level : 'info'
    }))
  const u = (d.update ?? {}) as Record<string, unknown>
  const update: UpdatePolicy = {
    minSupported: typeof u.minSupported === 'string' ? u.minSupported : null,
    mandatory: u.mandatory === true
  }
  return { messages, update }
}

let cache: { at: number; data: CheckResult } | null = null

export async function fetchCheck(): Promise<CheckResult> {
  if (!allowed()) return EMPTY
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.data
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(ANNOUNCEMENTS_URL, {
      signal: ctrl.signal,
      cache: 'no-cache'
    }).finally(() => clearTimeout(t))
    if (!res.ok) return cache?.data ?? EMPTY
    const data = sanitize(await res.json())
    cache = { at: now, data }
    return data
  } catch {
    return cache?.data ?? EMPTY
  }
}
