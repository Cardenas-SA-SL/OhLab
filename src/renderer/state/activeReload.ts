// A seam so code OUTSIDE Canvas can ask for the same in-place reload of the ACTIVE project that an
// external file change gets (`reloadActiveProject`: camera preserved, nodes re-read from the store).
// Same shape as `workspaceDirty.ts`. The mutual auto-connect controller uses it when a member's
// relay tab reconnects while it is the tab on screen: the host's fresh workspace has replaced the
// store's nodes, and React Flow still shows what the tab held when the socket dropped. A bare
// `requestReload()` would re-apply the HOST's saved viewport and teleport the user; Canvas's own
// reload is the one that keeps the camera. No-op when nothing is registered (no canvas mounted =
// nothing on screen to refresh; the store already holds the right nodes).

let cb: (() => void) | null = null

export function registerActiveReload(fn: () => void): () => void {
  cb = fn
  return () => {
    if (cb === fn) cb = null
  }
}

export function requestActiveReload(): void {
  cb?.()
}
