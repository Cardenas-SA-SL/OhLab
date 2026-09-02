// Two surfaces host a <webview> — the canvas WebNode and the BrowserSurface shared by the browser
// node and the kanban card modal. A failed page must read the same on both, and a page that failed
// must be COVERED rather than left showing Chromium's own error page, so both go through the one
// module and the one plate. The tempting simplification is a per-surface string, which is how the
// two ended up describing (and, in WebNode's case, not describing) the same failure differently.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (file: string): string => readFileSync(path.join(__dirname, file), 'utf8')

const SURFACES = ['WebNode.tsx', 'BrowserSurface.tsx']

describe('every webview surface reports load failures the same way', () => {
  it.each(SURFACES)('%s describes a failure through the shared module', (file) => {
    const src = read(file)
    expect(src).toContain("from './webviewError'")
    expect(src).toContain('describeLoadFailure(')
    expect(src).toContain('<WebviewErrorPlate')
  })

  it.each(SURFACES)('%s filters the event through isReportableFailure', (file) => {
    const src = read(file)
    expect(src).toContain('isReportableFailure(')
    // Not the inlined predicate this replaced: a bare `!== -3` loses the name of what it skips.
    expect(src).not.toMatch(/errorCode\s*!==\s*-3/)
  })

  it.each(SURFACES)('%s shows the shared bar while a navigation is in flight', (file) => {
    expect(read(file)).toContain('<WebviewLoadingBar')
  })

  it.each(SURFACES)('%s clears the plate on did-start-loading, never on did-navigate', (file) => {
    // Chromium navigates to its own error page under the URL that just failed, so clearing the
    // plate from `did-navigate` would wipe it the instant it appears.
    const src = read(file)
    const start = src.indexOf('const onStart')
    expect(start).toBeGreaterThan(-1)
    expect(src.slice(start, start + 400)).toContain('setFailure(null)')
    const nav = src.indexOf('const onNav = ')
    if (nav > -1) expect(src.slice(nav, src.indexOf('const onNavInPage'))).not.toContain('setFailure(')
  })
})
