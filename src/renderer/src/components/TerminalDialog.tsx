import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'

interface Props {
  workspaceId: string
  onClose: () => void
}

export default function TerminalDialog({ workspaceId, onClose }: Props): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const defaultStartCommand = useAppStore((s) => s.settings.defaultStartCommand)
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [name, setName] = useState('')
  const [startCommand, setStartCommand] = useState(defaultStartCommand)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    if (!workspace) {
      setError('Could not add terminal - the workspace may have been deleted.')
      return
    }
    const terminal = await window.api.createTerminal({
      workspaceId,
      name: name.trim() || 'Terminal',
      projectPath: workspace.projectPath,
      startCommand: startCommand.trim() || defaultStartCommand
    })
    if (!terminal) {
      setError('Could not add terminal - the workspace may have been deleted.')
      return
    }
    addTerminal(workspaceId, terminal)
    openWorkspace(workspaceId)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New terminal</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frontend" />
        </label>
        <p className="modal-hint">Folder: {workspace ? workspace.projectPath : '-'} (from workspace)</p>
        <label>
          Start command
          <input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="claude" />
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void handleCreate()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
