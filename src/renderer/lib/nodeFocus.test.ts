import { describe, it, expect } from 'vitest'
import { getViewportForBounds } from '@xyflow/system'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMeasured,
  nodeFitRect,
  viewportForRect,
  viewportForRectClearOf
} from './nodeFocus'
import type { FocusableNode } from './nodeFocus'

const term = (over: Partial<FocusableNode> = {}): FocusableNode => ({
  id: 'n1',
  position: { x: 4000, y: 3000 },
  width: 600,
  height: 400,
  ...over
})

describe('absolutePosition', () => {
  it('returns the position of a top-level node unchanged', () => {
    expect(absolutePosition(term(), [term()])).toEqual({ x: 4000, y: 3000 })
  })

  it('adds the group origin for a child (what node PLACEMENT needs)', () => {
    // The regression this guards: Duplicate / Branch / Transfer positioned the new node from the
    // source's raw `position`, which for a grouped node is relative to its frame — so a copy made
    // top-level landed the group's own x/y away from the node it came from.
    const group: FocusableNode = { id: 'g', position: { x: 5000, y: 200 } }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(absolutePosition(child, [group, child])).toEqual({ x: 5050, y: 260 })
  })

  it('answers even when the node has no size at all', () => {
    const n: FocusableNode = { id: 'x', position: { x: 12, y: 34 } }
    expect(absolutePosition(n, [n])).toEqual({ x: 12, y: 34 })
    expect(nodeFitRect(n, [n])).toBeNull()
  })

  it('stops on a parent cycle instead of looping', () => {
    const a: FocusableNode = { id: 'a', position: { x: 10, y: 10 }, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 20, y: 20 }, parentId: 'a' }
    expect(absolutePosition(a, [a, b])).toEqual({ x: 30, y: 30 })
  })
})

describe('nodeFitRect', () => {
  it('reads the persisted size of a node React Flow has not measured yet', () => {
    // The regression this guards: a node loaded a tick ago has NO `measured` — and React
    // Flow's own fitView drops such nodes, collapsing its bounds to the canvas origin.
    expect(nodeFitRect(term(), [term()])).toEqual({ x: 4000, y: 3000, width: 600, height: 400 })
  })

  it('prefers the measured size once React Flow has one (a live-resized terminal)', () => {
    const n = term({ measured: { width: 640, height: 512 } })
    expect(nodeFitRect(n, [n])).toEqual({ x: 4000, y: 3000, width: 640, height: 512 })
  })

  it('resolves a grouped node to its ABSOLUTE position', () => {
    const group: FocusableNode = {
      id: 'g',
      position: { x: 5000, y: 200 },
      width: 1400,
      height: 900
    }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(nodeFitRect(child, [group, child])).toEqual({
      x: 5050,
      y: 260,
      width: 600,
      height: 400
    })
  })

  it('resolves a nested group chain', () => {
    const outer: FocusableNode = { id: 'o', position: { x: 1000, y: 1000 }, width: 100, height: 100 }
    const inner: FocusableNode = {
      id: 'i',
      position: { x: 100, y: 200 },
      width: 100,
      height: 100,
      parentId: 'o'
    }
    const child = term({ id: 'c', position: { x: 10, y: 20 }, parentId: 'i' })
    expect(nodeFitRect(child, [outer, inner, child])).toMatchObject({ x: 1110, y: 1220 })
  })

  it('survives a broken parent chain (missing parent, self-parent, cycle)', () => {
    const orphan = term({ parentId: 'gone' })
    expect(nodeFitRect(orphan, [orphan])).toMatchObject({ x: 4000, y: 3000 })

    const selfish = term({ id: 's', parentId: 's' })
    expect(nodeFitRect(selfish, [selfish])).toMatchObject({ x: 4000, y: 3000 })

    const a: FocusableNode = { id: 'a', position: { x: 1, y: 1 }, width: 10, height: 10, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 2, y: 2 }, width: 10, height: 10, parentId: 'a' }
    expect(nodeFitRect(a, [a, b])).not.toBeNull()
  })

  it('falls back to the style size, then gives up rather than guessing', () => {
    const styled: FocusableNode = {
      id: 'n',
      position: { x: 10, y: 20 },
      style: { width: 300, height: 150 }
    }
    expect(nodeFitRect(styled, [styled])).toEqual({ x: 10, y: 20, width: 300, height: 150 })

    const sizeless: FocusableNode = { id: 'n', position: { x: 10, y: 20 } }
    expect(nodeFitRect(sizeless, [sizeless])).toBeNull()
    // A zero-size node would produce the very origin jump we are fixing.
    expect(nodeFitRect({ id: 'n', position: { x: 5, y: 5 }, width: 0, height: 0 }, [])).toBeNull()
  })
})

describe('viewportForRect', () => {
  it('centres the node in the container instead of the canvas origin', () => {
    const vp = viewportForRect({ x: 4000, y: 3000, width: 600, height: 400 }, 1280, 900)
    // Same maths React Flow's fitView would have used for a MEASURED node.
    expect(vp).toEqual(
      getViewportForBounds(
        { x: 4000, y: 3000, width: 600, height: 400 },
        1280,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        FIT_NODE_OPTIONS.padding
      )
    )
    // The node's centre lands in the middle of the container…
    expect(vp!.x + 4300 * vp!.zoom).toBeCloseTo(640, 0)
    expect(vp!.y + 3200 * vp!.zoom).toBeCloseTo(450, 0)
    // …which is emphatically NOT where an empty fit-set puts it (the bug: 640/450 at maxZoom,
    // i.e. the canvas origin parked in the middle of the screen).
    expect(vp!.x).not.toBeCloseTo(640, 0)
  })

  it('clamps the zoom for tiny and huge nodes', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 20, height: 20 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.maxZoom
    )
    expect(viewportForRect({ x: 0, y: 0, width: 40000, height: 40000 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.minZoom
    )
  })

  it('refuses to compute against a container it cannot size', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 600, height: 400 }, 0, 0)).toBeNull()
  })
})

describe('viewportForRectClearOf', () => {
  const rect = { x: 5000, y: 4000, width: 600, height: 400 }
  // A sessions sidebar on the left, as the free-rect solver reports it: pane-local coordinates.
  const sidebar = (left: number, paneW: number, paneH: number) => ({
    left,
    top: 12,
    right: paneW - 12,
    bottom: paneH - 12
  })

  it('centres the node in the SCREEN, not in the chrome-free rectangle', () => {
    // The regression this pins: framing a node in the middle of the free rect reads as "too far
    // right" on a wide display — the free rect is whatever the dock and the sidebar leave over,
    // which is not where the eye looks. On an ultrawide the centred node clears the chrome by
    // itself, so the answer must be the plain centred one.
    const vp = viewportForRectClearOf(rect, 3440, 1400, sidebar(352, 3440, 1400))!
    expect(vp).toEqual(viewportForRect(rect, 3440, 1400))
    expect(vp.x + 5300 * vp.zoom).toBeCloseTo(1720, 0)
    expect(vp.y + 4200 * vp.zoom).toBeCloseTo(700, 0)
  })

  it('nudges just enough to clear a panel the centred node would slide under', () => {
    const frame = sidebar(500, 1440, 900)
    const vp = viewportForRectClearOf(rect, 1440, 900, frame)!
    const centred = viewportForRect(rect, 1440, 900)!
    // Flush against the panel — moved, and no further than it had to be.
    expect(vp.x + rect.x * vp.zoom).toBeCloseTo(frame.left, 0)
    expect(vp.x).toBeGreaterThan(centred.x)
    // The zoom and the other axis are untouched: this is a nudge, not a second framing.
    expect(vp.zoom).toBe(centred.zoom)
    expect(vp.y).toBe(centred.y)
  })

  it('leaves a node too large for the frame centred — a shift only swaps the covered edge', () => {
    const vp = viewportForRectClearOf(rect, 1440, 900, { left: 600, top: 12, right: 900, bottom: 888 })
    expect(vp).toEqual(viewportForRect(rect, 1440, 900))
  })

  it('keeps a given zoom and only pans (settings.focusZoomToNode off)', () => {
    // The point of the option: a user who settled on a zoom level loses their sense of place when
    // a jump also rescales the canvas. The node is still centred, and still nudged clear of chrome.
    const vp = viewportForRectClearOf(rect, 1440, 900, sidebar(352, 1440, 900), 0.5)!
    expect(vp.zoom).toBe(0.5)
    expect(vp.x + 5300 * 0.5).toBeCloseTo(720, 0)
    expect(vp.y + 4200 * 0.5).toBeCloseTo(450, 0)
  })

  it('passes an out-of-framing-range zoom through — it is one the canvas already shows', () => {
    // Re-clamping to FIT_NODE_OPTIONS would rescale the very view this option exists to leave
    // alone; the canvas's own limits already bound what getZoom() can return.
    expect(viewportForRectClearOf(rect, 1440, 900, null, 1.9)!.zoom).toBe(1.9)
    expect(viewportForRectClearOf(rect, 1440, 900, null, 0.1)!.zoom).toBe(0.1)
    expect(viewportForRectClearOf(rect, 1440, 900, null, 0)).toBeNull()
  })

  it('is the plain centred answer when there is no frame to solve', () => {
    expect(viewportForRectClearOf(rect, 1440, 900, null)).toEqual(viewportForRect(rect, 1440, 900))
    expect(viewportForRectClearOf(rect, 0, 0, sidebar(352, 1440, 900))).toBeNull()
  })
})

describe('isMeasured', () => {
  it('reads React Flow measurements from either node shape, and tolerates a missing node', () => {
    expect(isMeasured({ measured: { width: 600, height: 400 } })).toBe(true)
    // A freshly deserialized node: sized, but not yet measured — fitView would DROP it.
    expect(isMeasured(term())).toBe(false)
    expect(isMeasured({ measured: { width: 600 } })).toBe(false)
    expect(isMeasured({ measured: { width: 0, height: 0 } })).toBe(false)
    expect(isMeasured(undefined)).toBe(false)
  })
})
