import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'

interface Props {
  onClose: () => void
}

export default function WorkspaceDialog({ onClose }: Props): React.JSX.Element {
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const [name, setName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pickFolder(): Promise<void> {
    const folder = await window.api.pickFolder()
    if (!folder) return
    setProjectPath(folder)
    if (!name.trim()) {
      const parts = folder.split(/[\\/]/).filter(Boolean)
      setName(parts[parts.length - 1] ?? folder)
    }
  }

  async function handleCreate(): Promise<void> {
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    if (!projectPath.trim()) {
      setError('Project folder is required.')
      return
    }
    const workspace = await window.api.createWorkspace({ name: name.trim(), projectPath: projectPath.trim() })
    addWorkspace(workspace)
    openWorkspace(workspace.id)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            placeholder="e.g. Client A"
          />
        </label>
        <label>
          Project folder
          <div className="folder-row">
            <input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
              placeholder="C:\path\to\project"
            />
            <button onClick={() => void pickFolder()}>Browse...</button>
          </div>
        </label>
        <p className="modal-hint">
          Every terminal in this workspace starts in this folder. You only pick the folder once here.
        </p>
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void handleCreate()}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
