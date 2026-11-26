import { ControlMessage, SystemKeyAction } from '@shared/types'

export interface ParsedHdcTarget {
  id: string
  connection: 'usb' | 'wifi'
  state: 'online' | 'offline' | 'unauthorized'
}

/**
 * Parse output of `hdc list targets -v` or `hdc list targets`.
 * Examples:
 *   "2LQ0224123000123\tUSB\tConnected\tlocalhost"
 *   "192.168.1.50:5555\tTCP\tConnected\tlocalhost"
 *   "2LQ0224123000123"
 *   "[Empty]"
 */
export function parseHdcTargets(output: string): ParsedHdcTarget[] {
  const results: ParsedHdcTarget[] = []
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '[Empty]' && !l.startsWith('['))

  for (const line of lines) {
    const parts = line.split(/\s+/)
    const id = parts[0]
    if (!id || id.toLowerCase() === 'empty') continue

    const connRaw = (parts[1] ?? '').toUpperCase()
    const stateRaw = (parts[2] ?? 'Connected').toLowerCase()

    // Filter out Windows/Linux serial UART ports (e.g. COM3 UART Ready unknown...)
    if (connRaw === 'UART' || /^COM\d+$/i.test(id)) continue

    const isWifi = connRaw === 'TCP' || /^\d+\.\d+\.\d+\.\d+:\d+$/.test(id)
    let state: ParsedHdcTarget['state'] = 'online'
    if (stateRaw.includes('offline') || stateRaw.includes('disconnect') || stateRaw.includes('unknown')) {
      state = 'offline'
    } else if (stateRaw.includes('unauth')) {
      state = 'unauthorized'
    }

    results.push({
      id,
      connection: isWifi ? 'wifi' : 'usb',
      state
    })
  }
  return results
}

/**
 * Parse physical screen dimensions from `hidumper -s RenderService -a screen`
 * or fallback formats like `1260x2720`.
 */
export function parseHdcScreenSize(output: string): { width: number; height: number } | null {
  const patterns = [
    /physical\s+screen\s+resolution\s*:\s*(\d+)\s*[x×]\s*(\d+)/i,
    /activeMode\s*:\s*(\d+)\s*[x×]\s*(\d+)/i,
    /render\s+size\s*:\s*(\d+)\s*[x×]\s*(\d+)/i,
    /width\s*:\s*(\d+)[,\s]+height\s*:\s*(\d+)/i,
    /\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/
  ]

  for (const regex of patterns) {
    const match = output.match(regex)
    if (match) {
      const width = Number.parseInt(match[1], 10)
      const height = Number.parseInt(match[2], 10)
      if (width >= 200 && height >= 200) {
        return { width, height }
      }
    }
  }
  return null
}

/**
 * Parse IPv4 address from `ifconfig wlan0` or `ip addr show wlan0`.
 */
export function parseWlanIp(output: string): string | null {
  const match = output.match(/inet(?:\s+addr)?[:\s]+(\d{1,3}(?:\.\d{1,3}){3})/)
  if (match && match[1] && !match[1].startsWith('127.')) {
    return match[1]
  }
  return null
}

export const OHOS_KEYCODE_NUM: Record<SystemKeyAction, number> = {
  wake: 18,
  back: 2,
  home: 1,
  power: 18,
  recents: 2078,
  volumeUp: 16,
  volumeDown: 17,
  enter: 2054,
  backspace: 2055,
  escape: 2070,
  tab: 2049,
  arrowUp: 2012,
  arrowDown: 2013,
  arrowLeft: 2014,
  arrowRight: 2015
}

const OHOS_KEY_MAP: Record<SystemKeyAction, string> = {
  wake: 'Power',
  back: 'Back',
  home: 'Home',
  power: 'Power',
  recents: '2078',
  volumeUp: '16',
  volumeDown: '17',
  enter: '2054',
  backspace: '2055',
  escape: '2070',
  tab: '2049',
  arrowUp: '2012',
  arrowDown: '2013',
  arrowLeft: '2014',
  arrowRight: '2015'
}

function clampCoord(norm: number, max: number): number {
  const clamped = Math.max(0, Math.min(1, norm))
  return Math.round(clamped * Math.max(1, max - 1))
}

function escapeShellDoubleQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

/**
 * Convert a normalized ControlMessage into a HarmonyOS NEXT `uitest uiInput` shell command.
 */
export function buildUiInputCommand(
  msg: ControlMessage,
  width: number,
  height: number
): string | null {
  switch (msg.type) {
    case 'click': {
      const x = clampCoord(msg.nx, width)
      const y = clampCoord(msg.ny, height)
      return `uitest uiInput click ${x} ${y}`
    }
    case 'longClick': {
      const x = clampCoord(msg.nx, width)
      const y = clampCoord(msg.ny, height)
      return `uitest uiInput longClick ${x} ${y}`
    }
    case 'swipe': {
      const x1 = clampCoord(msg.nx1, width)
      const y1 = clampCoord(msg.ny1, height)
      const x2 = clampCoord(msg.nx2, width)
      const y2 = clampCoord(msg.ny2, height)
      const speed = Math.max(200, Math.min(40000, Math.round(msg.speed ?? 1800)))
      return `uitest uiInput swipe ${x1} ${y1} ${x2} ${y2} ${speed}`
    }
    case 'scroll': {
      const x1 = clampCoord(msg.nx, width)
      const y1 = clampCoord(msg.ny, height)
      const stepY = Math.round(Math.max(-0.35, Math.min(0.35, -msg.deltaY / 400)) * height)
      const stepX = Math.round(Math.max(-0.35, Math.min(0.35, -msg.deltaX / 400)) * width)
      const x2 = Math.max(0, Math.min(width - 1, x1 + stepX))
      const y2 = Math.max(0, Math.min(height - 1, y1 + stepY))
      if (x1 === x2 && y1 === y2) return null
      return `uitest uiInput swipe ${x1} ${y1} ${x2} ${y2} 1500`
    }
    case 'key': {
      const code = OHOS_KEY_MAP[msg.action]
      if (!code) return null
      return `uitest uiInput keyEvent ${code}`
    }
    case 'text': {
      if (!msg.text) return null
      const safe = escapeShellDoubleQuoted(msg.text)
      return `uitest uiInput text "${safe}"`
    }
    case 'touch':
      // Continuous pointer events are aggregated into click/longClick/swipe by the client
      return null
  }
}

/**
 * Extract complete JPEG frames (0xFFD8 ... 0xFFD9) from a continuous byte stream.
 */
export function extractJpegFrames(buffer: Buffer): { frames: Buffer[]; remainder: Buffer } {
  const frames: Buffer[] = []
  let offset = 0

  while (offset < buffer.length - 1) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), offset)
    if (start === -1) {
      return { frames, remainder: Buffer.alloc(0) }
    }
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
    if (end === -1) {
      return { frames, remainder: buffer.subarray(start) }
    }
    frames.push(Buffer.from(buffer.subarray(start, end + 2)))
    offset = end + 2
  }

  return { frames, remainder: offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0) }
}
