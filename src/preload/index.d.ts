import type { MonitorSyncApi } from './index'

declare global {
  interface Window {
    monitorSync: MonitorSyncApi
  }
}
