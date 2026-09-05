import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub, type HubLimits } from './index'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1]
  const prefix = `--${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length)
}

function flag(name: string, envName: string): boolean {
  if (process.argv.includes(`--${name}`)) return true
  const value = (process.env[envName] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

interface HubFileConfig {
  adminToken?: string
  trustProxy?: boolean
  limits?: Partial<HubLimits>
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') ?? process.env.OHLAB_HUB_DATA_DIR ?? path.join(os.homedir(), '.ohlab-hub'))
  let fileConfig: HubFileConfig = {}
  try {
    fileConfig = JSON.parse(await fs.readFile(path.join(dataDir, 'hub.json'), 'utf8')) as HubFileConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const port = Number(arg('port') ?? process.env.OHLAB_HUB_PORT ?? 8791)
  const host = arg('host') ?? process.env.OHLAB_HUB_HOST ?? '0.0.0.0'
  // Only a Hub deployed behind a reverse proxy may read x-forwarded-for: an unproxied Hub that
  // trusted it would let any client pick the address its rate limits are keyed on.
  const trustProxy = flag('trust-proxy', 'OHLAB_HUB_TRUST_PROXY') || fileConfig.trustProxy === true
  const hub = createHub({
    dataDir,
    port,
    host,
    adminToken: arg('admin-token') ?? fileConfig.adminToken,
    trustProxy,
    limits: fileConfig.limits
  })
  const address = await hub.listen()
  console.log(`[hub] OhLab Hub listening on http://${address.address}:${address.port}${trustProxy ? ' (trusting x-forwarded-for)' : ''}`)
  if (host === '0.0.0.0' || host === '::') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.family === 'IPv4') console.log(`[hub] http://${entry.address}:${address.port}`)
      }
    }
  }
  const stop = (): void => { void hub.close().finally(() => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

void main().catch((error) => {
  console.error('[hub] failed to start:', error)
  process.exitCode = 1
})
