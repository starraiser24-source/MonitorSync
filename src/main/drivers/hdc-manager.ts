import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { DeviceInfo, MirrorOptions } from '@shared/types'
import { SettingsStore } from '../settings'
import { DeviceDriver, MirrorSession } from './driver'
import { HdcMirrorSession } from './hdc-session'
import { parseHdcScreenSize, parseHdcTargets, parseWlanIp } from './hdc-utils'

const execFileAsync = promisify(execFile)

function getCandidateHdcPaths(customPath: string): string[] {
  const candidates: string[] = []
  if (customPath.trim()) {
    candidates.push(customPath.trim())
  }
  candidates.push(join(process.cwd(), 'resources', 'bin', 'hdc.exe'))
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'bin', 'hdc.exe'))
  }

  const localAppData = process.env.LOCALAPPDATA ?? ''
  const userProfile = process.env.USERPROFILE ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'

  candidates.push(
    join(programFiles, 'Huawei', 'DevEco Studio', 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe'),
    join(localAppData, 'Huawei', 'Sdk', 'openharmony', 'toolchains', 'hdc.exe'),
    join(userProfile, 'AppData', 'Local', 'OpenHarmony', 'Sdk', 'toolchains', 'hdc.exe'),
    'D:\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe',
    'E:\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe',
    'hdc'
  )

  return candidates
}

export class HdcDriver implements DeviceDriver {
  readonly engine = 'harmony-next' as const
  private cachedPath: string | null = null

  constructor(private settingsStore: SettingsStore) {}

  invalidateCache(): void {
    this.cachedPath = null
  }

  async resolveBinary(): Promise<{ available: boolean; path: string; version?: string }> {
    const custom = this.settingsStore.get().hdcPath
    const candidates = getCandidateHdcPaths(custom)

    for (const candidate of candidates) {
      if (candidate !== 'hdc' && !existsSync(candidate)) continue
      try {
        const { stdout } = await execFileAsync(candidate, ['-v'], {
          timeout: 3000,
          windowsHide: true
        })
        const version = stdout.trim().split(/\r?\n/)[0] || 'hdc'
        this.cachedPath = candidate
        return { available: true, path: candidate, version }
      } catch {
        // Try next candidate
      }
    }

    return { available: false, path: custom || 'hdc' }
  }

  private async getHdcBin(): Promise<string> {
    if (this.cachedPath) return this.cachedPath
    const res = await this.resolveBinary()
    if (!res.available) {
      throw new Error('未检测到 hdc.exe，请在右上角「设置」中配置 HarmonyOS Command Line Tools / DevEco Studio 的 hdc 路径')
    }
    return res.path
  }

  async runHdc(args: string[], timeout = 8000): Promise<string> {
    const bin = await this.getHdcBin()
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
      const output = await this.runHdc(['list', 'targets', '-v'], 4000)
      const targets = parseHdcTargets(output)
      const devices: DeviceInfo[] = []

      for (const target of targets) {
        let model = 'HarmonyOS NEXT'
        let name = target.id
        let screenWidth: number | undefined
        let screenHeight: number | undefined

        if (target.state === 'online') {
          try {
            const [modelOut, nameOut, screenOut] = await Promise.all([
              this.runHdc(['-t', target.id, 'shell', 'param get const.product.model'], 2500).catch(
                () => ''
              ),
              this.runHdc(['-t', target.id, 'shell', 'param get const.product.name'], 2500).catch(
                () => ''
              ),
              this.runHdc(
                ['-t', target.id, 'shell', 'hidumper -s RenderService -a screen'],
                3000
              ).catch(() => '')
            ])
            const isValidProp = (val: string): boolean =>
              val.length > 0 && !val.startsWith('[Fail]') && !val.includes('Device not found')
            const cleanModel = modelOut.trim()
            const cleanName = nameOut.trim()
            if (isValidProp(cleanModel)) model = cleanModel
            if (isValidProp(cleanName)) name = cleanName
            else if (isValidProp(cleanModel)) name = cleanModel
            const dims = parseHdcScreenSize(screenOut)
            if (dims) {
              screenWidth = dims.width
              screenHeight = dims.height
            }
          } catch {
            // Keep default metadata
          }
        }

        devices.push({
          id: target.id,
          engine: 'harmony-next',
          name,
          model,
          connection: target.connection,
          state: target.state,
          screenWidth,
          screenHeight
        })
      }

      return devices
    } catch {
      return []
    }
  }

  async connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    try {
      const normalized = address.includes(':') ? address.trim() : `${address.trim()}:5555`
      const out = await this.runHdc(['tconn', normalized], 10000)
      const ok = !out.toLowerCase().includes('fail') && !out.toLowerCase().includes('error')
      return { ok, message: out || (ok ? `已连接 ${normalized}` : '连接失败') }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async disconnectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    try {
      const out = await this.runHdc(['tconn', address, '-remove'], 5000)
      return { ok: true, message: out || '已断开无线连接' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async enableWifiFromUsb(
    deviceId: string,
    port = 5555
  ): Promise<{ ok: boolean; address?: string; message: string }> {
    try {
      const ipOut = await this.runHdc(['-t', deviceId, 'shell', 'ifconfig wlan0'], 4000).catch(
        () => ''
      )
      const ip = parseWlanIp(ipOut)
      if (!ip) {
        return {
          ok: false,
          message: '无法获取手机 Wi-Fi IP 地址，请确认手机与电脑处于同一局域网 Wi-Fi'
        }
      }

      await this.runHdc(['-t', deviceId, 'tmode', 'port', String(port)], 6000)
      // Give the device daemon a brief moment to switch to TCP listen mode
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
    return new HdcMirrorSession(sessionId, device, options, () => this.getHdcBin())
  }
}
