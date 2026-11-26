import { WebSocket, WebSocketServer } from 'ws'
import {
  ControlMessage,
  FRAME_TYPE_H264_CONFIG,
  FRAME_TYPE_H264_KEYFRAME,
  ServerTextMessage
} from '@shared/types'
import { MirrorSession } from '../drivers/driver'

export class StreamServer {
  private wss: WebSocketServer | null = null
  private port = 0
  private sessions = new Map<string, MirrorSession>()
  private clients = new Map<string, Set<WebSocket>>()
  private lastMeta = new Map<string, ServerTextMessage>()
  private lastStatus = new Map<string, ServerTextMessage>()
  private lastH264Config = new Map<string, Buffer>()
  private lastH264Keyframe = new Map<string, Buffer>()
  private endedStatus = new Map<string, ServerTextMessage>()

  async start(): Promise<number> {
    if (this.wss) return this.port

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      wss.once('listening', () => {
        const addr = wss.address()
        if (typeof addr === 'object' && addr) {
          this.port = addr.port
          this.wss = wss
          resolve(this.port)
        } else {
          reject(new Error('Failed to bind local WebSocket server'))
        }
      })
      wss.once('error', reject)

      wss.on('connection', (ws, req) => {
        // Disable Nagle's algorithm on local loopback WebSocket for minimum frame latency
        const rawSocket = (ws as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })
          ._socket
        rawSocket?.setNoDelay?.(true)

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const session = this.sessions.get(sessionId)

        if (!session) {
          const ended = this.endedStatus.get(sessionId)
          ws.send(
            JSON.stringify(
              ended ??
                ({
                  type: 'status',
                  state: 'error',
                  message: '投屏会话不存在或已结束'
                } satisfies ServerTextMessage)
            )
          )
          ws.close()
          return
        }

        let set = this.clients.get(sessionId)
        if (!set) {
          set = new Set()
          this.clients.set(sessionId, set)
        }
        set.add(ws)

        const meta = this.lastMeta.get(sessionId)
        if (meta && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(meta))
        }
        const status = this.lastStatus.get(sessionId)
        if (status && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(status))
        }
        const h264Config = this.lastH264Config.get(sessionId)
        if (h264Config && ws.readyState === WebSocket.OPEN) {
          ws.send(h264Config, { binary: true })
        }
        const h264Keyframe = this.lastH264Keyframe.get(sessionId)
        if (h264Keyframe && ws.readyState === WebSocket.OPEN) {
          ws.send(h264Keyframe, { binary: true })
        }

        ws.on('message', (data, isBinary) => {
          if (isBinary) return
          try {
            const msg = JSON.parse(data.toString('utf-8')) as ControlMessage
            session.handleControl(msg)
          } catch {
            // Ignore malformed control messages
          }
        })

        ws.on('close', () => {
          this.clients.get(sessionId)?.delete(ws)
        })
      })
    })
  }

  getPort(): number {
    return this.port
  }

  attachSession(session: MirrorSession): void {
    const { sessionId } = session
    this.sessions.set(sessionId, session)

    session.on('meta', (meta) => {
      const msg: ServerTextMessage = { type: 'meta', ...meta }
      this.lastMeta.set(sessionId, msg)
      this.broadcastText(sessionId, msg)
    })

    session.on('status', (state, message) => {
      const msg: ServerTextMessage = { type: 'status', state, message }
      this.lastStatus.set(sessionId, msg)
      this.broadcastText(sessionId, msg)
    })

    session.on('frame', (frameType: number, payload: Buffer) => {
      const packet = Buffer.allocUnsafe(payload.length + 1)
      packet[0] = frameType
      payload.copy(packet, 1)

      if (frameType === FRAME_TYPE_H264_CONFIG) {
        this.lastH264Config.set(sessionId, packet)
      } else if (frameType === FRAME_TYPE_H264_KEYFRAME) {
        this.lastH264Keyframe.set(sessionId, packet)
      }

      const clients = this.clients.get(sessionId)
      if (!clients || clients.size === 0) return

      // For JPEG (frameType === 1), drop aggressively if WS buffer has any backlog to keep zero latency
      const maxBacklog = frameType === 1 ? 256 * 1024 : 4 * 1024 * 1024

      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < maxBacklog) {
          ws.send(packet, { binary: true })
        }
      }
    })

    session.on('close', () => {
      const last = this.lastStatus.get(sessionId)
      if (last && last.type === 'status' && last.state === 'error') {
        this.endedStatus.set(sessionId, last)
        setTimeout(() => this.endedStatus.delete(sessionId), 15000)
      } else {
        this.broadcastText(sessionId, { type: 'status', state: 'stopped' })
      }
      this.detachSession(sessionId)
    })
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.lastMeta.delete(sessionId)
    this.lastStatus.delete(sessionId)
    this.lastH264Config.delete(sessionId)
    this.lastH264Keyframe.delete(sessionId)
    const set = this.clients.get(sessionId)
    if (set) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
      }
      this.clients.delete(sessionId)
    }
  }

  private broadcastText(sessionId: string, msg: ServerTextMessage): void {
    const clients = this.clients.get(sessionId)
    if (!clients || clients.size === 0) return
    const serialized = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized)
      }
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.stop().catch(() => {})
    }
    this.sessions.clear()
    this.lastMeta.clear()
    this.clients.clear()
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()))
      this.wss = null
    }
  }
}
