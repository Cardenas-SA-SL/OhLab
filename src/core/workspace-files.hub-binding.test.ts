import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { fileToProject, projectToFile, splitWorkspace } from './workspace-files'

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc', kind: 'terminal', position: { x: 0, y: 0 },
  size: { width: 400, height: 300 }, title: 't', color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node()], ...over
})

/**
 * The Hub binding is MACHINE-LOCAL (see IndexEntryV3.hubProjectId): it must ride the index entry
 * for every ref kind and never the shared project file — a repo carrying one would bind every
 * clone to somebody's team.
 */
describe('hubProjectId is machine-local', () => {
  it('rides the index entry for a folder ref, and is absent from the shared file', () => {
    const ws: Workspace = {
      version: 2, activeProjectId: 'p1',
      projects: [project({ cwd: '/repo', hubProjectId: 'hub-1' })]
    }
    const { index, files } = splitWorkspace(ws, () => 1, 'ts')
    expect(index.entries[0]).toMatchObject({ id: 'p1', cwd: '/repo', hubProjectId: 'hub-1' })
    const file = files.get('/repo')!
    expect(JSON.stringify(file)).not.toContain('hubProjectId')
  })

  it('rides the entry for an ssh ref (and never its cache) and for a local-data ref', () => {
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/r' } as Project['ssh']
    const ws: Workspace = {
      version: 2, activeProjectId: 'p1',
      projects: [
        project({ id: 'p1', ssh, hubProjectId: 'hub-1' }),
        project({ id: 'project-abc', hubProjectId: 'hub-2' })
      ]
    }
    const { index, dataFiles } = splitWorkspace(ws, () => 1, 'ts')
    expect(index.entries[0]).toMatchObject({ id: 'p1', hubProjectId: 'hub-1' })
    expect(JSON.stringify(index.entries[0].cache)).not.toContain('hubProjectId')
    expect(index.entries[1]).toMatchObject({ id: 'project-abc', hubProjectId: 'hub-2', dataFile: true })
    expect(JSON.stringify(dataFiles.get('project-abc'))).not.toContain('hubProjectId')
  })

  it('survives an unavailable placeholder', () => {
    const ws: Workspace = {
      version: 2, activeProjectId: 'p1',
      projects: [project({ cwd: '/gone', unavailable: true, nodes: [], hubProjectId: 'hub-1' })]
    }
    const { index } = splitWorkspace(ws, () => 1, 'ts')
    expect(index.entries[0]).toMatchObject({ cwd: '/gone', hubProjectId: 'hub-1' })
  })

  it('is read from the entry only — a file claiming a binding is ignored', () => {
    const f = { ...projectToFile(project(), 1, 'ts'), hubProjectId: 'forged' } as ReturnType<typeof projectToFile>
    expect(fileToProject(f, { id: 'p1' }).hubProjectId).toBeUndefined()
    expect(fileToProject(f, { id: 'p1', hubProjectId: 'hub-1' }).hubProjectId).toBe('hub-1')
  })
})
