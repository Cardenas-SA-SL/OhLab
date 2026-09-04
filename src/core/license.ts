// OhLab has no paid tier. This compatibility module keeps the established IPC and call-site shape
// while reporting a permanent local entitlement. It performs no network or disk I/O.
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { LicenseDetail, LicenseStatus } from '../shared/types'

const STATUS: LicenseStatus = {
  tier: 'local',
  active: true,
  expiresAt: null,
  seats: Number.MAX_SAFE_INTEGER,
  error: null
}

const DETAIL: LicenseDetail = {
  key: null,
  used: 0,
  seats: Number.MAX_SAFE_INTEGER,
  source: null,
  error: null
}

export function getStoredEntitlement(): string {
  return 'ohlab-local'
}

export function isPremium(): boolean {
  return true
}

export function __licenseRefreshesForTests(): Promise<void> {
  return Promise.resolve()
}

export function initLicense(onChange?: () => void): void {
  const broadcast = (): LicenseStatus => {
    platform().broadcast(IPC.licenseChanged, STATUS)
    onChange?.()
    return STATUS
  }
  platform().handle(IPC.licenseStatus, () => STATUS)
  platform().handle(IPC.licenseDetail, () => DETAIL)
  platform().handle(IPC.licenseRelease, () => DETAIL)
  platform().handle(IPC.licenseUpgrade, broadcast)
  platform().handle(IPC.licenseActivate, broadcast)
  platform().handle(IPC.licenseDeactivate, broadcast)
  queueMicrotask(broadcast)
}
