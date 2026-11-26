import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, statSync, unlinkSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { ControlMessage, DeviceInfo, FRAME_TYPE_JPEG, MirrorOptions } from '@shared/types'
import { MirrorSession } from './driver'
import {
  buildUiInputCommand,
  extractJpegFrames,
  OHOS_KEYCODE_NUM,
  parseHdcScreenSize
} from './hdc-utils'

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

function resolveAgentSoPath(): string | null {
  const candidates = [
    join(process.cwd(), 'resources', 'bin', 'agent.so'),
    process.resourcesPath ? join(process.resourcesPath, 'bin', 'agent.so') : ''
  ].filter(Boolean)

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function clampCoord(norm: number, max: number): number {
  const clamped = Math.max(0, Math.min(1, norm))
  return Math.round(clamped * Math.max(1, max - 1))
}

export class HdcMirrorSession extends EventEmitter implements MirrorSession {
  private running = false
  private hdcBin = 'hdc'
  private screenWidth: number
  private screenHeight: number
  private videoSocket: net.Socket | null = null
  private h264Socket: net.Socket | null = null
  private controlSocket: net.Socket | null = null
  private driverRef: string | null = null
  private forwardedPort: number | null = null
  private h264ForwardedPort: number | null = null
  private lastFrame: Buffer | null = null
  private lastFrameAt = 0
  private lastWakeAt = 0
  private tempCapturePath: string
  private reqSeq = 1
  private controlBusy = false
  private controlBusyTimer: NodeJS.Timeout | null = null
  private pendingControl: ControlMessage | null = null

  constructor(
    readonly sessionId: string,
    readonly device: DeviceInfo,
    private options: MirrorOptions,
    private getHdcBin: () => Promise<string>
  ) {
    super()
    this.screenWidth = device.screenWidth ?? 1260
    this.screenHeight = device.screenHeight ?? 2720
    this.tempCapturePath = join(tmpdir(), `monitorsync_${sessionId}.jpeg`)
  }

  async start(): Promise<void> {
    this.running = true
    this.emit('status', 'connecting', '正在连接 HarmonyOS NEXT 设备...')

    try {
      this.hdcBin = await this.getHdcBin()
      // Always wake up sleeping screen automatically when starting mirror
      await this.wakeScreen()
      await this.detectScreenResolution()

      // Mode A: Push agent.so + start uitest daemon + dual TCP sockets (video stream + low-latency RPC control)
      const streamStarted = await this.tryStartAgentStream()
      if (!streamStarted && this.running) {
        // Mode B fallback: scaled snapshot_display loop + direct hdc shell uiInput control
        this.emit('meta', {
          deviceId: this.device.id,
          deviceName: this.device.name,
          engine: 'harmony-next',
          codec: 'jpeg',
          width: this.screenWidth,
          height: this.screenHeight,
          mode: 'HDC Snapshot 兼容模式'
        })
        this.emit('status', 'streaming', '已启动兼容投屏模式')
        void this.runSnapshotLoop()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('status', 'error', message)
      await this.stop()
    }
  }

  private async wakeScreen(): Promise<void> {
    const now = Date.now()
    if (now - this.lastWakeAt < 800) return
    this.lastWakeAt = now
    await execFileAsync(this.hdcBin, ['-t', this.device.id, 'shell', 'power-shell wakeup'], {
      timeout: 2500,
      windowsHide: true
    }).catch(() => {})
  }

  private async launchCompanionAgent(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'shell', 'bm dump -a'],
        { timeout: 3000, windowsHide: true }
      )
      if (!stdout.includes('com.monitorsync.agent')) return false

      await this.wakeScreen()
      await execFileAsync(
        this.hdcBin,
        [
          '-t',
          this.device.id,
          'shell',
          'aa start -a EntryAbility -b com.monitorsync.agent --pb autostart true'
        ],
        { timeout: 4000, windowsHide: true }
      )
      return true
    } catch {
      return false
    }
  }

  private async detectScreenResolution(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'shell', 'hidumper -s RenderService -a screen'],
        { timeout: 3000, windowsHide: true }
      )
      const dims = parseHdcScreenSize(stdout)
      if (dims) {
        this.screenWidth = dims.width
        this.screenHeight = dims.height
      }
    } catch {
      // Keep default dimensions
    }
  }

  private async ensureDeviceAgent(localAgentPath: string): Promise<void> {
    const remotePath = '/data/local/tmp/agent.so'
    const localSize = statSync(localAgentPath).size

    // Check if remote agent.so already exists with matching byte size
    let needsPush = true
    try {
      const { stdout } = await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'shell', `stat -c %s ${remotePath} 2>/dev/null || echo 0`],
        { timeout: 3000, windowsHide: true }
      )
      if (Number.parseInt(stdout.trim(), 10) === localSize) {
        needsPush = false
      }
    } catch {
      needsPush = true
    }

    if (needsPush) {
      await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'file', 'send', localAgentPath, remotePath],
        { timeout: 8000, windowsHide: true }
      )
    }

    await execFileAsync(this.hdcBin, ['-t', this.device.id, 'shell', `chmod +x ${remotePath}`], {
      timeout: 3000,
      windowsHide: true
    })

    // Kill any stale uitest singleness daemon and launch fresh
    try {
      const { stdout } = await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'shell', 'ps -ef'],
        { timeout: 3000, windowsHide: true }
      )
      for (const line of stdout.split(/\r?\n/)) {
        if (line.includes('uitest start-daemon singleness')) {
          const pid = line.trim().split(/\s+/)[1]
          if (pid && /^\d+$/.test(pid)) {
            await execFileAsync(this.hdcBin, ['-t', this.device.id, 'shell', `kill -9 ${pid}`], {
              timeout: 2000,
              windowsHide: true
            }).catch(() => {})
          }
        }
      }
    } catch {
      // ignore
    }

    await execFileAsync(
      this.hdcBin,
      ['-t', this.device.id, 'shell', 'uitest start-daemon singleness'],
      { timeout: 5000, windowsHide: true }
    )
    await new Promise((r) => setTimeout(r, 400))
  }

  private async connectControlRpc(localPort: number): Promise<void> {
    try {
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: localPort })
        s.setNoDelay(true)
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      })
      this.controlSocket = sock
      // Track RPC completion so we never pile up a lag queue on uitest
      sock.on('data', () => {
        if (this.controlBusy) {
          this.controlBusy = false
          if (this.controlBusyTimer) {
            clearTimeout(this.controlBusyTimer)
            this.controlBusyTimer = null
          }
          if (this.pendingControl) {
            const next = this.pendingControl
            this.pendingControl = null
            this.handleControl(next)
          }
        }
      })
      sock.on('error', () => {
        this.controlSocket = null
        this.driverRef = null
      })
      sock.on('close', () => {
        this.controlSocket = null
        this.driverRef = null
      })

      // Create Hypium Driver instance
      const createMsg = JSON.stringify({
        module: 'com.ohos.devicetest.hypiumApiHelper',
        method: 'callHypiumApi',
        params: {
          api: 'Driver.create',
          this: null,
          args: [],
          message_type: 'hypium'
        },
        request_id: `${Date.now()}_${this.reqSeq++}`
      })

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1500)
        sock.once('data', (chunk) => {
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(chunk.toString('utf-8')) as { result?: string }
            if (parsed.result) {
              this.driverRef = parsed.result
            }
          } catch {
            this.driverRef = 'Driver#0'
          }
          resolve()
        })
        sock.write(`${createMsg}\n`)
      })
    } catch {
      this.controlSocket = null
      this.driverRef = null
    }
  }

  /**
   * Mode A: Real-time JPEG stream via uitest agent.so + port 8012 newline JSON-RPC.
   */
  private async tryStartAgentStream(): Promise<boolean> {
    const localAgentPath = resolveAgentSoPath()
    if (!localAgentPath) return false

    try {
      this.emit('status', 'connecting', '正在启动鸿蒙高速图像流服务...')
      await this.ensureDeviceAgent(localAgentPath)
      if (!this.running) return false

      const localPort = await findFreePort()
      this.forwardedPort = localPort
      await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'fport', `tcp:${localPort}`, 'tcp:8012'],
        { timeout: 3000, windowsHide: true }
      )

      // Establish fast control RPC socket first
      await this.connectControlRpc(localPort)

      // Tier 1: Try MonitorSync HarmonyOS 60fps H.264 companion HAP on device port 27183
      let h264Started = await this.tryStartH264Stream(900)
      if (!h264Started && this.running) {
        // Companion HAP not streaming yet — try launching it directly from PC!
        const launched = await this.launchCompanionAgent()
        if (launched && this.running) {
          this.emit(
            'status',
            'connecting',
            '已从电脑端拉起手机 60fps 推流，如手机弹出录屏授权请点「允许」...'
          )
          for (let attempt = 0; attempt < 12 && this.running; attempt++) {
            await new Promise((r) => setTimeout(r, 500))
            h264Started = await this.tryStartH264Stream(700)
            if (h264Started) break
          }
        }
      }
      if (h264Started) return true

      // Tier 2: Real-time JPEG stream via uitest agent.so on port 8012
      return await new Promise<boolean>((resolve) => {
        let resolved = false
        let buffer: Buffer = Buffer.alloc(0)

        const socket = net.createConnection({ host: '127.0.0.1', port: localPort })
        socket.setNoDelay(true)
        this.videoSocket = socket

        const fallbackTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true
            this.cleanupAgentStream()
            resolve(false)
          }
        }, 3500)

        const scale = Math.max(0.25, Math.min(1, this.options.jpegScale || 0.5))
        let retriedWithoutArgs = false

        const sendStartCapture = (args: unknown[]): void => {
          const startMsg = JSON.stringify({
            module: 'com.ohos.devicetest.hypiumApiHelper',
            method: 'Captures',
            params: {
              api: 'startCaptureScreen',
              args
            },
            request_id: `${Date.now()}_${this.reqSeq++}`
          })
          socket.write(`${startMsg}\n`)
        }

        socket.on('connect', () => {
          sendStartCapture(scale < 1 ? [{ scale }] : [])
        })

        socket.on('data', (chunk: Buffer) => {
          if (!this.running) return

          // If device rejected options object, immediately retry with empty args []
          if (!resolved && !retriedWithoutArgs) {
            const headText = chunk.subarray(0, Math.min(chunk.length, 200)).toString('utf-8')
            if (headText.includes('"exception"') && !headText.includes('already running')) {
              retriedWithoutArgs = true
              sendStartCapture([])
              return
            }
          }

          buffer = Buffer.concat([buffer, chunk])
          const { frames, remainder } = extractJpegFrames(buffer)
          buffer = remainder

          if (frames.length > 0) {
            // Only emit the newest frame from this TCP chunk to avoid visual backlog
            const latestFrame = frames[frames.length - 1]
            if (!resolved) {
              resolved = true
              clearTimeout(fallbackTimer)
              this.emit('meta', {
                deviceId: this.device.id,
                deviceName: this.device.name,
                engine: 'harmony-next',
                codec: 'jpeg',
                width: this.screenWidth,
                height: this.screenHeight,
                mode: `HDC 实时流 (${Math.round(scale * 100)}%)`
              })
              this.emit('status', 'streaming', '已连接高速实时画面流')
              resolve(true)
            }
            this.lastFrame = latestFrame
            this.lastFrameAt = Date.now()
            this.emit('frame', FRAME_TYPE_JPEG, latestFrame)
          }
        })

        socket.on('error', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(fallbackTimer)
            this.cleanupAgentStream()
            resolve(false)
          }
        })

        socket.on('close', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(fallbackTimer)
            resolve(false)
          }
        })
      })
    } catch {
      this.cleanupAgentStream()
      return false
    }
  }

  /**
   * Tier 1: Connect to MonitorSync HarmonyOS NEXT companion HAP (port 27183)
   * for zero-copy 60fps H.264 hardware-encoded video streaming.
   * Wire format:
   *   Handshake: "MSH1" (4B) + width (UInt32BE) + height (UInt32BE)
   *   Packets:   frameType (1B: 0x02=config, 0x03=key, 0x04=delta) + length (UInt32BE) + payload
   */
  private async tryStartH264Stream(connectTimeoutMs = 900): Promise<boolean> {
    try {
      const localH264Port = await findFreePort()
      this.h264ForwardedPort = localH264Port
      await execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'fport', `tcp:${localH264Port}`, 'tcp:27183'],
        { timeout: 2500, windowsHide: true }
      )

      return await new Promise<boolean>((resolve) => {
        let resolved = false
        let handshakeDone = false
        let buf: Buffer = Buffer.alloc(0)

        const socket = net.createConnection({ host: '127.0.0.1', port: localH264Port })
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 5000)
        this.h264Socket = socket

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            this.cleanupH264Stream()
            resolve(false)
          }
        }, connectTimeoutMs)

        socket.on('data', (chunk: Buffer) => {
          if (!this.running) return
          buf = Buffer.concat([buf, chunk])

          if (!handshakeDone) {
            if (buf.length < 12) return
            const magic = buf.subarray(0, 4).toString('ascii')
            if (magic !== 'MSH1') {
              clearTimeout(timeout)
              if (!resolved) {
                resolved = true
                this.cleanupH264Stream()
                resolve(false)
              }
              return
            }
            const streamW = buf.readUInt32BE(4)
            const streamH = buf.readUInt32BE(8)
            buf = buf.subarray(12)
            handshakeDone = true

            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              this.emit('meta', {
                deviceId: this.device.id,
                deviceName: this.device.name,
                engine: 'harmony-next',
                codec: 'h264',
                width: streamW,
                height: streamH,
                mode: 'HarmonyOS H.264 60fps 硬件流'
              })
              this.emit('status', 'streaming', '已连接 60fps H.264 硬件流')
              resolve(true)
            }
          }

          while (buf.length >= 5) {
            const frameType = buf.readUInt8(0)
            const payloadLen = buf.readUInt32BE(1)
            // 0x00 with len 0 is a keepalive heartbeat packet from phone
            if (frameType === 0 && payloadLen === 0) {
              buf = buf.subarray(5)
              continue
            }
            if (payloadLen === 0 || payloadLen > 8 * 1024 * 1024) {
              buf = Buffer.alloc(0)
              break
            }
            if (buf.length < 5 + payloadLen) break
            const payload = Buffer.from(buf.subarray(5, 5 + payloadLen))
            buf = buf.subarray(5 + payloadLen)
            this.lastFrameAt = Date.now()
            this.emit('frame', frameType, payload)
          }
        })

        socket.on('error', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            this.cleanupH264Stream()
            resolve(false)
          }
        })

        socket.on('close', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            this.cleanupH264Stream()
            resolve(false)
          } else if (this.running) {
            void this.reconnectH264Stream()
          }
        })
      })
    } catch {
      this.cleanupH264Stream()
      return false
    }
  }

  private async reconnectH264Stream(): Promise<void> {
    if (!this.running) return
    this.cleanupH264Stream()
    this.emit('status', 'connecting', '60fps 通道波动，正在自动重连...')

    for (let i = 0; i < 4 && this.running; i++) {
      await new Promise((r) => setTimeout(r, 600))
      if (!this.running) return
      const ok = await this.tryStartH264Stream(1000)
      if (ok) return
    }

    if (this.running) {
      this.emit('status', 'stopped', '60fps H.264 推流已断开，请重新点击开始投屏')
      await this.stop()
    }
  }

  private cleanupH264Stream(): void {
    if (this.h264Socket) {
      this.h264Socket.destroy()
      this.h264Socket = null
    }
    if (this.h264ForwardedPort !== null) {
      const port = this.h264ForwardedPort
      this.h264ForwardedPort = null
      execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'fport', 'rm', `tcp:${port}`, 'tcp:27183'],
        { timeout: 2000, windowsHide: true }
      ).catch(() => {})
    }
  }

  private cleanupAgentStream(): void {
    this.cleanupH264Stream()
    if (this.videoSocket) {
      try {
        if (!this.videoSocket.destroyed) {
          const stopMsg = JSON.stringify({
            module: 'com.ohos.devicetest.hypiumApiHelper',
            method: 'Captures',
            params: { api: 'stopCaptureScreen', args: [] },
            request_id: `${Date.now()}_${this.reqSeq++}`
          })
          this.videoSocket.write(`${stopMsg}\n`)
        }
      } catch {
        // ignore
      }
      this.videoSocket.destroy()
      this.videoSocket = null
    }
    if (this.controlBusyTimer) {
      clearTimeout(this.controlBusyTimer)
      this.controlBusyTimer = null
    }
    this.controlBusy = false
    this.pendingControl = null
    if (this.controlSocket) {
      this.controlSocket.destroy()
      this.controlSocket = null
      this.driverRef = null
    }
    if (this.forwardedPort !== null) {
      const port = this.forwardedPort
      this.forwardedPort = null
      execFileAsync(
        this.hdcBin,
        ['-t', this.device.id, 'fport', 'rm', `tcp:${port}`, 'tcp:8012'],
        { timeout: 2000, windowsHide: true }
      ).catch(() => {})
    }
  }

  /**
   * Mode B fallback: scaled snapshot_display loop when agent.so is not present.
   */
  private async runSnapshotLoop(): Promise<void> {
    const remotePath = `/data/local/tmp/ms_${this.sessionId.slice(0, 8)}.jpeg`
    const scale = Math.max(0.3, Math.min(1, this.options.jpegScale || 0.5))
    const capW = Math.max(240, Math.round(this.screenWidth * scale))
    const capH = Math.max(240, Math.round(this.screenHeight * scale))
    let consecutiveErrors = 0

    while (this.running) {
      try {
        await execFileAsync(
          this.hdcBin,
          ['-t', this.device.id, 'shell', `snapshot_display -w ${capW} -h ${capH} -f ${remotePath}`],
          { timeout: 4000, windowsHide: true }
        )
        if (!this.running) break

        await execFileAsync(
          this.hdcBin,
          ['-t', this.device.id, 'file', 'recv', remotePath, this.tempCapturePath],
          { timeout: 4000, windowsHide: true }
        )
        if (!this.running) break

        if (existsSync(this.tempCapturePath)) {
          const jpeg = readFileSync(this.tempCapturePath)
          if (jpeg.length > 256) {
            this.lastFrame = jpeg
            this.emit('frame', FRAME_TYPE_JPEG, jpeg)
            consecutiveErrors = 0
          }
        }
      } catch (err) {
        consecutiveErrors++
        if (consecutiveErrors >= 5) {
          this.emit(
            'status',
            'error',
            `画面采集连续失败，请检查设备连接: ${err instanceof Error ? err.message : String(err)}`
          )
          await this.stop()
          return
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    execFileAsync(this.hdcBin, ['-t', this.device.id, 'shell', `rm -f ${remotePath}`], {
      timeout: 2000,
      windowsHide: true
    }).catch(() => {})
  }

  private sendHypiumRpc(api: string, args: unknown[]): boolean {
    if (!this.controlSocket || this.controlSocket.destroyed || !this.driverRef) {
      return false
    }
    this.controlBusy = true
    if (this.controlBusyTimer) clearTimeout(this.controlBusyTimer)
    this.controlBusyTimer = setTimeout(() => {
      this.controlBusy = false
      this.controlBusyTimer = null
      if (this.pendingControl) {
        const next = this.pendingControl
        this.pendingControl = null
        this.handleControl(next)
      }
    }, 350)

    const payload = JSON.stringify({
      module: 'com.ohos.devicetest.hypiumApiHelper',
      method: 'callHypiumApi',
      params: {
        api,
        this: this.driverRef,
        args,
        message_type: 'hypium'
      },
      request_id: `${Date.now()}_${this.reqSeq++}`
    })
    this.controlSocket.write(`${payload}\n`)
    return true
  }

  handleControl(message: ControlMessage): void {
    if (!this.running) return

    // Dedicated wake action: use power-shell wakeup (safe no-op if already awake)
    if (message.type === 'key' && message.action === 'wake') {
      void this.wakeScreen()
      return
    }

    // If screen appears asleep (no frames recently) and user clicks/interacts, auto-wake it!
    if (
      (message.type === 'click' ||
        message.type === 'swipe' ||
        (message.type === 'key' && message.action !== 'power')) &&
      Date.now() - this.lastFrameAt > 2000
    ) {
      void this.wakeScreen()
    }

    // Fast path: send directly over persistent TCP RPC socket with anti-backlog flow control
    if (this.controlSocket && !this.controlSocket.destroyed && this.driverRef) {
      if (this.controlBusy) {
        // Coalesce/overwrite pending move/scroll so uitest never builds a multi-second lag queue
        if (message.type === 'swipe' && this.pendingControl?.type === 'swipe') {
          this.pendingControl = {
            ...message,
            nx1: this.pendingControl.nx1,
            ny1: this.pendingControl.ny1
          }
        } else {
          this.pendingControl = message
        }
        return
      }

      switch (message.type) {
        case 'click': {
          const x = clampCoord(message.nx, this.screenWidth)
          const y = clampCoord(message.ny, this.screenHeight)
          if (this.sendHypiumRpc('Driver.click', [x, y])) return
          break
        }
        case 'longClick': {
          const x = clampCoord(message.nx, this.screenWidth)
          const y = clampCoord(message.ny, this.screenHeight)
          if (this.sendHypiumRpc('Driver.longClick', [x, y])) return
          break
        }
        case 'swipe': {
          const x1 = clampCoord(message.nx1, this.screenWidth)
          const y1 = clampCoord(message.ny1, this.screenHeight)
          const x2 = clampCoord(message.nx2, this.screenWidth)
          const y2 = clampCoord(message.ny2, this.screenHeight)
          const physDist = Math.hypot(x2 - x1, y2 - y1)
          if (physDist < 4) return
          // Keep physical swipe velocity snappy without overshooting page flips
          const requested = message.speed ?? 7500
          const speed = Math.max(4000, Math.min(18000, Math.round(requested)))
          if (this.sendHypiumRpc('Driver.swipe', [x1, y1, x2, y2, speed])) return
          break
        }
        case 'scroll': {
          const x = clampCoord(message.nx, this.screenWidth)
          const y = clampCoord(message.ny, this.screenHeight)
          const down = message.deltaY > 0
          const steps = Math.max(2, Math.min(8, Math.round(Math.abs(message.deltaY) / 45)))
          if (this.sendHypiumRpc('Driver.mouseScroll', [{ x, y }, down, steps])) return
          return
        }
        case 'key': {
          if (message.action === 'back') {
            if (this.sendHypiumRpc('Driver.pressBack', [])) return
          } else if (message.action === 'home') {
            if (this.sendHypiumRpc('Driver.pressHome', [])) return
          } else {
            const code = OHOS_KEYCODE_NUM[message.action]
            if (code !== undefined && this.sendHypiumRpc('Driver.triggerKey', [code])) return
          }
          break
        }
        default:
          break
      }
    }

    // Reliable fallback: direct `hdc -t <id> shell <cmd>` (works on Windows without TTY issues)
    const cmd = buildUiInputCommand(message, this.screenWidth, this.screenHeight)
    if (!cmd) return
    execFileAsync(this.hdcBin, ['-t', this.device.id, 'shell', cmd], {
      timeout: 3000,
      windowsHide: true
    }).catch(() => {})
  }

  async takeScreenshot(): Promise<Buffer> {
    if (this.lastFrame) return this.lastFrame
    throw new Error('当前暂无可用画面帧')
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.cleanupAgentStream()

    try {
      if (existsSync(this.tempCapturePath)) {
        unlinkSync(this.tempCapturePath)
      }
    } catch {
      // ignore
    }
    this.emit('close')
  }
}
