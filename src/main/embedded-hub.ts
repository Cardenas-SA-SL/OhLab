import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import type { HubHostAddress, HubHostStatus } from '../shared/types'
import { createHub, type Hub } from '../hub'

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

function isTailscale(address: string): boolean {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

export function preferredHubAddresses(interfaces: Interfaces, tailscaleOutput = '', port = 8791): HubHostAddress[] {
  const found = new Set<string>()
  for (const raw of tailscaleOutput.split(/\s+/)) if (isTailscale(raw)) found.add(raw)
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address)
  }
  const all = [...found]
  const tailscale = all.filter(isTailscale)
  const lan = all.filter((address) => !isTailscale(address))
  const selected = tailscale.length ? [...tailscale, ...lan] : lan
  return selected.map((address) => ({
    address,
    url: `http://${address}:${port}`,
    kind: isTailscale(address) ? 'tailscale' : 'lan',
    label: isTailscale(address) ? 'Tailscale' : 'Local network only'
  }))
}

function tailscaleIpv4(): Promise<string> {
  return new Promise((resolve) => execFile('tailscale', ['ip', '-4'], { timeout: 2000 }, (error, stdout) => resolve(error ? '' : stdout)))
}

export interface EmbeddedHubHost {
  sync(enabled: boolean, port: number): Promise<HubHostStatus>
  status(): HubHostStatus
  stop(): Promise<void>
}

export function createEmbeddedHubHost(userData: string, notify: (status: HubHostStatus) => void, makeHub = createHub): EmbeddedHubHost {
  let hub: Hub | null = null
  let current: HubHostStatus = { state: 'disabled' }
  let activePort = 0
  const set = (value: HubHostStatus): HubHostStatus => { current = value; notify(value); return value }
  const stop = async (): Promise<void> => {
    const closing = hub
    hub = null
    activePort = 0
    if (closing) await closing.close()
    set({ state: 'disabled' })
  }
  return {
    status: () => current,
    stop,
    async sync(enabled, requestedPort) {
      const port = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 8791
      if (!enabled) { await stop(); return current }
      if (hub && activePort === port) return current
      if (hub) await stop()
      set({ state: 'starting', port })
      try {
        const next = makeHub({ dataDir: path.join(userData, 'hub'), host: '0.0.0.0', port })
        await next.listen()
        hub = next
        activePort = port
        const addresses = preferredHubAddresses(networkInterfaces(), await tailscaleIpv4(), port)
        return set({ state: 'listening', port, addresses })
      } catch (error) {
        hub = null
        activePort = 0
        return set({ state: 'error', port, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
