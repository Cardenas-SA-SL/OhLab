import { describe, expect, it, vi } from 'vitest'
import type { Hub } from '../hub'
import { createEmbeddedHubHost, preferredHubAddresses } from './embedded-hub'

describe('embedded Hub', () => {
  it('prefers Tailscale, then LAN, then none', () => {
    const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.8' } as any], utun: [{ family: 'IPv4', internal: false, address: '100.70.1.2' } as any] }
    expect(preferredHubAddresses(interfaces, '', 99)[0]).toMatchObject({ address: '100.70.1.2', kind: 'tailscale' })
    expect(preferredHubAddresses(interfaces, '', 99)[1]).toMatchObject({ address: '192.168.1.8', kind: 'lan' })
    expect(preferredHubAddresses({ en0: interfaces.en0 }, '', 99)).toMatchObject([{ address: '192.168.1.8', kind: 'lan' }])
    expect(preferredHubAddresses({}, '', 99)).toEqual([])
  })
  it('boots once and closes when disabled', async () => {
    const close = vi.fn(async () => {})
    const listen = vi.fn(async () => ({ address: '0.0.0.0', family: 'IPv4', port: 8791 }))
    const make = vi.fn(() => ({ close, listen, address: () => null, stats: () => ({ tokens: 0, devices: 0, challenges: 0, sessions: 0, accounts: 0, projects: 0 }) }) as Hub)
    const host = createEmbeddedHubHost('/tmp/ohlab-test', () => {}, make)
    await host.sync(true, 8791)
    await host.sync(true, 8791)
    expect(make).toHaveBeenCalledTimes(1)
    await host.sync(false, 8791)
    expect(close).toHaveBeenCalledOnce()
  })
})
