const ESC = '\x1b'

/**
 * Scans a raw PTY output chunk for OSC 9 (iTerm2/Growl) and OSC 777 (notify-send style)
 * notification escape sequences. These are commonly emitted by shell wrappers / tools to
 * signal "needs attention" and are used here as one of two parallel status-detection paths
 * (the other being the Claude Code hooks HTTP endpoint).
 *
 * OSC 9   : ESC ] 9 ; <message> BEL
 * OSC 777 : ESC ] 777 ; notify ; <title> ; <body> (BEL | ESC \\)
 */
export const TERMINAL_TITLE_MAX_LENGTH = 80

/**
 * Extracts the last window-title from OSC 0 / 1 / 2 sequences in a chunk
 * (xterm standard: ESC ] 0|1|2 ; <title> (BEL | ESC \), also emitted by
 * PowerShell's $Host.UI.RawUI.WindowTitle and shells' precmd/title hooks).
 * Returns null when no usable title is present. Sanitized + capped so a rogue
 * agent can't blow up the pane header.
 */
export function extractTerminalTitle(chunk: string): string | null {
  if (!chunk.includes(`${ESC}]`)) return null
  const titleRegex = /\x1b\][012];([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
  let match: RegExpExecArray | null
  let last: string | null = null
  while ((match = titleRegex.exec(chunk)) !== null) {
    const cleaned = (match[1] ?? '').replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned.length > 0) last = cleaned
  }
  if (!last) return null
  // ponytail: hard cap, agent-controlled string in a fixed-width header
  return last.length > TERMINAL_TITLE_MAX_LENGTH ? `${last.slice(0, TERMINAL_TITLE_MAX_LENGTH - 1)}...` : last
}

export function containsAttentionOsc(chunk: string): boolean {
  if (!chunk.includes(`${ESC}]`)) return false

  const oscRegex = /\x1b\](\d+);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
  let match: RegExpExecArray | null
  while ((match = oscRegex.exec(chunk)) !== null) {
    const code = match[1]
    const body = match[2] ?? ''
    if (code === '9') return true
    if (code === '777' && body.toLowerCase().startsWith('notify')) return true
  }
  return false
}
