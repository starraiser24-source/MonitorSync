import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { DeviceInfo, MirrorOptions } from '@shared/types'
import { SettingsStore } from '../settings'
import { DeviceDriver, MirrorSession } from './driver'
import { parseWlanIp } from './hdc-utils'
import { parseAdbDevices } from './scrcpy-protocol'
import { ScrcpyMirrorSession } from './scrcpy-session'

const execFileAsync = promisify(execFile)

function getCandidateAdbPaths(customPath: string): string[] {
  const candidates: string[] = []
  if (customPath.trim()) candidates.push(customPath.trim())
  candidates.push(join(process.cwd(), 'resources', 'bin', 'adb.exe'))
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'bin', 'adb.exe'))
  }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData) {
    candidates.push(join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'))
  }
  candidates.push('adb')
  return candidates
}

export class AdbDriver implements DeviceDriver {
  readonly engine = 'android' as const
  private cachedAdbPath: string | null = null

  constructor(private settingsStore: SettingsStore) {}

  invalidateCache(): void {
    this.cachedAdbPath = null
  }

  async resolveBinary(): Promise<{ available: boolean; path: string; version?: string }> {
    const custom = this.settingsStore.get().adbPath
    for (const candidate of getCandidateAdbPaths(custom)) {
      if (candidate !== 'adb' && !existsSync(candidate)) continue
      try {
        const { stdout } = await execFileAsync(candidate, ['version'], {
          timeout: 3000,
          windowsHide: true
        })
        const version = stdout.trim().split(/\r?\n/)[0] || 'adb'
        this.cachedAdbPath = candidate
        return { available: true, path: candidate, version }
      } catch {
        // try next
      }
    }
    return { available: false, path: custom || 'adb' }
  }

  resolveScrcpyServer(): { available: boolean; path: string } {
    const custom = this.settingsStore.get().scrcpyServerPath
    const candidates = [
      custom.trim(),
      join(process.cwd(), 'resources', 'bin', 'scrcpy-server'),
      join(process.cwd(), 'resources', 'bin', 'scrcpy-server.jar'),
      process.resourcesPath ? join(process.resourcesPath, 'bin', 'scrcpy-server') : ''
    ].filter(Boolean)

    for (const p of candidates) {
      if (existsSync(p)) {
        return { available: true, path: p }
      }
    }
    return { available: false, path: custom || join(process.cwd(), 'resources', 'bin', 'scrcpy-server') }
  }

  private async getAdbBin(): Promise<string> {
    if (this.cachedAdbPath) return this.cachedAdbPath
    const res = await this.resolveBinary()
    if (!res.available) {
      throw new Error('未检测到 adb.exe，请在「设置」中配置 Android platform-tools 的 adb 路径')
    }
    return res.path
  }

  async runAdb(args: string[], timeout = 8000): Promise<string> {
    const bin = await this.getAdbBin()
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return (stdout || stderr || '').trim()
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const check = await this.resolveBinary()
    if (!check.available) return []

    try {
      const output = await this.runAdb(['devices', '-l'], 4000)
      const parsed = parseAdbDevices(output)
      return parsed.map((d) => ({
        id: d.id,
        engine: 'android',
        name: d.model,
        model: d.model,
        connection: d.connection,
        state: d.state
      }))
    } catch {
      return []
    }
  }

  async connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    try {
      const normalized = address.includes(':') ? address.trim() : `${address.trim()}:5555`
      const out = await this.runAdb(['connect', normalized], 10000)
      const ok = out.toLowerCase().includes('connected to')
      return { ok, message: out || (ok ? `已连接 ${normalized}` : '连接失败') }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async disconnectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    try {
      const out = await this.runAdb(['disconnect', address], 5000)
      return { ok: true, message: out || '已断开连接' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async pairWifi(address: string, code: string): Promise<{ ok: boolean; message: string }> {
    try {
      const out = await this.runAdb(['pair', address.trim(), code.trim()], 15000)
      const ok = out.toLowerCase().includes('successfully paired')
      return { ok, message: out || (ok ? '配对成功' : '配对失败') }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async enableWifiFromUsb(
    deviceId: string,
    port = 5555
  ): Promise<{ ok: boolean; address?: string; message: string }> {
    try {
      const ipOut = await this.runAdb(['-s', deviceId, 'shell', 'ip addr show wlan0'], 4000).catch(
        () => ''
      )
      const ip = parseWlanIp(ipOut)
      if (!ip) {
        return { ok: false, message: '无法获取手机 Wi-Fi IP 地址，请确认手机与电脑在同一局域网' }
      }

      await this.runAdb(['-s', deviceId, 'tcpip', String(port)], 6000)
      await new Promise((r) => setTimeout(r, 1200))
      const address = `${ip}:${port}`
      const conn = await this.connectWifi(address)
      return {
        ok: conn.ok,
        address: conn.ok ? address : undefined,
        message: conn.ok ? `已切换至无线连接 (${address})，现在可以拔掉数据线` : conn.message
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  createSession(sessionId: string, device: DeviceInfo, options: MirrorOptions): MirrorSession {
    return new ScrcpyMirrorSession(
      sessionId,
      device,
      options,
      () => this.getAdbBin(),
      () => this.resolveScrcpyServer()
    )
  }
}
