import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import type { MemoryBroker } from './broker'
import type { SessionRegistry } from './capabilities'

const MAX_MESSAGE_BYTES = 1024 * 1024 // 1 MB
const REQUEST_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_REQUESTS = 10
const MAX_CLIENT_CONNECTIONS = 5

export interface McpBridgeOptions {
  broker: MemoryBroker
  sessions: SessionRegistry
  workspaceId: string
  sessionHandle: string
}

export interface McpBridgeEndpoint {
  socketPath: string
  sessionHandle: string
  close: () => Promise<void>
}

export function generateSocketPath(): string {
  const id = randomUUID().replace(/-/g, '')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ittop-mcp-${id}`
  }
  return join(tmpdir(), `ittop-mcp-${id}.sock`)
}

export class McpBridgeServer {
  private server: Server | null = null
  private socketPath: string | null = null
  private activeSockets = new Set<Socket>()
  private closed = false

  constructor(private readonly opts: McpBridgeOptions) {}

  async start(): Promise<string> {
    const socketPath = generateSocketPath()
    this.socketPath = socketPath

    // Clean up stale Unix socket if needed
    if (process.platform !== 'win32') {
      try {
        unlinkSync(socketPath)
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleClient(socket))
      this.server = server

      server.on('error', (err) => {
        if (!this.closed) reject(err)
      })

      server.listen(socketPath, () => {
        resolve(socketPath)
      })
    })
  }

  private handleClient(socket: Socket): void {
    if (this.activeSockets.size >= MAX_CLIENT_CONNECTIONS) {
      socket.destroy(new Error('max client connections reached'))
      return
    }
    this.activeSockets.add(socket)
    let buffer: Buffer = Buffer.alloc(0)
    let authenticated = false
    let inFlight = 0

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.destroy(new Error('handshake authentication timed out'))
      }
    }, 10_000)

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.from(Buffer.concat([buffer, chunk]))
      if (buffer.length > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('message size limit exceeded'))
        return
      }
      buffer = Buffer.from(processBuffer(buffer))
    })

    const processBuffer = (buf: Buffer): Buffer => {
      if (buf.length === 0) return buf

      const headerDelimiter = Buffer.from('\r\n\r\n')
      const headerIndex = buf.indexOf(headerDelimiter)
      if (headerIndex !== -1) {
        const headerStr = buf.subarray(0, headerIndex).toString('ascii')
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr)
        if (match) {
          const contentLength = parseInt(match[1], 10)
          const totalLength = headerIndex + 4 + contentLength
          if (buf.length >= totalLength) {
            const bodyBytes = buf.subarray(headerIndex + 4, totalLength)
            const remaining = buf.subarray(totalLength)
            dispatchRawMessage(bodyBytes.toString('utf8'))
            return processBuffer(remaining)
          }
          return buf
        }
      }

      const newlineIndex = buf.indexOf(0x0a)
      if (newlineIndex !== -1) {
        const lineBytes = buf.subarray(0, newlineIndex)
        const lineStr = lineBytes.toString('utf8').trim()
        if (lineStr.toLowerCase().startsWith('content-length:')) {
          return buf // wait for \r\n\r\n
        }
        const remaining = buf.subarray(newlineIndex + 1)
        if (lineStr.length > 0) {
          dispatchRawMessage(lineStr)
        }
        return processBuffer(remaining)
      }

      return buf
    }

    const dispatchRawMessage = (raw: string): void => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw) as Record<string, unknown>
      } catch {
        this.sendError(socket, null, -32700, 'Parse error')
        return
      }

      const id = msg.id as string | number | null
      const method = msg.method as string
      if (!method) return

      if (method === 'ittop/auth') {
        const token = (msg.params as { token?: unknown })?.token
        if (typeof token === 'string' && token === this.opts.sessionHandle) {
          try {
            this.opts.sessions.assertLive(token)
            authenticated = true
            clearTimeout(authTimer)
            this.sendResponse(socket, id, { ok: true, session: token })
          } catch {
            this.sendError(socket, id, -32002, 'session expired or revoked')
          }
        } else {
          this.sendError(socket, id, -32002, 'unauthorized: invalid token')
        }
        return
      }

      if (id === undefined || id === null) {
        if (method === 'notifications/initialized') {
          // handshake initialized notification
        }
        return
      }

      if (!authenticated) {
        this.sendError(socket, id, -32002, 'unauthorized: ittop/auth handshake required before requests')
        return
      }

      if (inFlight >= MAX_CONCURRENT_REQUESTS) {
        this.sendError(socket, id, -32000, 'concurrency limit exceeded')
        return
      }

      inFlight += 1
      let responded = false

      const timer = setTimeout(() => {
        if (!responded) {
          responded = true
          this.sendError(socket, id, -32000, 'Request timeout')
        }
      }, REQUEST_TIMEOUT_MS)

      this.dispatchMethod(method, (msg.params as Record<string, unknown>) ?? {})
        .then((result) => {
          if (!responded) {
            responded = true
            clearTimeout(timer)
            this.sendResponse(socket, id, result)
          }
        })
        .catch((err: Error) => {
          if (!responded) {
            responded = true
            clearTimeout(timer)
            this.sendError(socket, id, -32603, err.message)
          }
        })
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1)
        })
    }

    socket.on('close', () => {
      clearTimeout(authTimer)
      this.activeSockets.delete(socket)
    })

    socket.on('error', () => {
      clearTimeout(authTimer)
      this.activeSockets.delete(socket)
    })
  }

  private async dispatchMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ittop-memory-bridge', version: '1.1.0' },
        }

      case 'tools/list':
        return {
          tools: [
            {
              name: 'perseus_vault_recall',
              description: 'Recall relevant memories from the vault using semantic query.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Semantic search query' },
                  limit: { type: 'number', description: 'Max items to return (1..50)' },
                },
                required: ['query'],
              },
            },
            {
              name: 'perseus_vault_get_entity',
              description: 'Retrieve a specific entity from the vault by id.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Entity ID' },
                  db: { type: 'string', description: 'Target database (defaults to workspace db)' },
                },
                required: ['id'],
              },
            },
            {
              name: 'perseus_vault_history',
              description: 'Retrieve revision history for a key in a category.',
              inputSchema: {
                type: 'object',
                properties: {
                  category: { type: 'string', description: 'Entity category' },
                  key: { type: 'string', description: 'Entity key' },
                  db: { type: 'string', description: 'Target database (defaults to workspace db)' },
                },
                required: ['category', 'key'],
              },
            },
          ],
        }

      case 'tools/call':
        return this.dispatchToolCall(params)

      default:
        throw new Error(`method '${method}' not found`)
    }
  }

  private async dispatchToolCall(params: Record<string, unknown>): Promise<unknown> {
    const tool = params.name as string
    const args = (params.arguments as Record<string, unknown>) ?? {}
    const handle = this.opts.sessionHandle

    // Verify session before call
    this.opts.sessions.assertLive(handle)

    switch (tool) {
      case 'perseus_vault_recall': {
        const query = typeof args.query === 'string' ? args.query : ''
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 10
        // Enforce read hygiene: dense mode only, reinforce: false
        const result = await this.opts.broker.recall(handle, { query, mode: 'dense' }, { maxTotal: limit })
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      }

      case 'perseus_vault_get_entity': {
        const id = typeof args.id === 'string' ? args.id : ''
        const grant = this.opts.sessions.resolve(handle)
        const targetDb = typeof args.db === 'string' ? args.db : grant.workspaceDb
        const result = await this.opts.broker.getEntity(handle, targetDb, id)
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      }

      case 'perseus_vault_history': {
        const category = typeof args.category === 'string' ? args.category : ''
        const key = typeof args.key === 'string' ? args.key : ''
        const grant = this.opts.sessions.resolve(handle)
        const targetDb = typeof args.db === 'string' ? args.db : grant.workspaceDb
        const result = await this.opts.broker.history(handle, targetDb, category, key)
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `tool '${tool}' is not permitted by ittop memory bridge (read-only allowlist)` }],
        }
    }
  }

  private sendResponse(socket: Socket, id: string | number | null, result: unknown): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
    try {
      socket.write(payload)
    } catch {
      // socket dead
    }
  }

  private sendError(socket: Socket, id: string | number | null, code: number, message: string): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
    try {
      socket.write(payload)
    } catch {
      // socket dead
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const s of this.activeSockets) {
      try {
        s.destroy()
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
    }

    if (this.socketPath && process.platform !== 'win32') {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // ignore
      }
    }
    this.socketPath = null
  }
}
