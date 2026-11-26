import { ChildProcess, execFile, spawn } from 'child_process'
import { EventEmitter } from 'events'
import net from 'net'
import { promisify } from 'util'
import {
  ControlMessage,
  DeviceInfo,
  FRAME_TYPE_H264_CONFIG,
  FRAME_TYPE_H264_DELTA,
  FRAME_TYPE_H264_KEYFRAME,
  MirrorOptions
} from '@shared/types'
import { MirrorSession } from './driver'
import {
  ANDROID_KEY_ACTION_DOWN,
  ANDROID_KEY_ACTION_UP,
  ANDROID_KEYCODE_MAP,
  ANDROID_MOTION_ACTION_DOWN,
  ANDROID_MOTION_ACTION_MOVE,
  ANDROID_MOTION_ACTION_UP,
  serializeKeycodeEvent,
  serializeScrollEvent,
  serializeTextEvent,
  serializeTouchEvent
} from './scrcpy-protocol'

const execFileAsync = promisify(execFile)

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

export class ScrcpyMirrorSession extends EventEmitter implements MirrorSession {
  private running = false
  private adbBin = 'adb'
  private serverProc: ChildProcess | null = null
  private videoSocket: net.Socket | null = null
  private controlSocket: net.Socket | null = null
  private forwardedPort: number | null = null
  private videoWidth = 1080
  private videoHeight = 2400

  constructor(
    readonly sessionId: string,
    readonly device: DeviceInfo,
    private options: MirrorOptions,
    private getAdbBin: () => Promise<string>,
    private resolveScrcpyServer: () => { available: boolean; path: string }
  ) {
    super()
  }

  async start(): Promise<void> {
    this.running = true
    this.emit('status', 'connecting', '正在启动 Android scrcpy-server...')

    try {
      this.adbBin = await this.getAdbBin()
      const serverFile = this.resolveScrcpyServer()
      if (!serverFile.available) {
        throw new Error(
          `未找到 scrcpy-server 文件（默认路径: ${serverFile.path}）。请从 Genymobile/scrcpy Releases 下载 scrcpy-server 并在「设置」中指定路径。`
        )
      }

      const remoteJar = '/data/local/tmp/scrcpy-server.jar'
      await execFileAsync(this.adbBin, ['-s', this.device.id, 'push', serverFile.path, remoteJar], {
        timeout: 10000,
        windowsHide: true
      })

      const localPort = await findFreePort()
      this.forwardedPort = localPort
      const scid = Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, '0')
      const socketName = `scrcpy_${scid}`

      await execFileAsync(
        this.adbBin,
        ['-s', this.device.id, 'forward', `tcp:${localPort}`, `localabstract:${socketName}`],
        { timeout: 5000, windowsHide: true }
      )

      const serverArgs = [
        'CLASSPATH=' + remoteJar,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        '3.1',
        `scid=${scid}`,
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'video_codec=h264',
        `max_size=${this.options.maxSize}`,
        `video_bit_rate=${this.options.bitRate}`,
        `max_fps=${this.options.maxFps}`,
        'send_device_meta=true',
        'send_codec_meta=true',
        'send_frame_meta=true',
        'send_dummy_byte=true'
      ]

      this.serverProc = spawn(this.adbBin, ['-s', this.device.id, 'shell', serverArgs.join(' ')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      let serverLogs = ''
      let serverExited = false
      const appendLog = (chunk: Buffer): void => {
        serverLogs = (serverLogs + chunk.toString('utf-8')).slice(-2000)
      }
      this.serverProc.stdout?.on('data', appendLog)
      this.serverProc.stderr?.on('data', appendLog)

      this.serverProc.on('exit', (code) => {
        serverExited = true
        if (this.running) {
          const detail = serverLogs.trim().split(/\r?\n/).slice(-3).join(' | ')
          const msg = detail
            ? `scrcpy-server 已退出 (${code ?? '?'}): ${detail}`
            : 'scrcpy-server 已退出'
          this.emit('status', 'stopped', msg)
          void this.stop()
        }
      })

      // Connect video socket and wait for the scrcpy dummy byte (0x00).
      // With `adb forward`, localhost TCP connect succeeds immediately even before
      // scrcpy-server binds the abstract socket on the device, then adb closes it (EOF).
      // Waiting for the dummy byte guarantees the server is actually ready.
      const { socket: videoSock, initialData } = await this.connectVideoWithRetry(
        localPort,
        () => serverExited,
        () => serverLogs
      )
      this.videoSocket = videoSock
      videoSock.setNoDelay(true)

      const controlSock = await this.connectControlWithRetry(localPort, () => serverExited)
      this.controlSocket = controlSock
      controlSock.setNoDelay(true)
      controlSock.on('error', () => {
        // Ignore control socket write errors during teardown
      })

      this.setupVideoParser(videoSock, initialData)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('status', 'error', msg)
      await this.stop()
    }
  }

  private async connectVideoWithRetry(
    port: number,
    hasServerExited: () => boolean,
    getServerLogs: () => string,
    retries = 40
  ): Promise<{ socket: net.Socket; initialData: Buffer }> {
    for (let i = 0; i < retries; i++) {
      if (!this.running) throw new Error('会话已取消')
      if (hasServerExited()) {
        const detail = getServerLogs().trim().split(/\r?\n/).slice(-3).join(' | ')
        throw new Error(detail ? `scrcpy-server 启动失败: ${detail}` : 'scrcpy-server 启动失败并退出')
      }

      try {
        return await new Promise<{ socket: net.Socket; initialData: Buffer }>((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port })
          let settled = false

          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true
              cleanup()
              sock.destroy()
              reject(new Error('等待 scrcpy 握手字节超时'))
            }
          }, 1500)

          const onData = (chunk: Buffer): void => {
            if (settled || chunk.length === 0) return
            settled = true
            cleanup()
            // Strip the 1-byte dummy byte (0x00) and keep any trailing bytes (e.g. deviceMeta)
            resolve({ socket: sock, initialData: chunk.subarray(1) })
          }

          const onFail = (err?: Error): void => {
            if (settled) return
            settled = true
            cleanup()
            sock.destroy()
            reject(err ?? new Error('Socket closed before dummy byte'))
          }

          const cleanup = (): void => {
            clearTimeout(timeout)
            sock.off('data', onData)
            sock.off('error', onFail)
            sock.off('close', onFail)
            sock.off('end', onFail)
          }

          sock.on('data', onData)
          sock.once('error', onFail)
          sock.once('close', onFail)
          sock.once('end', onFail)
        })
      } catch {
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    const detail = getServerLogs().trim().split(/\r?\n/).slice(-3).join(' | ')
    throw new Error(
      detail
        ? `连接 scrcpy-server Socket 超时: ${detail}`
        : '连接 scrcpy-server Socket 超时，请检查 scrcpy-server 版本是否为 3.1'
    )
  }

  private async connectControlWithRetry(
    port: number,
    hasServerExited: () => boolean,
    retries = 15
  ): Promise<net.Socket> {
    for (let i = 0; i < retries; i++) {
      if (!this.running || hasServerExited()) throw new Error('会话已取消')
      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port })
          sock.once('connect', () => resolve(sock))
          sock.once('error', (e) => {
            sock.destroy()
            reject(e)
          })
        })
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error('连接 scrcpy-server 控制通道超时')
  }

  private setupVideoParser(socket: net.Socket, initialData: Buffer): void {
    let stage: 'deviceMeta' | 'codecMeta' | 'frameHeader' | 'framePayload' = 'deviceMeta'
    let buf: Buffer = Buffer.alloc(0)
    let deviceName = this.device.name
    let pendingPacketSize = 0
    let pendingFrameType = FRAME_TYPE_H264_DELTA

    const processChunk = (chunk: Buffer): void => {
      if (!this.running) return
      if (chunk.length > 0) {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      }

      while (this.running) {
        if (stage === 'deviceMeta') {
          if (buf.length < 64) return
          const rawName = buf.subarray(0, 64).toString('utf-8').replace(/\0.*$/, '').trim()
          if (rawName) deviceName = rawName
          buf = buf.subarray(64)
          stage = 'codecMeta'
        } else if (stage === 'codecMeta') {
          if (buf.length < 12) return
          // bytes 0..3 codecId, 4..7 width, 8..11 height
          this.videoWidth = buf.readUInt32BE(4)
          this.videoHeight = buf.readUInt32BE(8)
          buf = buf.subarray(12)
          this.emit('meta', {
            deviceId: this.device.id,
            deviceName,
            engine: 'android',
            codec: 'h264',
            width: this.videoWidth,
            height: this.videoHeight,
            mode: 'Scrcpy H.264 硬件流'
          })
          this.emit('status', 'streaming', '已连接 H.264 低延迟投屏')
          stage = 'frameHeader'
        } else if (stage === 'frameHeader') {
          if (buf.length < 12) return
          const ptsAndFlags = buf.readBigUInt64BE(0)
          pendingPacketSize = buf.readUInt32BE(8)
          const isConfig = (ptsAndFlags & (1n << 63n)) !== 0n
          const isKeyframe = (ptsAndFlags & (1n << 62n)) !== 0n
          pendingFrameType = isConfig
            ? FRAME_TYPE_H264_CONFIG
            : isKeyframe
              ? FRAME_TYPE_H264_KEYFRAME
              : FRAME_TYPE_H264_DELTA
          buf = buf.subarray(12)
          stage = 'framePayload'
        } else if (stage === 'framePayload') {
          if (buf.length < pendingPacketSize) return
          const payload = Buffer.from(buf.subarray(0, pendingPacketSize))
          buf = buf.subarray(pendingPacketSize)
          this.emit('frame', pendingFrameType, payload)
          stage = 'frameHeader'
        }
      }
    }

    socket.on('data', processChunk)

    socket.on('error', (err) => {
      if (this.running) {
        this.emit('status', 'error', `视频流通道异常: ${err.message}`)
        void this.stop()
      }
    })

    socket.on('close', () => {
      if (this.running) void this.stop()
    })

    if (initialData.length > 0) {
      processChunk(initialData)
    }
  }

  private sendControl(packet: Buffer): void {
    if (this.controlSocket && !this.controlSocket.destroyed) {
      this.controlSocket.write(packet)
    }
  }

  handleControl(message: ControlMessage): void {
    if (!this.running || !this.controlSocket) return

    switch (message.type) {
      case 'touch': {
        const action =
          message.action === 'down'
            ? ANDROID_MOTION_ACTION_DOWN
            : message.action === 'move'
              ? ANDROID_MOTION_ACTION_MOVE
              : ANDROID_MOTION_ACTION_UP
        this.sendControl(
          serializeTouchEvent({
            action,
            x: message.nx * this.videoWidth,
            y: message.ny * this.videoHeight,
            width: this.videoWidth,
            height: this.videoHeight
          })
        )
        break
      }
      case 'scroll': {
        this.sendControl(
          serializeScrollEvent({
            x: message.nx * this.videoWidth,
            y: message.ny * this.videoHeight,
            width: this.videoWidth,
            height: this.videoHeight,
            hScroll: -message.deltaX / 240,
            vScroll: -message.deltaY / 240
          })
        )
        break
      }
      case 'key': {
        const code = ANDROID_KEYCODE_MAP[message.action]
        if (code !== undefined) {
          this.sendControl(serializeKeycodeEvent(ANDROID_KEY_ACTION_DOWN, code))
          this.sendControl(serializeKeycodeEvent(ANDROID_KEY_ACTION_UP, code))
        }
        break
      }
      case 'text': {
        if (message.text) {
          this.sendControl(serializeTextEvent(message.text))
        }
        break
      }
      default:
        break
    }
  }

  async takeScreenshot(): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      this.adbBin,
      ['-s', this.device.id, 'exec-out', 'screencap', '-p'],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, windowsHide: true }
    )
    return stdout as unknown as Buffer
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.videoSocket?.destroy()
    this.controlSocket?.destroy()
    this.serverProc?.kill()
    this.videoSocket = null
    this.controlSocket = null
    this.serverProc = null

    if (this.forwardedPort !== null) {
      const port = this.forwardedPort
      this.forwardedPort = null
      execFileAsync(this.adbBin, ['-s', this.device.id, 'forward', '--remove', `tcp:${port}`], {
        timeout: 2000,
        windowsHide: true
      }).catch(() => {})
    }
    this.emit('close')
  }
}
