import { afterEach, describe, expect, it } from 'vitest'
import { hubApiBase, hubDirectoryUrl, hubRelayUrl, normalizeHubUrl } from './url'

describe('OhLab Hub URLs', () => {
  afterEach(() => {
    delete process.env.NODETERM_API_BASE
    delete process.env.NODETERM_RELAY_URL
  })

  it('normalizes HTTP URLs and derives WebSocket endpoints', () => {
    expect(normalizeHubUrl('hub.tailnet:8791/')).toBe('http://hub.tailnet:8791')
    expect(hubApiBase('https://hub.example/base/')).toBe('https://hub.example/base')
    expect(hubRelayUrl('https://hub.example/base/')).toBe('wss://hub.example/base/relay')
    expect(hubDirectoryUrl('http://hub.example', 'session value')).toBe(
      'ws://hub.example/dir?session=session+value'
    )
  })

  it('keeps the relay and API environment overrides used by tests', () => {
    process.env.NODETERM_API_BASE = 'https://api.test'
    process.env.NODETERM_RELAY_URL = 'wss://relay.test/socket'
    expect(hubApiBase('')).toBe('https://api.test')
    expect(hubRelayUrl('')).toBe('wss://relay.test/socket')
  })

  it('rejects non-HTTP schemes', () => {
    expect(() => normalizeHubUrl('file:///tmp/hub')).toThrow('http or https')
  })
})
