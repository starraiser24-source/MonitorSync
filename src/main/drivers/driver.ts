import { EventEmitter } from 'events'
import {
  ControlMessage,
  DeviceEngine,
  DeviceInfo,
  MirrorOptions,
  StreamCodec
} from '@shared/types'

export interface MirrorSessionEvents {
  meta: (meta: {
    deviceId: string
    deviceName: string
    engine: DeviceEngine
    codec: StreamCodec
    width: number
    height: number
    mode: string
  }) => void
  frame: (frameType: number, payload: Buffer) => void
  status: (state: 'connecting' | 'streaming' | 'stopped' | 'error', message?: string) => void
  close: () => void
}

export interface MirrorSession extends EventEmitter {
  readonly sessionId: string
  readonly device: DeviceInfo
  start(): Promise<void>
  stop(): Promise<void>
  handleControl(message: ControlMessage): void
  takeScreenshot(): Promise<Buffer>
}

export interface DeviceDriver {
  readonly engine: DeviceEngine
  resolveBinary(): Promise<{ available: boolean; path: string; version?: string }>
  listDevices(): Promise<DeviceInfo[]>
  connectWifi(address: string): Promise<{ ok: boolean; message: string }>
  disconnectWifi(address: string): Promise<{ ok: boolean; message: string }>
  enableWifiFromUsb(deviceId: string, port?: number): Promise<{ ok: boolean; address?: string; message: string }>
  pairWifi?(address: string, code: string): Promise<{ ok: boolean; message: string }>
  createSession(sessionId: string, device: DeviceInfo, options: MirrorOptions): MirrorSession
}
