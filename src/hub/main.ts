import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from './index'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1]
  const prefix = `--${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') ?? process.env.OHLAB_HUB_DATA_DIR ?? path.join(os.homedir(), '.ohlab-hub'))
  let fileConfig: { adminToken?: string } = {}
  try {
    fileConfig = JSON.parse(await fs.readFile(path.join(dataDir, 'hub.json'), 'utf8')) as { adminToken?: string }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const port = Number(arg('port') ?? process.env.OHLAB_HUB_PORT ?? 8791)
  const host = arg('host') ?? process.env.OHLAB_HUB_HOST ?? '0.0.0.0'
  const hub = createHub({ dataDir, port, host, adminToken: arg('admin-token') ?? fileConfig.adminToken })
  const address = await hub.listen()
  console.log(`[hub] OhLab Hub listening on http://${address.address}:${address.port}`)
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

