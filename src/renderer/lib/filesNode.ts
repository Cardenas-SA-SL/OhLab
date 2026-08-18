/**
 * The decisions a file-manager node makes, kept pure so they can be pressed in a test rather than
 * clicked in the app: which directory "up" is, what the breadcrumb shows, what a filter matches,
 * and what happens when you open a thing.
 *
 * Paths are `/`-separated absolutes throughout, remote ones included — the node talks to an
 * `FsApi`, which is the same shape for the local filesystem, an SSH project's host over the
 * ControlMaster, and a relay peer's core.
 */
import { isVideoFile } from '../state/workspace'
import { opensInEditor } from './openTarget'

export { parentDir } from './explorerCreate'

/** One breadcrumb: what to show, and where clicking it goes. */
export interface Crumb {
  name: string
  path: string
}

/**
 * A node header is a few hundred pixels wide and a real project path is not. `max` is the number
 * of TRAILING segments kept; anything deeper is collapsed into a single leading crumb that still
 * navigates (to the last dropped directory), because a breadcrumb you cannot click is just text.
 * Root is always reachable as the first crumb for the same reason.
 */
export function breadcrumbs(path: string, max = 3): Crumb[] {
  const segs = path.split('/').filter(Boolean)
  const all: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    all.push({ name: s, path: acc })
  }
  if (all.length <= max + 1) return all
  // Keep root, then an ellipsis crumb that navigates to the deepest hidden directory, then the
  // tail. `max + 1` accounts for root, which is never dropped.
  const hidden = all.slice(1, all.length - max)
  const ellipsis: Crumb = { name: '…', path: hidden[hidden.length - 1].path }
  return [all[0], ellipsis, ...all.slice(all.length - max)]
}

/** The node's title: the directory's own name, or '/' at the root. */
export function folderTitle(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '/'
}

/** Join a directory and an entry name. Trailing slashes on the dir are absorbed, so the root
 *  ('/') does not produce a doubled separator. */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/**
 * Filter listed entries by a substring, case-insensitively. An empty or whitespace-only query
 * matches everything — a filter box that silently hides the whole listing when the user selects
 * and deletes their text is the bug this guards.
 */
export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

/**
 * What opening a FILE should do.
 *
 *  `canvas` — open it as a node on the canvas (an editor for text and images, a video player for
 *             media). This is what the canvas `nodeterm:open-file` listener already does.
 *  `os`     — hand it to the operating system's default application, for the things Monaco can
 *             only render as garbage: archives, installers, databases, binaries.
 *
 * `remote` (an SSH project, or a relay tab) forces `canvas`, and that is not a limitation dressed
 * up as a choice: `shell.openPath` opens a path on THIS machine, so handing it a path that exists
 * on another one either fails silently or — worse, if the path happens to exist here too — opens
 * a completely unrelated local file. The same rule Canvas's own `openProjectFile` follows.
 */
export function fileOpenTarget(path: string, opts: { remote?: boolean } = {}): 'canvas' | 'os' {
  if (opts.remote) return 'canvas'
  if (isVideoFile(path)) return 'canvas'
  return opensInEditor(path) ? 'canvas' : 'os'
}
