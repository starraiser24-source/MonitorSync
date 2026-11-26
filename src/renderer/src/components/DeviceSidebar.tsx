import React from 'react'
import {
  Cable,
  MonitorSmartphone,
  Play,
  RefreshCw,
  Settings,
  Smartphone,
  Square,
  Wifi,
  WifiOff
} from 'lucide-react'
import { DeviceInfo, ToolStatus } from '@shared/types'

interface DeviceSidebarProps {
  devices: DeviceInfo[]
  activeDeviceKey: string | null
  toolStatus: ToolStatus | null
  refreshing: boolean
  busyDeviceId: string | null
  onRefresh: () => void
  onStartMirror: (device: DeviceInfo) => void
  onStopMirror: () => void
  onEnableWifi: (device: DeviceInfo) => void
  onDisconnectWifi: (device: DeviceInfo) => void
  onOpenWifiModal: () => void
  onOpenSettings: () => void
}

export const DeviceSidebar: React.FC<DeviceSidebarProps> = ({
  devices,
  activeDeviceKey,
  toolStatus,
  refreshing,
  busyDeviceId,
  onRefresh,
  onStartMirror,
  onStopMirror,
  onEnableWifi,
  onDisconnectWifi,
  onOpenWifiModal,
  onOpenSettings
}) => {
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-slate-800/80 bg-[#10131c]">
      {/* Brand header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 shadow-lg shadow-sky-500/20">
            <MonitorSmartphone className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">MonitorSync</h1>
            <p className="text-[11px] text-slate-400">鸿蒙 NEXT & Android 同屏</p>
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          title="工具路径与画质设置"
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Tool status bar */}
      <div className="flex items-center gap-2 border-b border-slate-800/70 px-4 py-2.5">
        <button
          onClick={onOpenSettings}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition ${
            toolStatus?.hdc.available
              ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              toolStatus?.hdc.available ? 'bg-sky-400' : 'bg-amber-400'
            }`}
          />
          HDC {toolStatus?.hdc.available ? '就绪' : '未配置'}
        </button>
        <button
          onClick={onOpenSettings}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition ${
            toolStatus?.adb.available
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-800'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              toolStatus?.adb.available ? 'bg-emerald-400' : 'bg-slate-500'
            }`}
          />
          ADB {toolStatus?.adb.available ? '就绪' : '未配置'}
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          onClick={onOpenWifiModal}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-sky-500"
        >
          <Wifi className="h-3.5 w-3.5" />
          Wi-Fi 无线连接
        </button>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新设备列表"
          className="flex items-center justify-center rounded-lg border border-slate-700/80 bg-slate-800/70 px-2.5 py-2 text-slate-300 transition hover:bg-slate-700 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Device list */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 pb-4">
        <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
          <span>已连接设备 ({devices.length})</span>
          <span>自动刷新</span>
        </div>

        {devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-4 text-xs leading-relaxed text-slate-400">
            <div className="mb-2 flex items-center gap-2 font-medium text-slate-200">
              <Smartphone className="h-4 w-4 text-sky-400" />
              未发现已连接设备
            </div>
            <p className="mb-2 text-[11px] text-slate-400">
              <strong className="text-sky-300">HarmonyOS NEXT 连接步骤：</strong>
            </p>
            <ol className="list-decimal space-y-1 pl-4 text-[11px] text-slate-400">
              <li>手机打开「设置 → 关于本机」，连点 7 次版本号开启开发者模式</li>
              <li>进入「系统 → 开发者选项」，开启「USB 调试」</li>
              <li>用数据线连接电脑并在手机上点击「允许调试」</li>
              {!toolStatus?.hdc.available && (
                <li className="text-amber-300">
                  点击右上角设置图标，选择电脑上的 <code className="text-amber-200">hdc.exe</code>
                </li>
              )}
            </ol>
          </div>
        ) : (
          devices.map((device) => {
            const key = `${device.engine}:${device.id}`
            const isActive = activeDeviceKey === key
            const isBusy = busyDeviceId === key
            const isHarmony = device.engine === 'harmony-next'

            return (
              <div
                key={key}
                className={`rounded-xl border p-3 transition ${
                  isActive
                    ? 'border-sky-500/60 bg-sky-500/10'
                    : 'border-slate-800/90 bg-slate-900/60 hover:border-slate-700'
                }`}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          isHarmony
                            ? 'bg-sky-500/20 text-sky-300'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {isHarmony ? '鸿蒙 NEXT' : 'Android'}
                      </span>
                      <span className="truncate text-xs font-semibold text-slate-100">
                        {device.name}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        {device.connection === 'wifi' ? (
                          <Wifi className="h-3 w-3 text-sky-400" />
                        ) : (
                          <Cable className="h-3 w-3 text-slate-400" />
                        )}
                        {device.connection === 'wifi' ? 'Wi-Fi' : 'USB'}
                      </span>
                      <span className="truncate font-mono text-[10px] text-slate-500">
                        {device.id}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      device.state === 'online'
                        ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                        : device.state === 'unauthorized'
                          ? 'bg-amber-400'
                          : 'bg-slate-600'
                    }`}
                    title={device.state}
                  />
                </div>

                {device.state === 'unauthorized' && (
                  <p className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                    请在手机屏幕上点击「允许调试」授权此电脑
                  </p>
                )}

                <div className="flex items-center gap-1.5">
                  {isActive ? (
                    <button
                      onClick={onStopMirror}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-rose-600/90 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-rose-500"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      停止投屏
                    </button>
                  ) : (
                    <button
                      onClick={() => onStartMirror(device)}
                      disabled={device.state !== 'online' || isBusy}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-sky-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Play className="h-3 w-3 fill-current" />
                      开始投屏
                    </button>
                  )}

                  {device.connection === 'usb' && device.state === 'online' && (
                    <button
                      onClick={() => onEnableWifi(device)}
                      disabled={isBusy}
                      title="一键开启手机 Wi-Fi 无线调试并连接"
                      className="rounded-lg border border-slate-700/80 bg-slate-800/80 px-2 py-1.5 text-[11px] text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40"
                    >
                      转无线
                    </button>
                  )}

                  {device.connection === 'wifi' && (
                    <button
                      onClick={() => onDisconnectWifi(device)}
                      title="断开无线设备"
                      className="rounded-lg border border-slate-700/80 bg-slate-800/80 p-1.5 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300"
                    >
                      <WifiOff className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
