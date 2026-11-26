import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  ControlMessage,
  DeviceInfo,
  StartSessionResult,
  SystemKeyAction,
  ToolStatus
} from '@shared/types'
import { ControlDock } from './components/ControlDock'
import { DeviceSidebar } from './components/DeviceSidebar'
import { ScreenStage } from './components/ScreenStage'
import { SettingsModal } from './components/SettingsModal'
import { WifiConnectModal } from './components/WifiConnectModal'

export const App: React.FC = () => {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [activeSession, setActiveSession] = useState<StartSessionResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null)
  const [wifiModalOpen, setWifiModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const sendControlRef = useRef<((msg: ControlMessage) => void) | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev))
    }, 3500)
  }, [])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      const [status, list, cfg] = await Promise.all([
        window.monitorSync.getToolStatus(),
        window.monitorSync.listDevices(),
        window.monitorSync.getSettings()
      ])
      setToolStatus(status)
      setDevices(list)
      setSettings(cfg)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refreshAll()
    const timer = window.setInterval(() => {
      void window.monitorSync.listDevices().then(setDevices)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshAll])

  const handleStartMirror = async (device: DeviceInfo): Promise<void> => {
    const key = `${device.engine}:${device.id}`
    setBusyDeviceId(key)
    try {
      if (activeSession) {
        await window.monitorSync.stopSession(activeSession.sessionId)
      }
      const res = await window.monitorSync.startSession(device)
      setActiveSession(res)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyDeviceId(null)
    }
  }

  const handleStopMirror = async (): Promise<void> => {
    if (!activeSession) return
    await window.monitorSync.stopSession(activeSession.sessionId)
    setActiveSession(null)
  }

  const handleEnableWifi = async (device: DeviceInfo): Promise<void> => {
    const key = `${device.engine}:${device.id}`
    setBusyDeviceId(key)
    try {
      const res = await window.monitorSync.enableWifiFromUsb(device.engine, device.id)
      showToast(res.message)
      if (res.ok) await refreshAll()
    } finally {
      setBusyDeviceId(null)
    }
  }

  const handleDisconnectWifi = async (device: DeviceInfo): Promise<void> => {
    const res = await window.monitorSync.disconnectWifi(device.engine, device.id)
    showToast(res.message)
    await refreshAll()
  }

  const handleKey = (action: SystemKeyAction): void => {
    sendControlRef.current?.({ type: 'key', action })
  }

  const handleSendText = (text: string): void => {
    sendControlRef.current?.({ type: 'text', text })
  }

  const handleScreenshot = async (): Promise<void> => {
    if (!activeSession) return
    const res = await window.monitorSync.saveScreenshot(activeSession.sessionId)
    showToast(res.message)
  }

  const activeDeviceKey = activeSession
    ? `${activeSession.device.engine}:${activeSession.device.id}`
    : null

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0b0d12] text-slate-100">
      <DeviceSidebar
        devices={devices}
        activeDeviceKey={activeDeviceKey}
        toolStatus={toolStatus}
        refreshing={refreshing}
        busyDeviceId={busyDeviceId}
        onRefresh={() => void refreshAll()}
        onStartMirror={(d) => void handleStartMirror(d)}
        onStopMirror={() => void handleStopMirror()}
        onEnableWifi={(d) => void handleEnableWifi(d)}
        onDisconnectWifi={(d) => void handleDisconnectWifi(d)}
        onOpenWifiModal={() => setWifiModalOpen(true)}
        onOpenSettings={() => setSettingsModalOpen(true)}
      />

      <ScreenStage
        session={activeSession}
        onSendReady={(fn) => {
          sendControlRef.current = fn
        }}
        onStatusToast={showToast}
      />

      <ControlDock
        disabled={!activeSession}
        onKey={handleKey}
        onSendText={handleSendText}
        onScreenshot={() => void handleScreenshot()}
        onStop={() => void handleStopMirror()}
      />

      <WifiConnectModal
        open={wifiModalOpen}
        savedDevices={settings?.savedWifiDevices ?? []}
        onClose={() => setWifiModalOpen(false)}
        onConnected={() => void refreshAll()}
      />

      <SettingsModal
        open={settingsModalOpen}
        settings={settings}
        toolStatus={toolStatus}
        onClose={() => setSettingsModalOpen(false)}
        onSaved={() => void refreshAll()}
      />

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-2 text-xs text-slate-100 shadow-2xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  )
}

export default App
