import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  AppSettings,
  DeviceEngine,
  DeviceInfo,
  MirrorOptions,
  StartSessionResult,
  ToolStatus
} from '@shared/types'
import { AdbDriver } from './drivers/adb-manager'
import { MirrorSession } from './drivers/driver'
import { HdcDriver } from './drivers/hdc-manager'
import { SettingsStore } from './settings'
import { StreamServer } from './ws/stream-server'

let mainWindow: BrowserWindow | null = null
let settingsStore: SettingsStore
let hdcDriver: HdcDriver
let adbDriver: AdbDriver
let streamServer: StreamServer
const activeSessions = new Map<string, MirrorSession>()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#0b0d12',
    title: 'MonitorSync — 电脑手机同屏与反控',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('tools:status', async (): Promise<ToolStatus> => {
    const [hdc, adb] = await Promise.all([hdcDriver.resolveBinary(), adbDriver.resolveBinary()])
    const scrcpyServer = adbDriver.resolveScrcpyServer()
    return { hdc, adb, scrcpyServer }
  })

  ipcMain.handle('settings:get', (): AppSettings => settingsStore.get())

  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>): AppSettings => {
    const updated = settingsStore.update(patch)
    hdcDriver.invalidateCache()
    adbDriver.invalidateCache()
    return updated
  })

  ipcMain.handle('dialog:pickFile', async (_event, title: string): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title,
      properties: ['openFile']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('devices:list', async (): Promise<DeviceInfo[]> => {
    const [harmonyDevices, androidDevices] = await Promise.all([
      hdcDriver.listDevices(),
      adbDriver.listDevices()
    ])
    return [...harmonyDevices, ...androidDevices]
  })

  ipcMain.handle(
    'wifi:connect',
    async (_event, engine: DeviceEngine, address: string, label?: string) => {
      const driver = engine === 'harmony-next' ? hdcDriver : adbDriver
      const res = await driver.connectWifi(address)
      if (res.ok) {
        const normalized = address.includes(':') ? address.trim() : `${address.trim()}:5555`
        settingsStore.rememberWifiDevice({
          address: normalized,
          engine,
          label: label?.trim() || normalized,
          lastConnectedAt: Date.now()
        })
      }
      return res
    }
  )

  ipcMain.handle('wifi:disconnect', async (_event, engine: DeviceEngine, address: string) => {
    const driver = engine === 'harmony-next' ? hdcDriver : adbDriver
    return driver.disconnectWifi(address)
  })

  ipcMain.handle('wifi:removeSaved', (_event, engine: DeviceEngine, address: string) => {
    return settingsStore.removeWifiDevice(address, engine)
  })

  ipcMain.handle('wifi:enableFromUsb', async (_event, engine: DeviceEngine, deviceId: string) => {
    const driver = engine === 'harmony-next' ? hdcDriver : adbDriver
    const res = await driver.enableWifiFromUsb(deviceId, 5555)
    if (res.ok && res.address) {
      settingsStore.rememberWifiDevice({
        address: res.address,
        engine,
        label: deviceId,
        lastConnectedAt: Date.now()
      })
    }
    return res
  })

  ipcMain.handle('wifi:pairAdb', async (_event, address: string, code: string) => {
    return adbDriver.pairWifi(address, code)
  })

  ipcMain.handle(
    'session:start',
    async (_event, device: DeviceInfo, options?: Partial<MirrorOptions>): Promise<StartSessionResult> => {
      // Stop any existing session for the same device
      for (const [sid, existing] of activeSessions.entries()) {
        if (existing.device.id === device.id && existing.device.engine === device.engine) {
          await existing.stop()
          activeSessions.delete(sid)
        }
      }

      const sessionId = randomUUID()
      const mergedOptions: MirrorOptions = {
        ...settingsStore.get().mirrorOptions,
        ...(options ?? {})
      }

      const driver = device.engine === 'harmony-next' ? hdcDriver : adbDriver
      const session = driver.createSession(sessionId, device, mergedOptions)
      activeSessions.set(sessionId, session)
      streamServer.attachSession(session)

      session.once('close', () => {
        activeSessions.delete(sessionId)
      })

      void session.start()

      return {
        sessionId,
        wsPort: streamServer.getPort(),
        device
      }
    }
  )

  ipcMain.handle('session:stop', async (_event, sessionId: string) => {
    const session = activeSessions.get(sessionId)
    if (session) {
      await session.stop()
      activeSessions.delete(sessionId)
    }
  })

  ipcMain.handle('session:screenshot', async (_event, sessionId: string) => {
    const session = activeSessions.get(sessionId)
    if (!session) return { ok: false, message: '当前没有运行中的投屏会话' }

    try {
      const buffer = await session.takeScreenshot()
      const ext = session.device.engine === 'harmony-next' ? 'jpeg' : 'png'
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存手机截图',
        defaultPath: `MonitorSync_${Date.now()}.${ext}`,
        filters: [{ name: 'Image', extensions: [ext] }]
      })
      if (canceled || !filePath) return { ok: false, message: '已取消保存' }
      writeFileSync(filePath, buffer)
      return { ok: true, message: `截图已保存至 ${filePath}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}

app.whenReady().then(async () => {
  settingsStore = new SettingsStore()
  hdcDriver = new HdcDriver(settingsStore)
  adbDriver = new AdbDriver(settingsStore)
  streamServer = new StreamServer()
  await streamServer.start()

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void streamServer?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
