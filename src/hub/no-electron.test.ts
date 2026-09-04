import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : file.endsWith('.ts') ? [file] : []
  })
}

const OFFENDERS = /from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron(\/[^'"]*)?['"]\)|from ['"](\.\.\/)+main\//

describe('hub boundary', () => {
  it('does not import Electron or the Electron main shell', () => {
    const offenders = walk(__dirname).filter((file) => file !== __filename).filter((file) => OFFENDERS.test(fs.readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})

