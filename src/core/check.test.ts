import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { fetchCheck } from './check'

afterEach(() => {
  resetPlatformForTests()
  vi.unstubAllGlobals()
})

describe('OhLab announcement feed', () => {
  it('reads the GitHub-hosted static array without inheriting an update policy', async () => {
    initPlatform(fakePlatform({ isPackaged: true }))
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { id: 'welcome', title: 'Welcome to OhLab', body: 'Hello', level: 'success' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCheck()).resolves.toEqual({
      messages: [{ id: 'welcome', title: 'Welcome to OhLab', body: 'Hello', level: 'success' }],
      update: { minSupported: null, mandatory: false }
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/Cardenas-SA-SL/OhLab/main/docs/announcements.json',
      expect.objectContaining({ cache: 'no-cache' })
    )
  })

  it('does not contact the production feed from a development build', async () => {
    initPlatform(fakePlatform({ isPackaged: false }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCheck()).resolves.toEqual({
      messages: [],
      update: { minSupported: null, mandatory: false }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
