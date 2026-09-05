import { useEffect } from 'react'

interface Props {
  x: number
  y: number
  onNewTerminal: () => void
  onCloseTerminal: () => void
  onClose: () => void
}

export default function PaneContextMenu({ x, y, onNewTerminal, onCloseTerminal, onClose }: Props): React.JSX.Element {
  useEffect(() => {
    function handleClick(): void {
      onClose()
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 190)
  const top = Math.min(y, window.innerHeight - 110)

  return (
    <div className="pane-context-menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => {
          onNewTerminal()
          onClose()
        }}
      >
        + New terminal
      </button>
      <button
        className="danger"
        onClick={() => {
          onCloseTerminal()
          onClose()
        }}
      >
        Delete terminal
      </button>
    </div>
  )
}
