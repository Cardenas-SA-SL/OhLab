/**
 * The node/frame/sticky palette shown by every renderer color picker.
 *
 * This is also the control boundary: agent-supplied colors must be one of these exact values,
 * never an arbitrary CSS token that would be persisted and interpolated into node styles.
 */
export const NODE_COLORS = [
  '#0a84ff', // systemBlue
  '#32d74b', // systemGreen
  '#ffd60a', // systemYellow
  '#ff453a', // systemRed
  '#bf5af2', // systemPurple
  '#6ac4dc', // systemTeal
  '#ff9f0a' // systemOrange
] as const

export type NodeColor = (typeof NODE_COLORS)[number]

export const NODE_COLOR_INVALID_ERROR = 'node-color-invalid'

export function isNodeColor(value: unknown): value is NodeColor {
  return typeof value === 'string' && (NODE_COLORS as readonly string[]).includes(value)
}

/** Stable named refusal shared by desktop and Server Edition control dispatch. */
export function invalidNodeColorMessage(): string {
  return `${NODE_COLOR_INVALID_ERROR}: --color must be one of ${NODE_COLORS.join(', ')}`
}
