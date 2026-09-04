export const HUB_REQUIRED_ERROR = 'Set the OhLab Hub URL in Settings > Team'

export function normalizeHubUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Hub URL must use http or https')
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function hubApiBase(hubUrl: string): string {
  return process.env.NODETERM_API_BASE || normalizeHubUrl(hubUrl)
}

export function hubRelayUrl(hubUrl: string): string {
  if (process.env.NODETERM_RELAY_URL) return process.env.NODETERM_RELAY_URL
  const base = new URL(normalizeHubUrl(hubUrl))
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${base.pathname.replace(/\/$/, '')}/relay`
  return base.toString()
}

export function hubDirectoryUrl(hubUrl: string, session: string): string {
  const base = new URL(normalizeHubUrl(hubUrl))
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${base.pathname.replace(/\/$/, '')}/dir`
  base.searchParams.set('session', session)
  return base.toString()
}

