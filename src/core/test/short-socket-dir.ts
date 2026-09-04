import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Create a test directory short enough for macOS's 104-byte Unix-socket path limit. */
export function makeShortSocketDir(prefix = 'nt-'): string {
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
  return fs.mkdtempSync(path.join(base, prefix))
}
