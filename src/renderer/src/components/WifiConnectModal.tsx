import React, { useState } from 'react'
import { Trash2, Wifi, X } from 'lucide-react'
import { DeviceEngine, SavedWifiDevice } from '@shared/types'

interface WifiConnectModalProps {
  open: boolean
  savedDevices: SavedWifiDevice[]
  onClose: () => void
  onConnected: () => void
}

export const WifiConnectModal: React.FC<WifiConnectModalProps> = ({
  open,
  savedDevices,
  onClose,
  onConnected
}) => {
  const [engine, setEngine] = useState<DeviceEngine>('harmony-next')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [pairMode, setPairMode] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!address.trim()) return
    setLoading(true)
    setFeedback(null)

    try {
      const res =
        engine === 'android' && pairMode
          ? await window.monitorSync.pairAdbWifi(address, pairCode)
          : await window.monitorSync.connectWifi(engine, address, label)
      setFeedback({ ok: res.ok, text: res.message })
      if (res.ok) {
        onConnected()
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }

  const handleQuickConnect = async (item: SavedWifiDevice): Promise<void> => {
    setLoading(true)
    setFeedback(null)
    const res = await window.monitorSync.connectWifi(item.engine, item.address, item.label)
    setFeedback({ ok: res.ok, text: res.message })
    setLoading(false)
    if (res.ok) onConnected()
  }

  const handleRemove = async (item: SavedWifiDevice): Promise<void> => {
    await window.monitorSync.removeSavedWifi(item.engine, item.address)
    onConnected()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#121621] p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Wifi className="h-4 w-4 text-sky-400" />
            Wi-Fi 无线连接
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Engine switch */}
        <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-xl bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => {
              setEngine('harmony-next')
              setPairMode(false)
            }}
            className={`rounded-lg py-1.5 text-xs font-medium transition ${
              engine === 'harmony-next'
                ? 'bg-sky-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            HarmonyOS NEXT (HDC)
          </button>
          <button
            type="button"
            onClick={() => setEngine('android')}
            className={`rounded-lg py-1.5 text-xs font-medium transition ${
              engine === 'android'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Android / 鸿蒙 2-4 (ADB)
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              手机 IP 地址与端口（默认 5555）
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="例如 192.168.1.88:5555"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
            />
          </div>

          {engine === 'android' && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={pairMode}
                onChange={(e) => setPairMode(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900"
              />
              使用 Android 11+ 无线调试配对码 (adb pair)
            </label>
          )}

          {engine === 'android' && pairMode ? (
            <div>
              <label className="mb-1 block text-xs text-slate-400">6 位配对码</label>
              <input
                type="text"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
                placeholder="输入手机无线调试显示的配对码"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-slate-400">备注名称（可选）</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如 Mate 70 Pro"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500"
              />
            </div>
          )}

          {feedback && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                feedback.ok
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-rose-500/15 text-rose-300'
              }`}
            >
              {feedback.text}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !address.trim()}
            className="w-full rounded-lg bg-sky-600 py-2 text-xs font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            {loading ? '连接中...' : pairMode ? '执行无线配对' : '立即连接'}
          </button>
        </form>

        {/* Saved history */}
        {savedDevices.length > 0 && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <div className="mb-2 text-[11px] font-medium text-slate-400">历史无线设备</div>
            <div className="max-h-36 space-y-1.5 overflow-y-auto">
              {savedDevices.map((item) => (
                <div
                  key={`${item.engine}:${item.address}`}
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/70 px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => handleQuickConnect(item)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        item.engine === 'harmony-next'
                          ? 'bg-sky-500/20 text-sky-300'
                          : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {item.engine === 'harmony-next' ? 'HDC' : 'ADB'}
                    </span>
                    <span className="truncate text-xs text-slate-200">{item.label}</span>
                    <span className="truncate font-mono text-[10px] text-slate-500">
                      {item.address}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(item)}
                    className="ml-2 p-1 text-slate-500 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
