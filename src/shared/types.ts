export type TerminalStatus = 'idle' | 'working' | 'waiting'

export interface Terminal {
  id: string
  name: string
  projectPath: string
  startCommand: string
  order: number
}

export interface Workspace {
  id: string
  name: string
  projectPath: string
  order: number
  terminals: Terminal[]
}

export interface TerminalRuntimeState {
  status: TerminalStatus
  unreadCount: number
  ptyStarted: boolean
}

export type AppTheme = 'dark' | 'light' | 'dracula' | 'nord' | 'solarized'

export interface AppSettings {
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }
  sidebarWidth: number
  sidebarCollapsed: boolean
  filePanelWidth: number
  activeWorkspaceId: string | null
  theme: AppTheme
  notificationsEnabled: boolean
  defaultStartCommand: string
  idleDebounceMs: number
  paneColFractions: number[]
  // Embedded memory vaults (Perseus fork wiring). Default-off: while false
  // no vault child is spawned and no DB/key file is created.
  memoryVaultEnabled: boolean
}

/** The subset of AppSettings worth offering to restore from someone else's export — pure
 * preferences, never window/layout/session state (bounds, active workspace, pane layout). */
export interface RestorableSettings {
  theme: AppTheme
  notificationsEnabled: boolean
  defaultStartCommand: string
  idleDebounceMs: number
}

export interface PersistedState {
  workspaces: Workspace[]
  settings: AppSettings
}

export interface CreateWorkspaceInput {
  name: string
  projectPath: string
}

export interface CreateTerminalInput {
  workspaceId: string
  name: string
  projectPath?: string
  startCommand?: string
}

export interface HookEventPayload {
  hookEventName: 'Notification' | 'Stop' | 'SubagentStop' | string
  projectPath: string
  message?: string
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export type ListDirResult =
  | { ok: true; entries: FileEntry[] }
  | { ok: false; message: string }

export type ReadFileResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: 'binary' | 'error'; message?: string }

export const HOOK_SERVER_PORT = 47823

export const IPC = {
  workspacesGet: 'workspaces:get',
  workspaceCreate: 'workspace:create',
  workspaceRestore: 'workspace:restore',
  workspaceRename: 'workspace:rename',
  workspaceDelete: 'workspace:delete',
  workspaceReorder: 'workspace:reorder',
  workspacesExport: 'workspaces:export',
  workspacesImportPrepare: 'workspaces:importPrepare',
  workspacesImportCommit: 'workspaces:importCommit',

  terminalCreate: 'terminal:create',
  terminalRestore: 'terminal:restore',
  terminalRename: 'terminal:rename',
  terminalDelete: 'terminal:delete',
  terminalReorder: 'terminal:reorder',
  terminalRestart: 'terminal:restart',
  terminalPickFolder: 'terminal:pickFolder',
  terminalMarkRead: 'terminal:markRead',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  fsListDir: 'fs:listDir',
  fsReadFile: 'fs:readFile',
  previewOpen: 'preview:open',

  ptyStart: 'pty:start',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  statusChanged: 'status:changed',
  gitBranchChanged: 'git:branchChanged',
  terminalTitleChanged: 'terminal:titleChanged',

  hookServerInfo: 'hooks:getServerInfo',
  hookEventReceived: 'hooks:eventReceived',
  terminalFocusRequest: 'terminal:focusRequest',
  openSettingsRequest: 'app:openSettingsRequest',

  showNotification: 'notification:show',

  memoryStatus: 'memory:status',
  memorySearch: 'memory:search',
  memoryEntity: 'memory:entity',
  memoryHistory: 'memory:history',
  memoryBrowse: 'memory:browse',
  memoryReviewList: 'memory:reviewList',
  memoryReviewDecide: 'memory:reviewDecide',
  memoryPromoteDryRun: 'memory:promoteDryRun',
  memoryShadowRuns: 'memory:shadowRuns',

  appGetVersion: 'app:getVersion',
  appCheckForUpdates: 'app:checkForUpdates',
  appInstallUpdate: 'app:installUpdate',
  appUpdateStatus: 'app:updateStatus'
} as const

// Phase-4 Memory-Screen DTOs. Search/entity/history envelopes are opaque
// broker JSON (rendered tolerantly); review rows mirror ReviewRecord.
export interface MemoryStatus {
  enabled: boolean
  ready: boolean
}

export interface MemoryReviewRow {
  id: number
  db: string
  category: string
  key: string
  content: string
  futureUse: string
  triggers: string[]
  sourceRef: string
  verdictDecision: string
  statusState: string
  revision: number
  createdAt: number
  decidedAt: number | null
}

export interface MemoryReviewList {
  queued: MemoryReviewRow[]
  counts: Record<string, number>
}

export interface MemoryDecideInput {
  id: number
  approved: boolean
  expectedRevision: number
  by?: string
  reason?: string
}

// Browse-first listing: exactly one explicitly selected DB ('workspace' =
// active workspace, 'global' = shared DB). Browse pages/cursors mirror
// the scan backend; unknown totals arrive as null (rendered as '–').
export interface MemoryBrowseInput {
  db: 'workspace' | 'global'
  category?: string
  limit?: number
  cursor?: string
}

export interface MemoryPromotePreview {
  dryRun: true
  targetDb: string
  category: string
  key: string
  content: string
  triggers: string[]
  sourceRef: string
  note: string
}

export interface MemoryShadowRun {
  id: number
  createdAt: number
  workspaceId: string
  hookEvent: string
  recallHits: number
  notesTotal: number
  notesAccepted: number
  receipt: unknown
}

export interface ImportPreviewEntry {
  name: string
  projectPath: string
  terminals: Array<{ name: string; projectPath: string; startCommand: string }>
}

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string }

export type ImportPrepareResult =
  | { ok: true; entries: ImportPreviewEntry[]; settings: RestorableSettings | null }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string }

export type ImportCommitResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'error'; message: string }

export interface ImportCommitInput {
  entries: ImportPreviewEntry[]
  settings: RestorableSettings | null
}

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; message: string }
