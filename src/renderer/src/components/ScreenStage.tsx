import React, { useEffect, useRef, useState } from 'react'
import { Loader2, MonitorSmartphone, MousePointerClick } from 'lucide-react'
import {
  ControlMessage,
  FRAME_TYPE_JPEG,
  ServerTextMessage,
  StartSessionResult,
  StreamMetaMessage,
  SystemKeyAction
} from '@shared/types'
import { H264CanvasDecoder } from '../lib/h264-decoder'
import { JpegFrameRenderer } from '../lib/jpeg-renderer'

interface ScreenStageProps {
  session: StartSessionResult | null
  onSendReady?: (sendFn: ((msg: ControlMessage) => void) | null) => void
  onStatusToast?: (text: string) => void
}

const KEY_EVENT_MAP: Record<string, SystemKeyAction> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Escape: 'back',
  Tab: 'tab',
  ArrowUp: 'arrowUp',
  ArrowDown: 'arrowDown',
  ArrowLeft: 'arrowLeft',
  ArrowRight: 'arrowRight'
}

export const ScreenStage: React.FC<ScreenStageProps> = ({
  session,
  onSendReady,
  onStatusToast
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pointerDownRef = useRef<{
    nx: number
    ny: number
    lastNx: number
    lastNy: number
    lastSentTime: number
    clientX: number
    clientY: number
    lastClientX: number
    lastClientY: number
    time: number
    dragged: boolean
    horizontalFired: boolean
    active: boolean
  } | null>(null)
  const wheelAccRef = useRef<{ nx: number; ny: number; deltaX: number; deltaY: number; timer: number | null }>({
    nx: 0.5,
    ny: 0.5,
    deltaX: 0,
    deltaY: 0,
    timer: null
  })

  const [meta, setMeta] = useState<StreamMetaMessage | null>(null)
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'streaming' | 'error'>(
    'idle'
  )
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [fps, setFps] = useState<number>(0)

  useEffect(() => {
    if (!session) {
      setMeta(null)
      setStreamState('idle')
      setStatusMessage('')
      setFps(0)
      onSendReady?.(null)
      return
    }

    setStreamState('connecting')
    setStatusMessage('正在建立画面通道...')
    setMeta(null)

    let frameCounter = 0
    const fpsTimer = window.setInterval(() => {
      setFps(frameCounter)
      frameCounter = 0
    }, 1000)

    let ctxCache: CanvasRenderingContext2D | null = null
    const drawToCanvas = (source: ImageBitmap | VideoFrame, w: number, h: number): void => {
      const canvas = canvasRef.current
      if (!canvas) {
        source.close()
        return
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        ctxCache = null
      }
      if (!ctxCache) {
        ctxCache = canvas.getContext('2d', { alpha: false, desynchronized: true })
      }
      if (ctxCache) {
        ctxCache.drawImage(source, 0, 0, w, h)
      }
      source.close()
      frameCounter++
    }

    const jpegRenderer = new JpegFrameRenderer((bitmap) => {
      drawToCanvas(bitmap, bitmap.width, bitmap.height)
    })

    const h264Decoder = new H264CanvasDecoder(
      (frame) => {
        drawToCanvas(frame, frame.displayWidth, frame.displayHeight)
      },
      (err) => {
        setStatusMessage(`解码异常: ${err.message}`)
      }
    )

    const ws = new WebSocket(`ws://127.0.0.1:${session.wsPort}?sessionId=${session.sessionId}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendControl = (msg: ControlMessage): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    }

    ws.onopen = () => {
      onSendReady?.(sendControl)
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const parsed = JSON.parse(event.data) as ServerTextMessage
          if (parsed.type === 'meta') {
            setMeta(parsed)
          } else if (parsed.type === 'status') {
            if (parsed.state === 'streaming') setStreamState('streaming')
            else if (parsed.state === 'connecting') setStreamState('connecting')
            else if (parsed.state === 'error') {
              setStreamState('error')
              onStatusToast?.(parsed.message ?? '投屏出现错误')
            } else if (parsed.state === 'stopped') {
              setStreamState('idle')
            }
            if (parsed.message) setStatusMessage(parsed.message)
          }
        } catch {
          // ignore
        }
        return
      }

      if (event.data instanceof ArrayBuffer) {
        const view = new Uint8Array(event.data)
        if (view.length < 2) return
        const frameType = view[0]
        const payload = view.subarray(1)
        if (frameType === FRAME_TYPE_JPEG) {
          jpegRenderer.push(payload)
        } else {
          h264Decoder.feed(frameType, payload)
        }
      }
    }

    ws.onerror = () => {
      setStreamState('error')
      setStatusMessage('本地画面流连接异常')
    }

    ws.onclose = () => {
      onSendReady?.(null)
    }

    return () => {
      window.clearInterval(fpsTimer)
      jpegRenderer.dispose()
      h264Decoder.close()
      ws.close()
      wsRef.current = null
      onSendReady?.(null)
    }
  }, [session?.sessionId])

  const send = (msg: ControlMessage): void => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  const getNormalizedCoords = (e: React.MouseEvent | React.PointerEvent): { nx: number; ny: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { nx: 0, ny: 0 }
    const rect = canvas.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)))
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)))
    return { nx, ny }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session) return
    e.currentTarget.focus()

    // Right click -> Back, Middle click -> Home
    if (e.button === 2) {
      send({ type: 'key', action: 'back' })
      return
    }
    if (e.button === 1) {
      e.preventDefault()
      send({ type: 'key', action: 'home' })
      return
    }
    if (e.button !== 0) return

    e.currentTarget.setPointerCapture(e.pointerId)
    const { nx, ny } = getNormalizedCoords(e)
    const now = performance.now()
    pointerDownRef.current = {
      nx,
      ny,
      lastNx: nx,
      lastNy: ny,
      lastSentTime: now,
      clientX: e.clientX,
      clientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      time: now,
      dragged: false,
      horizontalFired: false,
      active: true
    }

    if (session.device.engine === 'android') {
      send({ type: 'touch', action: 'down', nx, ny })
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session || !pointerDownRef.current?.active) return
    const { nx, ny } = getNormalizedCoords(e)

    if (session.device.engine === 'android') {
      send({ type: 'touch', action: 'move', nx, ny })
      return
    }

    // HarmonyOS NEXT low-latency gesture streaming:
    // - Horizontal swipe: fire ONE crisp fast swipe immediately once moved >= 36px horizontally,
    //   then lock `horizontalFired = true` so it reacts instantly without ever double-flipping!
    // - Vertical drag: stream responsive micro-swipes every ~75ms so scrolling tracks immediately.
    const state = pointerDownRef.current
    if (state.horizontalFired) return

    const now = performance.now()
    const dx = e.clientX - state.clientX
    const dy = e.clientY - state.clientY
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)

    if (!state.dragged && absDx >= 36 && absDx >= absDy * 1.2) {
      const dir = dx > 0 ? 1 : -1
      const targetNx = Math.max(0.05, Math.min(0.95, state.nx + dir * 0.42))
      send({
        type: 'swipe',
        nx1: state.nx,
        ny1: state.ny,
        nx2: targetNx,
        ny2: state.ny,
        speed: 10500
      })
      state.horizontalFired = true
      state.dragged = true
      return
    }

    const segDist = Math.hypot(e.clientX - state.lastClientX, e.clientY - state.lastClientY)
    const elapsed = now - state.lastSentTime

    if (absDy > absDx && segDist >= 26 && elapsed >= 75) {
      const speed = Math.round(Math.max(8000, Math.min(16000, (segDist / elapsed) * 6000)))
      send({
        type: 'swipe',
        nx1: state.lastNx,
        ny1: state.lastNy,
        nx2: nx,
        ny2: ny,
        speed
      })
      state.lastNx = nx
      state.lastNy = ny
      state.lastClientX = e.clientX
      state.lastClientY = e.clientY
      state.lastSentTime = now
      state.dragged = true
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session || !pointerDownRef.current?.active) return
    const start = pointerDownRef.current
    pointerDownRef.current = null
    const { nx, ny } = getNormalizedCoords(e)

    if (session.device.engine === 'android') {
      send({ type: 'touch', action: 'up', nx, ny })
      return
    }

    // Already fired a single crisp horizontal page flip during pointerMove
    if (start.horizontalFired) return

    // HarmonyOS NEXT gesture recognition: click / longClick / swipe
    const totalDist = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY)
    const remDist = Math.hypot(e.clientX - start.lastClientX, e.clientY - start.lastClientY)
    const durationMs = performance.now() - start.time

    if (!start.dragged && totalDist < 10) {
      if (durationMs >= 420) {
        send({ type: 'longClick', nx, ny })
      } else {
        send({ type: 'click', nx, ny })
      }
    } else if (!start.dragged) {
      const speed = Math.round(
        Math.max(8000, Math.min(16000, (totalDist / Math.max(30, durationMs)) * 6000))
      )
      send({ type: 'swipe', nx1: start.nx, ny1: start.ny, nx2: nx, ny2: ny, speed })
    } else if (remDist >= 18) {
      const segTime = Math.max(30, performance.now() - start.lastSentTime)
      const speed = Math.round(Math.max(8000, Math.min(16000, (remDist / segTime) * 6000)))
      send({ type: 'swipe', nx1: start.lastNx, ny1: start.lastNy, nx2: nx, ny2: ny, speed })
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!session) return
    const { nx, ny } = getNormalizedCoords(e)
    if (session.device.engine === 'android') {
      send({ type: 'scroll', nx, ny, deltaX: e.deltaX, deltaY: e.deltaY })
      return
    }

    // Coalesce rapid mouse-wheel ticks for HarmonyOS NEXT so scroll never queues up
    const acc = wheelAccRef.current
    acc.nx = nx
    acc.ny = ny
    acc.deltaX += e.deltaX
    acc.deltaY += e.deltaY
    if (acc.timer === null) {
      acc.timer = window.setTimeout(() => {
        send({ type: 'scroll', nx: acc.nx, ny: acc.ny, deltaX: acc.deltaX, deltaY: acc.deltaY })
        acc.deltaX = 0
        acc.deltaY = 0
        acc.timer = null
      }, 60)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (!session) return
    const mapped = KEY_EVENT_MAP[e.key]
    if (mapped) {
      e.preventDefault()
      send({ type: 'key', action: mapped })
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      send({ type: 'text', text: e.key })
    }
  }

  if (!session) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.08),_transparent_55%)] p-8 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl">
          <MonitorSmartphone className="h-8 w-8 text-sky-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">连接手机，在电脑上实时同屏与操控</h2>
        <p className="mt-2 max-w-md text-xs leading-relaxed text-slate-400">
          支持 <span className="text-sky-300">HarmonyOS NEXT (HDC)</span> 与{' '}
          <span className="text-emerald-300">Android / 鸿蒙 2-4 (ADB)</span>。
          在左侧设备列表中点击「开始投屏」即可显示手机画面，直接用鼠标点击、滑动、滚轮和键盘操控手机。
        </p>
        <div className="mt-6 flex items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <MousePointerClick className="h-3.5 w-3.5 text-sky-400" />
            左键点击/滑动 · 右键返回 · 中键主页 · 滚轮翻页
          </span>
        </div>
      </main>
    )
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-[#080a0f] p-5">
      {/* Top live status bar */}
      <div className="mb-3 flex items-center gap-3 rounded-full border border-slate-800/90 bg-slate-900/80 px-4 py-1.5 text-[11px] text-slate-300 backdrop-blur">
        <span
          className={`h-2 w-2 rounded-full ${
            streamState === 'streaming'
              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
              : streamState === 'error'
                ? 'bg-rose-400'
                : 'animate-pulse bg-amber-400'
          }`}
        />
        <span className="font-medium text-white">{meta?.deviceName ?? session.device.name}</span>
        {meta && (
          <>
            <span className="text-slate-600">|</span>
            <span className="text-sky-300">{meta.mode}</span>
            <span className="text-slate-600">|</span>
            <span className="font-mono text-slate-400">
              {meta.width}×{meta.height}
            </span>
            <span className="text-slate-600">|</span>
            <span className="font-mono text-emerald-300">{fps} FPS</span>
          </>
        )}
      </div>

      {/* Phone screen bezel & canvas */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative flex h-full max-h-full items-center justify-center rounded-[26px] border-[4px] border-slate-800 bg-black p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.75)]">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onContextMenu={(e) => e.preventDefault()}
            className="max-h-full max-w-full cursor-pointer rounded-[20px] bg-black object-contain outline-none"
            style={{ width: 'auto', height: '100%' }}
          />

          {streamState !== 'streaming' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center rounded-[20px] bg-slate-950/85 p-6 text-center backdrop-blur-sm">
              {streamState === 'connecting' && (
                <Loader2 className="mb-3 h-7 w-7 animate-spin text-sky-400" />
              )}
              <p
                className={`max-w-xs text-xs leading-relaxed ${
                  streamState === 'error' ? 'text-rose-300' : 'text-slate-300'
                }`}
              >
                {statusMessage || '正在初始化投屏画面...'}
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
