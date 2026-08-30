import { describe, expect, it } from 'vitest'

import {
  invalidNodeColorMessage,
  isNodeColor,
  NODE_COLORS,
  NODE_COLOR_INVALID_ERROR
} from './node-colors'

describe('node color palette', () => {
  it('accepts exactly the renderer palette', () => {
    for (const color of NODE_COLORS) expect(isNodeColor(color), color).toBe(true)
    for (const color of ['#ffffff', '#0A84FF', 'red', 'var(--accent)', '', undefined]) {
      expect(isNodeColor(color), String(color)).toBe(false)
    }
  })

  it('returns a stable named refusal without echoing hostile input', () => {
    const message = invalidNodeColorMessage()
    expect(message).toContain(NODE_COLOR_INVALID_ERROR)
    expect(message).toContain(NODE_COLORS.join(', '))
    expect(message).not.toContain('\n')
  })
})
