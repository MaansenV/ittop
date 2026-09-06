import { createConnection } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { McpBridgeServer } from '../mcpBridge'
import { SessionRegistry } from '../capabilities'
import type { MemoryBroker } from '../broker'

const WS = '11111111-1111-4111-8111-111111111111'

function stubBroker(): { broker: MemoryBroker; recalls: unknown[] } {
  const recalls: unknown[] = []
  const broker = {
    recall: async (_handle: string, query: unknown, opts: unknown) => {
      recalls.push({ query, opts })
      return { evaluatedAt: new Date().toISOString(), items: [{ key: 'k1', content: 'test content' }] }
    },
    getEntity: async (_handle: string, db: string, id: string) => {
      return { id, db, content: 'entity detail' }
    },
    history: async (_handle: string, _db: string, category: string, key: string) => {
      return { versions: [{ category, key, v: 1 }] }
    },
  } as unknown as MemoryBroker
  return { broker, recalls }
}

async function authAndRoundtrip(
  socketPath: string,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      if (token) {
        client.write(JSON.stringify({ jsonrpc: '2.0', id: '__auth__', method: 'ittop/auth', params: { token } }) + '\n')
      } else {
        client.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }
    })
    let buffer = ''
    client.on('data', (d) => {
      buffer += d.toString('utf8')
      while (true) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.id === '__auth__') {
            if (parsed.error) {
              client.end()
              resolve(parsed)
              return
            }
            client.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
            continue
          }
          client.end()
          resolve(parsed)
          return
        } catch (e) {
          reject(e)
        }
      }
    })
    client.on('error', reject)
  })
}

async function contentLengthRoundtrip(
  socketPath: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ jsonrpc: '2.0', id: '__auth__', method: 'ittop/auth', params: { token } }) + '\n')
    })
    let buffer = ''
    client.on('data', (d) => {
      buffer += d.toString('utf8')
      while (true) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.id === '__auth__') {
            if (parsed.error) {
              client.end()
              resolve(parsed)
              return
            }
            const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
            const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
            client.write(Buffer.concat([header, body]))
            continue
          }
          client.end()
          resolve(parsed)
          return
        } catch (e) {
          reject(e)
        }
      }
    })
    client.on('error', reject)
  })
}

describe('McpBridgeServer (Phase 7c)', () => {
  let bridge: McpBridgeServer | null = null

  afterEach(async () => {
    if (bridge) {
      await bridge.close()
      bridge = null
    }
  })

  it('rejects unauthenticated requests before handshake', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    // No token sent
    const res = await authAndRoundtrip(socketPath, null, 'tools/list')
    expect(res.error).toBeDefined()
    expect((res.error as { code?: number }).code).toBe(-32002)
    expect((res.error as { message?: string }).message).toContain('unauthorized')
  })

  it('rejects handshake with forged token', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    const res = await authAndRoundtrip(socketPath, 'sess_forged_token', 'tools/list')
    expect(res.error).toBeDefined()
    expect((res.error as { message?: string }).message).toContain('unauthorized')
  })

  it('authenticates with valid token and handles MCP initialize', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    const res = await authAndRoundtrip(socketPath, sessionHandle, 'initialize')
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe(1)
    const result = res.result as { serverInfo?: { name?: string } }
    expect(result.serverInfo?.name).toBe('ittop-memory-bridge')
  })

  it('lists only allowlisted read-only tools after auth', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    const res = await authAndRoundtrip(socketPath, sessionHandle, 'tools/list')
    const result = res.result as { tools: Array<{ name: string }> }
    const names = result.tools.map((t) => t.name)
    expect(names).toEqual(['perseus_vault_recall', 'perseus_vault_get_entity', 'perseus_vault_history'])
    expect(names).not.toContain('perseus_vault_remember')
    expect(names).not.toContain('perseus_vault_write')
  })

  it('parses Content-Length framing with multi-byte UTF-8 cleanly', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker, recalls } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    // Multi-byte German characters in query: Äpfel & Übergrößen (each umlaut is 2 bytes in UTF-8)
    const res = await contentLengthRoundtrip(socketPath, sessionHandle, 'tools/call', {
      name: 'perseus_vault_recall',
      arguments: { query: 'Äpfel & Übergrößen', limit: 3 },
    })
    expect(res.error).toBeUndefined()
    expect(recalls).toHaveLength(1)
    expect(recalls[0]).toEqual({
      query: { query: 'Äpfel & Übergrößen', mode: 'dense' },
      opts: { maxTotal: 3 },
    })
  })

  it('rejects forbidden write/admin tools with error envelope', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    const res = await authAndRoundtrip(socketPath, sessionHandle, 'tools/call', {
      name: 'perseus_vault_remember',
      arguments: { key: 'hacked', content: 'forbidden' },
    })
    const result = res.result as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('not permitted')
  })

  it('fails closed when session is revoked', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    // Revoke session
    sessions.revoke(sessionHandle)

    const res = await authAndRoundtrip(socketPath, sessionHandle, 'tools/call', {
      name: 'perseus_vault_recall',
      arguments: { query: 'after revoke' },
    })
    expect(res.error).toBeDefined()
    expect((res.error as { message?: string }).message).toContain('revoked')
  })

  it('shim script authenticates and proxies stdin/stdout to the bridge socket', async () => {
    const sessions = new SessionRegistry()
    const sessionHandle = sessions.open(WS, { purpose: 'terminal_mcp' })
    const { broker } = stubBroker()

    bridge = new McpBridgeServer({ broker, sessions, workspaceId: WS, sessionHandle })
    const socketPath = await bridge.start()

    const { spawn } = await import('node:child_process')
    const { resolve } = await import('node:path')
    const shimPath = resolve(__dirname, '../mcpShim.cjs')

    const proc = spawn(process.execPath, [shimPath], {
      env: {
        ...process.env,
        ITTOP_MCP_SOCKET: socketPath,
        ITTOP_MCP_TOKEN: sessionHandle,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const responsePromise = new Promise<Record<string, unknown>>((resolveResp, rejectResp) => {
      let out = ''
      proc.stdout.on('data', (d) => {
        out += d.toString('utf8')
        const nl = out.indexOf('\n')
        if (nl !== -1) {
          try {
            resolveResp(JSON.parse(out.slice(0, nl)))
          } catch (e) {
            rejectResp(e)
          }
        }
      })
      proc.on('error', rejectResp)
    })

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) + '\n')
    const res = await responsePromise
    expect(res.id).toBe(99)
    const result = res.result as { tools: Array<{ name: string }> }
    expect(result.tools.map((t) => t.name)).toContain('perseus_vault_recall')
    proc.kill()
  })
})
