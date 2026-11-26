import React, { useEffect, useState } from 'react'
import { FolderOpen, Settings, X } from 'lucide-react'
import { AppSettings, ToolStatus } from '@shared/types'

interface SettingsModalProps {
  open: boolean
  settings: AppSettings | null
  toolStatus: ToolStatus | null
  onClose: () => void
  onSaved: (settings: AppSettings) => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  toolStatus,
  onClose,
  onSaved
}) => {
  const [hdcPath, setHdcPath] = useState('')
  const [adbPath, setAdbPath] = useState('')
  const [scrcpyServerPath, setScrcpyServerPath] = useState('')
  const [maxSize, setMaxSize] = useState(1080)
  const [jpegScale, setJpegScale] = useState(0.5)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings) {
      setHdcPath(settings.hdcPath)
      setAdbPath(settings.adbPath)
      setScrcpyServerPath(settings.scrcpyServerPath)
      setMaxSize(settings.mirrorOptions.maxSize)
      setJpegScale(settings.mirrorOptions.jpegScale)
    }
  }, [settings, open])

  if (!open) return null

  const pick = async (title: string, setter: (v: string) => void): Promise<void> => {
    const file = await window.monitorSync.pickFile(title)
    if (file) setter(file)
  }

  const handleSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSaving(true)
    const updated = await window.monitorSync.updateSettings({
      hdcPath,
      adbPath,
      scrcpyServerPath,
      mirrorOptions: {
        ...(settings?.mirrorOptions ?? {
          maxSize: 1080,
          bitRate: 8_000_000,
          maxFps: 60,
          jpegScale: 0.5,
          turnScreenOff: false
        }),
        maxSize,
        jpegScale
      }
    })
    setSaving(false)
    onSaved(updated)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-[#121621] p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Settings className="h-4 w-4 text-sky-400" />
            工具路径与画质设置
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-sky-300">
                HarmonyOS NEXT `hdc.exe` 路径
              </label>
              <span
                className={`text-[11px] ${
                  toolStatus?.hdc.available ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {toolStatus?.hdc.available ? `已检测到 (${toolStatus.hdc.version})` : '未检测到'}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={hdcPath}
                onChange={(e) => setHdcPath(e.target.value)}
                placeholder="留空自动探测，或选择 DevEco Studio / toolchains/hdc.exe"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => pick('选择 hdc.exe', setHdcPath)}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs text-slate-200 hover:bg-slate-700"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                浏览
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-emerald-300">
                Android `adb.exe` 路径
              </label>
              <span
                className={`text-[11px] ${
                  toolStatus?.adb.available ? 'text-emerald-400' : 'text-slate-500'
                }`}
              >
                {toolStatus?.adb.available ? '已就绪' : '未检测到'}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={adbPath}
                onChange={(e) => setAdbPath(e.target.value)}
                placeholder="留空自动探测系统 Android SDK adb.exe"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => pick('选择 adb.exe', setAdbPath)}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs text-slate-200 hover:bg-slate-700"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                浏览
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">
                Android `scrcpy-server` 文件路径（仅 Android 需要）
              </label>
              <span
                className={`text-[11px] ${
                  toolStatus?.scrcpyServer.available ? 'text-emerald-400' : 'text-slate-500'
                }`}
              >
                {toolStatus?.scrcpyServer.available ? '已就绪' : '未放置'}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={scrcpyServerPath}
                onChange={(e) => setScrcpyServerPath(e.target.value)}
                placeholder="默认读取 resources/bin/scrcpy-server"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => pick('选择 scrcpy-server', setScrcpyServerPath)}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs text-slate-200 hover:bg-slate-700"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                浏览
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-slate-800 pt-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">鸿蒙流缩放比例</label>
              <select
                value={jpegScale}
                onChange={(e) => setJpegScale(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500"
              >
                <option value={0.35}>0.35x (极速流畅)</option>
                <option value={0.5}>0.5x (推荐平衡)</option>
                <option value={0.75}>0.75x (高清)</option>
                <option value={1}>1.0x (原画)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Android 最大分辨率</label>
              <select
                value={maxSize}
                onChange={(e) => setMaxSize(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500"
              >
                <option value={720}>720p (流畅)</option>
                <option value={1080}>1080p (推荐)</option>
                <option value={1440}>1440p (超清)</option>
                <option value={0}>原画质</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存并重新检测'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
