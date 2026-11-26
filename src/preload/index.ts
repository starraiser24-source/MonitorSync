import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  DeviceEngine,
  DeviceInfo,
  MirrorOptions,
  StartSessionResult,
  ToolStatus
} from '@shared/types'

const api = {
  getToolStatus: (): Promise<ToolStatus> => ipcRenderer.invoke('tools:status'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  pickFile: (title: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickFile', title),
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:list'),
  connectWifi: (
    engine: DeviceEngine,
    address: string,
    label?: string
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('wifi:connect', engine, address, label),
  disconnectWifi: (
    engine: DeviceEngine,
    address: string
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('wifi:disconnect', engine, address),
  removeSavedWifi: (engine: DeviceEngine, address: string) =>
    ipcRenderer.invoke('wifi:removeSaved', engine, address),
  enableWifiFromUsb: (
    engine: DeviceEngine,
    deviceId: string
  ): Promise<{ ok: boolean; address?: string; message: string }> =>
    ipcRenderer.invoke('wifi:enableFromUsb', engine, deviceId),
  pairAdbWifi: (address: string, code: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('wifi:pairAdb', address, code),
  startSession: (
    device: DeviceInfo,
    options?: Partial<MirrorOptions>
  ): Promise<StartSessionResult> => ipcRenderer.invoke('session:start', device, options),
  stopSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:stop', sessionId),
  saveScreenshot: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('session:screenshot', sessionId)
}

contextBridge.exposeInMainWorld('monitorSync', api)

export type MonitorSyncApi = typeof api
