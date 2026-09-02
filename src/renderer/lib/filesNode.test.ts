import { describe, expect, it } from 'vitest'
import {
  breadcrumbs,
  childPath,
  classifyEmptyListing,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  parentDir
} from './filesNode'

describe('breadcrumbs', () => {
  it('walks a shallow path in full', () => {
    expect(breadcrumbs('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' }
    ])
  })

  it('is just root at the root', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('collapses a deep path but keeps every crumb navigable', () => {
    const crumbs = breadcrumbs('/one/two/three/four/five/six', 3)
    expect(crumbs.map((c) => c.name)).toEqual(['/', '…', 'four', 'five', 'six'])
    // The ellipsis is not decoration: it goes to the deepest directory it hid, so a user can
    // climb back out one level at a time instead of being teleported to root.
    expect(crumbs[1].path).toBe('/one/two/three')
    expect(crumbs[crumbs.length - 1].path).toBe('/one/two/three/four/five/six')
  })

  it('does not collapse a path that exactly fits', () => {
    expect(breadcrumbs('/a/b/c', 3).map((c) => c.name)).toEqual(['/', 'a', 'b', 'c'])
  })
})

describe('folderTitle', () => {
  it('names the directory', () => expect(folderTitle('/home/me/repo')).toBe('repo'))
  it('names the root', () => expect(folderTitle('/')).toBe('/'))
  it('ignores a trailing slash', () => expect(folderTitle('/home/me/repo/')).toBe('repo'))
})

describe('childPath', () => {
  it('joins normally', () => expect(childPath('/a/b', 'c.ts')).toBe('/a/b/c.ts'))
  it('does not double the separator at the root', () => expect(childPath('/', 'etc')).toBe('/etc'))
  it('absorbs a trailing slash', () => expect(childPath('/a/', 'b')).toBe('/a/b'))
})

describe('parentDir', () => {
  it('climbs one level', () => expect(parentDir('/a/b/c')).toBe('/a/b'))
  it('stops at the root', () => expect(parentDir('/a')).toBe('/'))
  it('stays at the root', () => expect(parentDir('/')).toBe('/'))
})

describe('filterEntries', () => {
  const entries = [{ name: 'README.md' }, { name: 'src' }, { name: 'package.json' }]

  it('matches case-insensitively anywhere in the name', () => {
    expect(filterEntries(entries, 'age').map((e) => e.name)).toEqual(['package.json'])
    expect(filterEntries(entries, 'readme').map((e) => e.name)).toEqual(['README.md'])
  })

  // The bug this pins: select-all + delete leaves '' (or a stray space), and a filter that treats
  // that as "match nothing" blanks the whole listing with no way to tell why.
  it('matches everything for an empty or whitespace query', () => {
    expect(filterEntries(entries, '')).toEqual(entries)
    expect(filterEntries(entries, '   ')).toEqual(entries)
  })

  it('can legitimately match nothing', () => {
    expect(filterEntries(entries, 'zzz')).toEqual([])
  })
})

describe('fileOpenTarget', () => {
  it('opens text and images on the canvas', () => {
    expect(fileOpenTarget('/a/notes.md')).toBe('canvas')
    expect(fileOpenTarget('/a/logo.png')).toBe('canvas')
    expect(fileOpenTarget('/a/Makefile')).toBe('canvas')
  })

  it('opens video on the canvas (the video node, not Monaco)', () => {
    expect(fileOpenTarget('/a/clip.mp4')).toBe('canvas')
    expect(fileOpenTarget('/a/clip.mov')).toBe('canvas')
  })

  it('hands binaries and archives to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg')).toBe('os')
    expect(fileOpenTarget('/a/bundle.zip')).toBe('os')
    expect(fileOpenTarget('/a/data.sqlite')).toBe('os')
  })

  // shell.openPath opens a path on THIS machine. For a remote listing that is either a silent
  // no-op or, if the path happens to exist locally too, an unrelated local file.
  it('never hands a remote path to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/bundle.zip', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/notes.md', { remote: true })).toBe('canvas')
  })
})

describe('classifyEmptyListing', () => {
  const parent = [{ name: 'docs' }, { name: 'src' }, { name: 'README.md' }]

  // The case the fourth empty state exists for, and could not reach before: a removed worktree.
  // `listDir` answers [] for a directory that is gone, exactly as it does for an empty one.
  it('says missing when the parent lists real entries and ours is not among them', () => {
    expect(classifyEmptyListing('/repo/gone', parent)).toBe('missing')
  })

  it('says empty when the parent lists us — the folder is there and simply has nothing in it', () => {
    expect(classifyEmptyListing('/repo/docs', parent)).toBe('empty')
    expect(classifyEmptyListing('/repo/docs/', parent)).toBe('empty')
  })

  // "A failed read is never evidence of absence" (SshFs.readTextChecked). Under the same
  // fail-open contract an empty PARENT means unreadable-or-gone, not childless — so we learned
  // nothing and must not tell the user their folder was deleted.
  it('says unknown when the parent itself came back empty', () => {
    expect(classifyEmptyListing('/repo/docs', [])).toBe('unknown')
  })

  it('says unknown when the parent could not be asked at all', () => {
    expect(classifyEmptyListing('/repo/docs', null)).toBe('unknown')
  })

  // Root has no parent to interrogate and always exists.
  it('says empty at the root rather than interrogating a parent that does not exist', () => {
    expect(classifyEmptyListing('/', null)).toBe('empty')
    expect(classifyEmptyListing('/', [])).toBe('empty')
  })

  // A symlinked directory can list as a non-dir entry depending on the leg; matching on `dir`
  // would call it missing. Name matching is what keeps that false alarm out.
  it('matches by name, not by entry kind', () => {
    // Real callers pass `DirEntry[]`; a symlinked directory can arrive with `dir: false`.
    const listed: { name: string; dir: boolean }[] = [{ name: 'link', dir: false }]
    expect(classifyEmptyListing('/repo/link', listed)).toBe('empty')
  })
})
