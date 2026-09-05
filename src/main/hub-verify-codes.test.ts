import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearVerifyCodesForTests, onVerifyCodesChange, rememberVerifyCode, verifyCodes } from './hub-verify-codes'

afterEach(() => clearVerifyCodesForTests())

describe('hub verify codes', () => {
  it('remembers one code per peer key and tells listeners only when something changed', () => {
    const listener = vi.fn()
    const off = onVerifyCodesChange(listener)
    rememberVerifyCode('peer-1', '123 456')
    rememberVerifyCode('peer-1', '123 456')
    rememberVerifyCode('peer-2', null)
    rememberVerifyCode('', '999 999')
    expect(verifyCodes()).toEqual({ 'peer-1': '123 456' })
    expect(listener).toHaveBeenCalledTimes(1)
    rememberVerifyCode('peer-2', '654 321')
    expect(verifyCodes()).toEqual({ 'peer-1': '123 456', 'peer-2': '654 321' })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    rememberVerifyCode('peer-3', '111 111')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
