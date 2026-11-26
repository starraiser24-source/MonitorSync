import { SystemKeyAction } from '@shared/types'

export const SCRCPY_CONTROL_TYPE_KEYCODE = 0
export const SCRCPY_CONTROL_TYPE_TEXT = 1
export const SCRCPY_CONTROL_TYPE_TOUCH = 2
export const SCRCPY_CONTROL_TYPE_SCROLL = 3
export const SCRCPY_CONTROL_TYPE_SCREEN_POWER = 10

export const ANDROID_MOTION_ACTION_DOWN = 0
export const ANDROID_MOTION_ACTION_UP = 1
export const ANDROID_MOTION_ACTION_MOVE = 2

export const ANDROID_KEY_ACTION_DOWN = 0
export const ANDROID_KEY_ACTION_UP = 1

export const ANDROID_KEYCODE_MAP: Record<SystemKeyAction, number> = {
  wake: 224, // KEYCODE_WAKEUP
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  tab: 61,
  enter: 66,
  backspace: 67,
  escape: 111,
  recents: 187,
  arrowUp: 19,
  arrowDown: 20,
  arrowLeft: 21,
  arrowRight: 22
}

export function serializeTouchEvent(params: {
  action: number
  x: number
  y: number
  width: number
  height: number
  pointerId?: bigint
  pressure?: number
}): Buffer {
  const buf = Buffer.alloc(32)
  buf.writeUInt8(SCRCPY_CONTROL_TYPE_TOUCH, 0)
  buf.writeUInt8(params.action, 1)
  buf.writeBigInt64BE(params.pointerId ?? -2n, 2) // POINTER_ID_GENERIC_FINGER = -2
  buf.writeInt32BE(Math.max(0, Math.round(params.x)), 10)
  buf.writeInt32BE(Math.max(0, Math.round(params.y)), 14)
  buf.writeUInt16BE(Math.max(1, Math.round(params.width)), 18)
  buf.writeUInt16BE(Math.max(1, Math.round(params.height)), 20)
  const pressureInt =
    params.action === ANDROID_MOTION_ACTION_UP
      ? 0
      : Math.round(Math.max(0, Math.min(1, params.pressure ?? 1)) * 0xffff)
  buf.writeUInt16BE(pressureInt, 22)
  buf.writeUInt32BE(1, 24) // AMOTION_EVENT_BUTTON_PRIMARY
  buf.writeUInt32BE(params.action === ANDROID_MOTION_ACTION_UP ? 0 : 1, 28)
  return buf
}

export function serializeKeycodeEvent(action: number, keycode: number, metaState = 0): Buffer {
  const buf = Buffer.alloc(14)
  buf.writeUInt8(SCRCPY_CONTROL_TYPE_KEYCODE, 0)
  buf.writeUInt8(action, 1)
  buf.writeInt32BE(keycode, 2)
  buf.writeInt32BE(0, 6) // repeat
  buf.writeInt32BE(metaState, 10)
  return buf
}

export function serializeTextEvent(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf-8')
  const buf = Buffer.alloc(5 + utf8.length)
  buf.writeUInt8(SCRCPY_CONTROL_TYPE_TEXT, 0)
  buf.writeUInt32BE(utf8.length, 1)
  utf8.copy(buf, 5)
  return buf
}

export function serializeScrollEvent(params: {
  x: number
  y: number
  width: number
  height: number
  hScroll: number
  vScroll: number
}): Buffer {
  const buf = Buffer.alloc(21)
  buf.writeUInt8(SCRCPY_CONTROL_TYPE_SCROLL, 0)
  buf.writeInt32BE(Math.max(0, Math.round(params.x)), 1)
  buf.writeInt32BE(Math.max(0, Math.round(params.y)), 5)
  buf.writeUInt16BE(Math.max(1, Math.round(params.width)), 9)
  buf.writeUInt16BE(Math.max(1, Math.round(params.height)), 11)
  // Fixed-point 16-bit signed (-1..1 mapped to -32768..32767)
  const clampI16 = (v: number): number =>
    Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, v)) * 32767)))
  buf.writeInt16BE(clampI16(params.hScroll), 13)
  buf.writeInt16BE(clampI16(params.vScroll), 15)
  buf.writeUInt32BE(0, 17)
  return buf
}

export function parseAdbDevices(
  output: string
): Array<{ id: string; state: 'online' | 'unauthorized' | 'offline'; model: string; connection: 'usb' | 'wifi' }> {
  const lines = output.split(/\r?\n/).slice(1)
  const devices: Array<{
    id: string
    state: 'online' | 'unauthorized' | 'offline'
    model: string
    connection: 'usb' | 'wifi'
  }> = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const id = parts[0]
    const rawState = parts[1]
    if (!id || !rawState) continue

    let state: 'online' | 'unauthorized' | 'offline' = 'offline'
    if (rawState === 'device') state = 'online'
    else if (rawState === 'unauthorized') state = 'unauthorized'

    const modelPart = parts.find((p) => p.startsWith('model:'))
    const model = modelPart ? modelPart.slice('model:'.length).replace(/_/g, ' ') : 'Android Device'
    const connection: 'usb' | 'wifi' = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(id) ? 'wifi' : 'usb'

    devices.push({ id, state, model, connection })
  }

  return devices
}
