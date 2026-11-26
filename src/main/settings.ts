import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { AppSettings, DEFAULT_MIRROR_OPTIONS, SavedWifiDevice } from '@shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  hdcPath: '',
  adbPath: '',
  scrcpyServerPath: '',
  mirrorOptions: { ...DEFAULT_MIRROR_OPTIONS },
  savedWifiDevices: []
}

export class SettingsStore {
  private filePath: string
  private settings: AppSettings

  constructor(customFilePath?: string) {
    this.filePath = customFilePath ?? join(app.getPath('userData'), 'monitorsync-settings.json')
    this.settings = this.load()
  }

  private load(): AppSettings {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppSettings>
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          mirrorOptions: {
            ...DEFAULT_MIRROR_OPTIONS,
            ...(parsed.mirrorOptions ?? {})
          },
          savedWifiDevices: Array.isArray(parsed.savedWifiDevices)
            ? parsed.savedWifiDevices
            : []
        }
      }
    } catch {
      // Fallback to defaults if config file is corrupted
    }
    return {
      ...DEFAULT_SETTINGS,
      mirrorOptions: { ...DEFAULT_MIRROR_OPTIONS },
      savedWifiDevices: []
    }
  }

  private save(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8')
  }

  get(): AppSettings {
    return this.settings
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      mirrorOptions: {
        ...this.settings.mirrorOptions,
        ...(patch.mirrorOptions ?? {})
      }
    }
    this.save()
    return this.settings
  }

  rememberWifiDevice(entry: SavedWifiDevice): SavedWifiDevice[] {
    const filtered = this.settings.savedWifiDevices.filter(
      (item) => !(item.address === entry.address && item.engine === entry.engine)
    )
    this.settings.savedWifiDevices = [entry, ...filtered].slice(0, 12)
    this.save()
    return this.settings.savedWifiDevices
  }

  removeWifiDevice(address: string, engine: SavedWifiDevice['engine']): SavedWifiDevice[] {
    this.settings.savedWifiDevices = this.settings.savedWifiDevices.filter(
      (item) => !(item.address === address && item.engine === engine)
    )
    this.save()
    return this.settings.savedWifiDevices
  }
}
