export type DeviceEngine = 'harmony-next' | 'android'

export type ConnectionType = 'usb' | 'wifi'

export type DeviceState = 'online' | 'unauthorized' | 'offline'

export interface DeviceInfo {
  id: string
  engine: DeviceEngine
  name: string
  model: string
  connection: ConnectionType
  state: DeviceState
  screenWidth?: number
  screenHeight?: number
  ipAddress?: string
}

export interface MirrorOptions {
  maxSize: number // e.g. 1080, 720, 0 (native)
  bitRate: number // bits per second for H.264, e.g. 8_000_000
  maxFps: number // e.g. 60 for scrcpy, 20 for hdc
  jpegScale: number // 0.3 ~ 1.0 for HarmonyOS NEXT
  turnScreenOff: boolean
}

export const DEFAULT_MIRROR_OPTIONS: MirrorOptions = {
  maxSize: 1080,
  bitRate: 8_000_000,
  maxFps: 60,
  jpegScale: 0.5,
  turnScreenOff: false
}

export interface SavedWifiDevice {
  address: string // host:port
  engine: DeviceEngine
  label: string
  lastConnectedAt: number
}

export interface AppSettings {
  hdcPath: string
  adbPath: string
  scrcpyServerPath: string
  mirrorOptions: MirrorOptions
  savedWifiDevices: SavedWifiDevice[]
}

export interface ToolStatus {
  hdc: { available: boolean; path: string; version?: string }
  adb: { available: boolean; path: string; version?: string }
  scrcpyServer: { available: boolean; path: string }
}

export type SystemKeyAction =
  | 'wake'
  | 'back'
  | 'home'
  | 'recents'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'enter'
  | 'backspace'
  | 'escape'
  | 'tab'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'

export type ControlMessage =
  | { type: 'touch'; action: 'down' | 'move' | 'up'; nx: number; ny: number }
  | { type: 'click'; nx: number; ny: number }
  | { type: 'longClick'; nx: number; ny: number }
  | { type: 'swipe'; nx1: number; ny1: number; nx2: number; ny2: number; speed?: number }
  | { type: 'scroll'; nx: number; ny: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: SystemKeyAction }
  | { type: 'text'; text: string }

export type StreamCodec = 'jpeg' | 'h264'

export interface StreamMetaMessage {
  type: 'meta'
  deviceId: string
  deviceName: string
  engine: DeviceEngine
  codec: StreamCodec
  width: number
  height: number
  mode: string
}

export interface StreamStatusMessage {
  type: 'status'
  state: 'connecting' | 'streaming' | 'stopped' | 'error'
  message?: string
}

export type ServerTextMessage = StreamMetaMessage | StreamStatusMessage

export const FRAME_TYPE_JPEG = 0x01
export const FRAME_TYPE_H264_CONFIG = 0x02
export const FRAME_TYPE_H264_KEYFRAME = 0x03
export const FRAME_TYPE_H264_DELTA = 0x04

export interface StartSessionResult {
  sessionId: string
  wsPort: number
  device: DeviceInfo
}
