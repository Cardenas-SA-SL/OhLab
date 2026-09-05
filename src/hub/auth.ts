import { createHash, timingSafeEqual } from 'node:crypto'

/** Compare two secrets without leaking where they diverge (security review, finding 5). Both sides
 *  are hashed to a fixed width first, so neither the length nor the prefix of the real token shapes
 *  the timing - `timingSafeEqual` itself requires equal-length inputs, and an early length branch
 *  would already tell a probing caller how long the admin token is. */
export function constantTimeEqual(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(left, right)
}
