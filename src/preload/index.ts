import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  AppSettings,
  CreateTerminalInput,
  CreateWorkspaceInput,
  ExportResult,
  ImportCommitInput,
  ImportCommitResult,
  ImportPrepareResult,
  ListDirResult,
  MemoryBrowseInput,
  MemoryDecideInput,
  MemoryPromotePreview,
  MemoryPromoteResult,
  MemoryReviewList,
  MemoryShadowRun,
  MemoryStatus,
  ReadFileResult,
  Terminal,
  TerminalRuntimeState,
  UpdateStatus,
  Workspace
} from '../shared/types'

export interface WorkspacesGetResult {
  workspaces: Workspace[]
  settings: AppSettings
  runtime: Record<string, TerminalRuntimeState>
}

const api = {
  getWorkspaces: (): Promise<WorkspacesGetResult> => ipcRenderer.invoke(IPC.workspacesGet),
  createWorkspace: (input: CreateWorkspaceInput): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.workspaceCreate, input),
  renameWorkspace: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.workspaceRename, id, name),
  deleteWorkspace: (id: string): Promise<void> => ipcRenderer.invoke(IPC.workspaceDelete, id),
  restoreWorkspace: (snapshot: Workspace): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.workspaceRestore, snapshot),
  reorderWorkspaces: (orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.workspaceReorder, orderedIds),
  exportWorkspaces: (): Promise<ExportResult> => ipcRenderer.invoke(IPC.workspacesExport),
  prepareImportWorkspaces: (): Promise<ImportPrepareResult> => ipcRenderer.invoke(IPC.workspacesImportPrepare),
  commitImportWorkspaces: (input: ImportCommitInput): Promise<ImportCommitResult> =>
    ipcRenderer.invoke(IPC.workspacesImportCommit, input),

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.terminalPickFolder),
  createTerminal: (input: CreateTerminalInput): Promise<Terminal | null> =>
    ipcRenderer.invoke(IPC.terminalCreate, input),
  renameTerminal: (id: string, name: string): Promise<void> => ipcRenderer.invoke(IPC.terminalRename, id, name),
  deleteTerminal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.terminalDelete, id),
  restoreTerminal: (workspaceId: string, snapshot: Terminal): Promise<Terminal> =>
    ipcRenderer.invoke(IPC.terminalRestore, workspaceId, snapshot),
  reorderTerminals: (workspaceId: string, orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalReorder, workspaceId, orderedIds),
  restartTerminal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.terminalRestart, id),
  markTerminalRead: (id: string): Promise<void> => ipcRenderer.invoke(IPC.terminalMarkRead, id),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch),

  getHookServerInfo: (): Promise<{ port: number }> => ipcRenderer.invoke(IPC.hookServerInfo),

  // File.path was removed in Electron 32; only the preload can resolve a File back to a
  // real filesystem path (drag-drop and clipboard file paste both need this).
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  listDir: (path: string): Promise<ListDirResult> => ipcRenderer.invoke(IPC.fsListDir, path),
  readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke(IPC.fsReadFile, path),
  openFilePreviewWindow: (path: string): Promise<void> => ipcRenderer.invoke(IPC.previewOpen, path),

  ptyStart: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.ptyStart, id, cols, rows),
  ptyInput: (id: string, data: string): void => ipcRenderer.send(IPC.ptyInput, id, data),
  ptyResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.ptyResize, id, cols, rows),

  onPtyData: (callback: (id: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }): void =>
      callback(payload.id, payload.data)
    ipcRenderer.on(IPC.ptyData, listener)
    return () => ipcRenderer.removeListener(IPC.ptyData, listener)
  },
  onPtyExit: (callback: (id: string, exitCode: number) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; exitCode: number }
    ): void => callback(payload.id, payload.exitCode)
    ipcRenderer.on(IPC.ptyExit, listener)
    return () => ipcRenderer.removeListener(IPC.ptyExit, listener)
  },
  onStatusChanged: (
    callback: (id: string, status: string, unreadCount: number) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; status: string; unreadCount: number }
    ): void => callback(payload.id, payload.status, payload.unreadCount)
    ipcRenderer.on(IPC.statusChanged, listener)
    return () => ipcRenderer.removeListener(IPC.statusChanged, listener)
  },
  onGitBranchChanged: (callback: (id: string, branch: string | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; branch: string | null }
    ): void => callback(payload.id, payload.branch)
    ipcRenderer.on(IPC.gitBranchChanged, listener)
    return () => ipcRenderer.removeListener(IPC.gitBranchChanged, listener)
  },
  onTerminalTitleChanged: (callback: (id: string, title: string) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; title: string }
    ): void => callback(payload.id, payload.title)
    ipcRenderer.on(IPC.terminalTitleChanged, listener)
    return () => ipcRenderer.removeListener(IPC.terminalTitleChanged, listener)
  },
  onTerminalFocusRequest: (callback: (id: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string): void => callback(id)
    ipcRenderer.on(IPC.terminalFocusRequest, listener)
    return () => ipcRenderer.removeListener(IPC.terminalFocusRequest, listener)
  },
  onOpenSettingsRequest: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.openSettingsRequest, listener)
    return () => ipcRenderer.removeListener(IPC.openSettingsRequest, listener)
  },
  onHookEvent: (callback: (hookEventName: string, receivedAt: number) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { hookEventName: string; receivedAt: number }
    ): void => callback(payload.hookEventName, payload.receivedAt)
    ipcRenderer.on(IPC.hookEventReceived, listener)
    return () => ipcRenderer.removeListener(IPC.hookEventReceived, listener)
  },

  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appGetVersion),

  // Phase-4 Memory-Screen (default-off via memoryVaultEnabled; main fails
  // closed while disabled — no child, no file). Reads + review queue only;
  // vault promotion exists solely as a dry-run preview.
  memoryStatus: (): Promise<MemoryStatus> => ipcRenderer.invoke(IPC.memoryStatus),
  memorySearch: (workspaceId: string, query: string, limit?: number, scope?: string[]): Promise<unknown> =>
    ipcRenderer.invoke(IPC.memorySearch, workspaceId, query, limit, scope),
  memoryEntity: (workspaceId: string, db: string, id: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.memoryEntity, workspaceId, db, id),
  memoryHistory: (workspaceId: string, db: string, category: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.memoryHistory, workspaceId, db, category, key),
  memoryBrowse: (workspaceId: string, input: MemoryBrowseInput): Promise<unknown> =>
    ipcRenderer.invoke(IPC.memoryBrowse, workspaceId, input),
  memoryReviewList: (): Promise<MemoryReviewList> => ipcRenderer.invoke(IPC.memoryReviewList),
  memoryReviewDecide: (input: MemoryDecideInput): Promise<unknown> =>
    ipcRenderer.invoke(IPC.memoryReviewDecide, input),
  memoryPromoteDryRun: (id: number): Promise<MemoryPromotePreview> =>
    ipcRenderer.invoke(IPC.memoryPromoteDryRun, id),
  memoryPromote: (id: number, expectedRevision: number): Promise<MemoryPromoteResult> =>
    ipcRenderer.invoke(IPC.memoryPromote, id, expectedRevision),
  memoryShadowRuns: (limit?: number): Promise<MemoryShadowRun[]> =>
    ipcRenderer.invoke(IPC.memoryShadowRuns, limit),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.appCheckForUpdates),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.appInstallUpdate),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status)
    ipcRenderer.on(IPC.appUpdateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.appUpdateStatus, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
