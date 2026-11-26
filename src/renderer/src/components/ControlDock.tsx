import React, { useState } from 'react'
import {
  ArrowLeft,
  Camera,
  Circle,
  Power,
  Send,
  Square,
  Sun,
  Volume1,
  Volume2,
  X
} from 'lucide-react'
import { SystemKeyAction } from '@shared/types'

interface ControlDockProps {
  disabled: boolean
  onKey: (action: SystemKeyAction) => void
  onSendText: (text: string) => void
  onScreenshot: () => void
  onStop: () => void
}

export const ControlDock: React.FC<ControlDockProps> = ({
  disabled,
  onKey,
  onSendText,
  onScreenshot,
  onStop
}) => {
  const [text, setText] = useState('')

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSendText(text)
    setText('')
  }

  const buttons: Array<{ action: SystemKeyAction; label: string; icon: React.ReactNode }> = [
    { action: 'wake', label: '唤醒亮屏', icon: <Sun className="h-4 w-4 text-amber-300" /> },
    { action: 'power', label: '电源 / 息屏', icon: <Power className="h-4 w-4" /> },
    { action: 'back', label: '返回 (右键)', icon: <ArrowLeft className="h-4 w-4" /> },
    { action: 'home', label: '主页 (中键)', icon: <Circle className="h-4 w-4" /> },
    { action: 'recents', label: '多任务', icon: <Square className="h-3.5 w-3.5" /> },
    { action: 'volumeUp', label: '音量 +', icon: <Volume2 className="h-4 w-4" /> },
    { action: 'volumeDown', label: '音量 -', icon: <Volume1 className="h-4 w-4" /> }
  ]

  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-l border-slate-800/80 bg-[#10131c] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
        快捷操控
      </h2>

      <div className="grid grid-cols-2 gap-2">
        {buttons.map((btn) => (
          <button
            key={btn.action}
            disabled={disabled}
            onClick={() => onKey(btn.action)}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 py-3 text-slate-200 transition hover:border-sky-500/40 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {btn.icon}
            <span className="text-[11px] text-slate-400">{btn.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2 border-t border-slate-800/80 pt-4">
        <label className="block text-[11px] font-medium text-slate-400">文字快速发送到手机</label>
        <form onSubmit={handleSubmit} className="flex gap-1.5">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled}
            placeholder="输入文字回车发送..."
            className="min-w-0 flex-1 rounded-lg border border-slate-700/80 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500 disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            title="发送文字"
            className="flex items-center justify-center rounded-lg bg-sky-600 px-2.5 text-white transition hover:bg-sky-500 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>

      <div className="mt-auto space-y-2 border-t border-slate-800/80 pt-4">
        <button
          disabled={disabled}
          onClick={onScreenshot}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700/80 bg-slate-800/80 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
        >
          <Camera className="h-3.5 w-3.5" />
          保存手机截图
        </button>
        <button
          disabled={disabled}
          onClick={onStop}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 py-2 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
          断开当前投屏
        </button>
      </div>
    </div>
  )
}
