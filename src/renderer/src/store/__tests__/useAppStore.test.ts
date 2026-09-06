import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../useAppStore'
import type { Terminal, Workspace } from '../../../../shared/types'

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const T1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS,
    name: 'demo',
    projectPath: 'H:/demo',
    order: 0,
    terminals: [],
    ...over,
  }
}

function terminal(over: Partial<Terminal> = {}): Terminal {
  return {
    id: T1,
    name: 'pi-1',
    projectPath: 'H:/demo',
    startCommand: 'claude',
    order: 0,
    ...over,
  }
}

const api = {
  deleteWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  deleteTerminal: vi.fn(),
  restoreTerminal: vi.fn(),
  updateSettings: vi.fn(),
}

function install(): void {
  ;(globalThis as unknown as { window: unknown }).window = { api }
  useAppStore.setState({
    workspaces: [],
    trash: null,
    settings: useAppStore.getState().settings,
  })
  vi.clearAllMocks()
}

describe('useAppStore trash', () => {
  beforeEach(install)

  it('trashes a workspace and restores it with identical ids', async () => {
    const ws = workspace({ terminals: [terminal()] })
    useAppStore.setState({ workspaces: [ws] })
    api.restoreWorkspace.mockImplementation(async (snap: Workspace) => snap)
    const s = useAppStore.getState()
    s.trashWorkspace(WS)
    expect(useAppStore.getState().workspaces).toHaveLength(0)
    expect(api.deleteWorkspace).toHaveBeenCalledWith(WS)
    expect(useAppStore.getState().trash?.name).toBe('demo')
    expect(await useAppStore.getState().restoreTrash()).toBe(true)
    const back = useAppStore.getState().workspaces
    expect(back).toHaveLength(1)
    expect(back[0].id).toBe(WS)
    expect(back[0].terminals.map((t) => t.id)).toEqual([T1])
    expect(useAppStore.getState().trash).toBeNull()
  })

  it('trashes a terminal and restores it into its workspace', async () => {
    useAppStore.setState({ workspaces: [workspace({ terminals: [terminal()] })] })
    api.restoreTerminal.mockImplementation(async (_ws: string, snap: Terminal) => snap)
    const s = useAppStore.getState()
    s.trashTerminal(WS, T1)
    expect(useAppStore.getState().workspaces[0].terminals).toHaveLength(0)
    expect(api.deleteTerminal).toHaveBeenCalledWith(T1)
    expect(await useAppStore.getState().restoreTrash()).toBe(true)
    expect(useAppStore.getState().workspaces[0].terminals.map((t) => t.id)).toEqual([T1])
  })

  it('keeps the trash on backend refusal so retry stays possible', async () => {
    useAppStore.setState({ workspaces: [workspace()] })
    api.restoreWorkspace.mockRejectedValue(new Error('already exists'))
    const s = useAppStore.getState()
    s.trashWorkspace(WS)
    expect(await useAppStore.getState().restoreTrash()).toBe(false)
    expect(useAppStore.getState().trash?.kind).toBe('workspace')
  })

  it('dismiss clears without restoring', () => {
    useAppStore.setState({ workspaces: [workspace()] })
    const s = useAppStore.getState()
    s.trashWorkspace(WS)
    s.dismissTrash()
    expect(useAppStore.getState().trash).toBeNull()
    expect(useAppStore.getState().workspaces).toHaveLength(0)
    expect(api.restoreWorkspace).not.toHaveBeenCalled()
  })
})
