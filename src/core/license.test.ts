import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { IPC } from '../shared/ipc'
import { getStoredEntitlement, initLicense, isPremium } from './license'

describe('OhLab local entitlement compatibility', () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const broadcast = vi.fn()

  beforeEach(() => {
    resetPlatformForTests()
    for (const key of Object.keys(handlers)) delete handlers[key]
    broadcast.mockClear()
    initPlatform({
      userDataDir: '/unused', appVersion: 'test', isPackaged: false,
      handle: (channel, fn) => { handlers[channel] = fn }, on: () => {},
      handleWithSender: () => {}, onWithSender: () => {}, sendTo: () => {}, broadcast,
      clientIds: () => [], openExternal: async () => {}
    })
  })

  it('is permanent, unlimited, and performs no network activation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    initLicense()
    expect(isPremium()).toBe(true)
    expect(getStoredEntitlement()).toBe('ohlab-local')
    expect(await handlers[IPC.licenseStatus]()).toMatchObject({ active: true, tier: 'local', seats: Number.MAX_SAFE_INTEGER })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
