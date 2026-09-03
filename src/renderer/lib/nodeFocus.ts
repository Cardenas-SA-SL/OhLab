import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/system'

/**
 * "Zoom to this node" geometry, computed without React Flow's `fitView`.
 *
 * Why this exists: `fitView({ nodes: [{ id }] })` is the natural way to frame one node, and it is
 * what `Canvas.goToNode` used to do — but it frames nothing when you call it. It sets
 * `fitViewQueued` and the fit is RESOLVED LATER: from a subsequent `setNodes` (and only once EVERY
 * node is measured) or from the next `updateNodeInternals`. Whatever `nodeLookup` holds by then is
 * what gets framed. And the fit set is filtered down to nodes React Flow has already MEASURED
 * (`getFitViewNodes` keys off `measured.width && measured.height`; there is no `width`/`height`
 * fallback there), so a set that comes out EMPTY collapses the bounds to `{0,0,0,0}` and the camera
 * flies to the canvas ORIGIN at max zoom — an empty stretch of canvas, nowhere near the node.
 *
 * Both halves fire on the same everyday path. A cross-project focus (sessions sidebar, OS
 * notification, ⌘K jump, presence travel) switches project → loads its nodes → frames the target,
 * all before the mount-time measuring has settled: the queued fit then waits for a later node
 * update, and by the time it runs the canvas may have moved on. The second click always works,
 * because by then everything is measured — which is what makes it read as "sometimes".
 *
 * So the maths is ours, from React Flow's measurement when it has one and from the size the node
 * was persisted with when it does not — neither needs layout — and the camera is driven with
 * `setViewport`, which applies immediately.
 */

/** The subset of a React Flow node this module needs. Loose on purpose: it must accept both a
 *  freshly deserialized node (`width`/`height`, no `measured`) and a live measured one. */
export interface FocusableNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
  style?: { width?: number | string | null; height?: number | string | null }
}

/** Zoom/padding for framing a single node, shared by both framing paths here so the whole-pane
 *  and chrome-free-frame answers cannot drift apart: the clamp keeps a small node from filling the
 *  screen and a huge one from being fit microscopic. */
export const FIT_NODE_OPTIONS = { padding: 0.2, minZoom: 0.25, maxZoom: 1.38 } as const

/** A `parentId` chain longer than this is a data bug (or a cycle) — stop walking. */
const MAX_PARENT_DEPTH = 20

const numeric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

const sizeOf = (n: FocusableNode): { width: number; height: number } | null => {
  const width = numeric(n.measured?.width) ?? numeric(n.width) ?? numeric(n.style?.width)
  const height = numeric(n.measured?.height) ?? numeric(n.height) ?? numeric(n.style?.height)
  return width && height ? { width, height } : null
}

/**
 * The node's top-left in ABSOLUTE canvas coordinates. A grouped node's `position` is relative to
 * its group frame, so the parent chain is walked. Needs no size — unlike `nodeFitRect` this always
 * answers, which is what placement (as opposed to framing) needs: a node spawned next to a grouped
 * source must be positioned in the same space the source really occupies, not at its raw
 * group-relative `position`.
 */
export function absolutePosition(
  node: FocusableNode,
  all: readonly FocusableNode[]
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = all.find((n) => n.id === parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * The node's rect in ABSOLUTE canvas coordinates, or null when its size is unknowable (in which
 * case the caller must leave the camera alone — a zero-size rect is what produces the origin jump).
 */
export function nodeFitRect(node: FocusableNode, all: readonly FocusableNode[]): Rect | null {
  const size = sizeOf(node)
  if (!size) return null
  return { ...absolutePosition(node, all), ...size }
}

/**
 * The viewport that frames `rect` in a `containerWidth × containerHeight` pane, with the same
 * padding/zoom clamp `fitView` would have applied. Null when the container has no size yet.
 *
 * `zoom` keeps the camera at a scale the caller already has (`settings.focusZoomToNode` off): the
 * node is centred exactly as it would be, at that zoom, so "go to" stays a pan. It is passed
 * through UNCLAMPED — it is a zoom the canvas is already displaying, and re-clamping it to the
 * framing range would rescale the view this option exists to leave alone.
 */
export function viewportForRect(
  rect: Rect,
  containerWidth: number,
  containerHeight: number,
  zoom?: number
): Viewport | null {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return null
  if (zoom !== undefined) {
    if (!(zoom > 0)) return null
    return {
      x: containerWidth / 2 - (rect.x + rect.width / 2) * zoom,
      y: containerHeight / 2 - (rect.y + rect.height / 2) * zoom,
      zoom
    }
  }
  return getViewportForBounds(
    rect,
    containerWidth,
    containerHeight,
    FIT_NODE_OPTIONS.minZoom,
    FIT_NODE_OPTIONS.maxZoom,
    FIT_NODE_OPTIONS.padding
  )
}

/** A rectangle inside the flow pane, in the pane's OWN coordinates (0,0 = its top-left) — the
 *  chrome-free area a node should be framed into. Structurally the `FitRect` of `canvas/fit-view`,
 *  restated here so this module stays free of anything that touches the DOM. */
export interface FitFrame {
  left: number
  top: number
  right: number
  bottom: number
}

/** The shift that brings a `size`-long span starting at `start` inside `[lo, hi]`, or 0 when it
 *  is already inside — or too long to fit, where any shift trades one clipped edge for the other. */
function shiftInto(start: number, size: number, lo: number, hi: number): number {
  if (size >= hi - lo) return 0
  if (start < lo) return lo - start
  if (start + size > hi) return hi - (start + size)
  return 0
}

/**
 * `viewportForRect`, then the SMALLEST nudge that keeps the node clear of the floating chrome.
 *
 * "Go to node" means putting the node in front of the user, and the middle of the screen is where
 * that is: a node centred in the chrome-free rectangle instead reads as off to one side on a wide
 * display (the free rect is whatever the dock and the sidebar leave over, not the eye's centre) and
 * as half off-screen on a small one. So the centred answer stands, and the frame only pulls it back
 * when it would otherwise slide under a panel — usually the sessions sidebar the click came from.
 * A node too large to fit the frame is left centred: any shift there only swaps which edge is
 * covered. `frame` null (nothing sensible to solve) ⇒ the plain centred answer.
 */
export function viewportForRectClearOf(
  rect: Rect,
  containerWidth: number,
  containerHeight: number,
  frame: FitFrame | null,
  zoom?: number
): Viewport | null {
  const centred = viewportForRect(rect, containerWidth, containerHeight, zoom)
  if (!centred || !frame) return centred
  const width = rect.width * centred.zoom
  const height = rect.height * centred.zoom
  return {
    zoom: centred.zoom,
    x: centred.x + shiftInto(centred.x + rect.x * centred.zoom, width, frame.left, frame.right),
    y: centred.y + shiftInto(centred.y + rect.y * centred.zoom, height, frame.top, frame.bottom)
  }
}

/** Whether React Flow already knows this node's on-screen size — i.e. whether `fitView` will
 *  actually include it in its fit set. Takes the minimal shape so it reads either a user-land
 *  node or React Flow's own internal node (the authoritative one; see Canvas.goToNode). */
export function isMeasured(
  node: { measured?: { width?: number | null; height?: number | null } } | null | undefined
): boolean {
  return !!(numeric(node?.measured?.width) && numeric(node?.measured?.height))
}
