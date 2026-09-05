import { describe, expect, it } from 'vitest'
import { relayUrlMatchesHub } from './relay-url-guard'

describe('relayUrlMatchesHub', () => {
  it('accepts the Hub\'s own relay endpoint, however the Hub is addressed', () => {
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay', 'http://127.0.0.1:8791')).toBe(true)
    expect(relayUrlMatchesHub('ws://100.72.1.5:8791/relay', 'http://100.72.1.5:8791')).toBe(true)
    expect(relayUrlMatchesHub('ws://hub.tailnet:8791/relay', 'hub.tailnet:8791/')).toBe(true)
    expect(relayUrlMatchesHub('wss://hub.example/relay', 'https://hub.example')).toBe(true)
    expect(relayUrlMatchesHub('wss://hub.example:443/relay', 'https://hub.example')).toBe(true)
    expect(relayUrlMatchesHub('ws://hub.example:80/relay', 'http://hub.example')).toBe(true)
    expect(relayUrlMatchesHub('ws://HUB.example/relay', 'http://hub.example')).toBe(true)
    expect(relayUrlMatchesHub('ws://[::1]:8791/relay', 'http://[::1]:8791')).toBe(true)
  })

  it('accepts the relay under the Hub\'s base path, and the bare path a prefix-stripping proxy leaves', () => {
    expect(relayUrlMatchesHub('wss://hub.example/base/relay', 'https://hub.example/base/')).toBe(true)
    expect(relayUrlMatchesHub('wss://hub.example/relay', 'https://hub.example/base')).toBe(true)
    expect(relayUrlMatchesHub('wss://hub.example/other/relay', 'https://hub.example/base')).toBe(false)
  })

  it('refuses another origin: host, port, or a scheme the Hub would not advertise', () => {
    expect(relayUrlMatchesHub('ws://evil.example:8791/relay', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:9999/relay', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1/relay', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('wss://127.0.0.1:8791/relay', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://hub.example/relay', 'https://hub.example')).toBe(false)
    expect(relayUrlMatchesHub('http://127.0.0.1:8791/relay', 'http://127.0.0.1:8791')).toBe(false)
  })

  it('refuses anything but the plain /relay path', () => {
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay/x', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/dir', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay?token=x', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay#x', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://user:pw@127.0.0.1:8791/relay', 'http://127.0.0.1:8791')).toBe(false)
  })

  it('refuses what it cannot parse, and never throws', () => {
    expect(relayUrlMatchesHub('not a url', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('', 'http://127.0.0.1:8791')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay', '')).toBe(false)
    expect(relayUrlMatchesHub('ws://127.0.0.1:8791/relay', 'file:///tmp/hub')).toBe(false)
  })
})
