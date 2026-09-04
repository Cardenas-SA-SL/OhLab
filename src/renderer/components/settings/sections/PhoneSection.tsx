import { useCallback, useEffect, useState } from 'react'
import type { PairedDevice } from '@shared/types'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { Button } from '@renderer/ui/Button'
import { Switch } from '@renderer/ui/Switch'
import { useSettings } from '@renderer/state/settings'
import { usePhonePairing } from '../usePhonePairing'
import { IOS_APP_STORE_URL } from '@renderer/lib/links'
import { hostOsFromNavigator, sshServerCopy } from '@shared/ssh-server'
import { thisMachine } from '../../../lib/machineName'

const ROWS = {
  remote: {
    title: 'Remote access from your phone',
    keywords: ['phone', 'remote', 'anywhere', 'relay', 'encrypted', 'access', 'cellular']
  },
  pair: {
    title: 'Pair phone',
    keywords: ['phone', 'pair', 'qr', 'ios', 'mobile', 'ssh', 'scan', 'ohlab']
  },
  devices: {
    title: 'Paired devices',
    keywords: ['phone', 'device', 'devices', 'paired', 'revoke', 'ios', 'iphone', 'remove']
  }
}
const ENTRIES = Object.values(ROWS)

/** Format an epoch-ms pairing time as a short local date. */
function formatPairedAt(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** The pairing host is this machine, so the renderer's own UA answers which OS it runs on —
 *  and that decides what the SSH server is called and whether a settings deep link exists. */
const sshServer = sshServerCopy(hostOsFromNavigator())

export function PhoneSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [pendingRevoke, setPendingRevoke] = useState<PairedDevice | null>(null)
  // What the last revoke has to say, and whether it is a WARNING or a receipt. A successful
  // removal owes the user a receipt too, and printing that in the warning colour would read as a failure.
  const [revokeNote, setRevokeNote] = useState<{ text: string; warn: boolean } | null>(null)

  const phoneAccessEnabled = useSettings((s) => s.settings.phoneAccessEnabled)
  const updateSettings = useSettings((s) => s.update)

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      setDevices(await window.nodeTerminal.pairing.listDevices())
    } catch {
      // leave the last-known list on a transient read error
    }
  }, [])

  // The shared pairing machine (also behind the top-right quick-pair popover); a completed
  // pairing refreshes the device list below — and drops the last revoke note, which names a device
  // by name and would otherwise outlive the very phone it warns about being re-paired.
  const { phase, qr, sshOpen, sshHealed, relayResult, relayPlan, error, busy, start, stop, reset } = usePhonePairing(
    () => {
      setRevokeNote(null)
      void refreshDevices()
    }
  )

  const togglePhoneAccess = (next: boolean): void => {
    updateSettings({ phoneAccessEnabled: next })
    // Start/stop the standing relay host immediately.
    window.nodeTerminal.remoteHost.setPhoneAccess(next)
    // The relay block is baked into the QR when the listener STARTS — a code already on
    // screen doesn't know about this flip, and scanning it would still produce a LAN-only
    // pairing (the field failure: works at home, dies on cellular). Regenerate; start()
    // cancels the old listener silently.
    if (phase === 'waiting') void start()
  }

  // Load the paired-device list on mount.
  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  // Surface local removal and Hub registration removal independently so a partial failure is clear.
  const revokeDevice = async (device: PairedDevice): Promise<void> => {
    setPendingRevoke(null)
    setRevokeNote(null)
    try {
      const result = await window.nodeTerminal.pairing.revokeDevice(device.id)
      // Additive, not exclusive: both legs can fail at once (an unwritable ~/.ssh while offline),
      // and being told only half of that leaves the other half to be discovered by accident.
      const notes: string[] = []
      if (!result.local) {
        notes.push(`Couldn’t remove “${device.name}” from this machine — try again.`)
      }
      if (result.server === 'failed') {
        notes.push(
          (result.local ? `Removed “${device.name}” from this machine, but its` : 'Its') +
            ' Hub registration could not be revoked. Pair it again and retry removal when the Hub is reachable.'
        )
      }
      if (notes.length) {
        setRevokeNote({ text: notes.join(' '), warn: true })
      } else if (result.server === 'ok') {
        setRevokeNote({
          text: `Removed “${device.name}” from this machine and the Hub.`,
          warn: false
        })
      }
    } catch {
      // The call itself never got an answer (main is gone, or the surface doesn't support it).
      setRevokeNote({ text: `Couldn’t remove “${device.name}” — try again.`, warn: true })
    } finally {
      void refreshDevices()
    }
  }

  return (
    <SettingsSection
      id="phone"
      title="Phone"
      description="Pair the mobile companion so it can connect to this machine over your local network — no terminal commands needed."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.remote}>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h4 className="text-[13px] font-medium text-text">Remote access from your phone</h4>
              <p className="mt-1 text-sm text-muted">
                Reach {thisMachine()} from anywhere — not just your local network — end-to-end
                encrypted
                over the relay. Your paired phone connects through the relay; the connection is
                verified with a code the first time.
              </p>
            </div>
            <Switch
              checked={phoneAccessEnabled}
              onChange={togglePhoneAccess}
              ariaLabel="Remote access from your phone"
            />
          </div>
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.pair}>
        <div className="space-y-4">
          <h4 className="text-[13px] font-medium text-text">Pair phone</h4>
          <p className="text-sm text-muted">
            Pair the mobile companion: scan this QR with your phone. Your phone generates its own
            key on-device — nothing secret leaves this machine except a single-use pairing token.
          </p>
          <p className="text-sm text-muted">
            Don&apos;t have the app yet?{' '}
            <button
              className="cursor-pointer underline hover:text-text"
              onClick={() => window.nodeTerminal.shell.openExternal(IOS_APP_STORE_URL)}
            >
              Get the mobile companion on the App Store
            </button>
          </p>

          {phase === 'idle' || phase === 'timeout' ? (
            <div className="space-y-3">
              {phase === 'timeout' ? (
                <p className="text-sm text-muted">
                  Pairing timed out — that code no longer works. Start again and scan the fresh
                  one within ten minutes.
                </p>
              ) : null}
              <Button variant="primary" disabled={busy} onClick={() => void start()}>
                {busy ? 'Starting…' : 'Start pairing'}
              </Button>
            </div>
          ) : null}

          {phase === 'waiting' && qr ? (
            <div className="space-y-3">
              {!sshOpen ? (
                // No QR until Remote Login is on: a pairing completed against an unreachable
                // sshd installs a key the phone can never use — the scan must wait, not the fix.
                // The live probe (usePhonePairing) flips sshOpen and the QR appears by itself.
                <div className="space-y-2">
                  <p className="text-sm" style={{ color: '#ff9f0a' }}>
                    <strong>{sshServer.name}</strong> is off, so your phone wouldn&apos;t be able
                    to connect after pairing. Turn it on — the QR appears here the moment it is
                    (watching, no need to restart pairing).
                  </p>
                  <p className="text-xs text-muted">{sshServer.how}</p>
                  {sshServer.settingsLabel ? (
                    <Button
                      onClick={() => void window.nodeTerminal.pairing.openRemoteLoginSettings()}
                    >
                      {sshServer.settingsLabel}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <>
                  <img
                    src={qr}
                    width={240}
                    height={240}
                    alt="Pairing QR code"
                    className="rounded-lg bg-white p-2"
                  />
                  <p className="text-sm text-muted">Waiting for your phone… (10 min)</p>
                  {relayPlan === 'dev' ? (
                    <p className="text-sm" style={{ color: '#ff9f0a' }}>
                      Set the OhLab Hub URL in Settings &gt; Team. This code pairs LAN-only until then.
                    </p>
                  ) : !phoneAccessEnabled ? (
                    <p className="text-sm" style={{ color: '#ff9f0a' }}>
                      LAN-only code: the phone will reach this machine only on this network. Turn
                      on <strong>Remote access from your phone</strong> above first to also
                      connect from cellular — the QR refreshes by itself.
                    </p>
                  ) : null}
                  {sshHealed ? (
                    <p className="text-sm" style={{ color: '#30d158' }}>
                      ✓ {sshServer.name} is on — scan away.
                    </p>
                  ) : null}
                </>
              )}
              <Button onClick={stop}>Cancel</Button>
            </div>
          ) : null}

          {phase === 'paired' ? (
            <div className="space-y-3">
              <p className="text-sm font-medium" style={{ color: '#30d158' }}>
                ✓ Paired. Your phone can now connect with its own key.
              </p>
              {relayResult === 'ok' ? (
                <p className="text-sm" style={{ color: '#30d158' }}>
                  Remote access is set up — the phone can reach this machine from anywhere.
                </p>
              ) : relayResult === 'failed' ? (
                <p className="text-sm" style={{ color: '#ff9f0a' }}>
                  ⚠ Remote-access setup failed, so this pairing is LAN-only for now. Check this
                  machine&apos;s internet connection and pair again to retry — or the phone will
                  pick it up by itself next time it connects on this network.
                </p>
              ) : relayResult === 'off' ? (
                <p className="text-sm text-muted">
                  LAN-only pairing — remote access is switched off above.
                </p>
              ) : relayResult === 'dev' ? (
                <p className="text-sm text-muted">
                  LAN-only pairing. Set the OhLab Hub URL in Settings &gt; Team for remote access.
                </p>
              ) : null}
              <Button onClick={reset}>Pair another phone</Button>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm" style={{ color: '#ff9f0a' }}>
              {error}
            </p>
          ) : null}
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.devices}>
        <div className="space-y-3">
          <h4 className="text-[13px] font-medium text-text">Paired devices</h4>
          {devices.length === 0 ? (
            <p className="text-sm text-muted">No devices paired yet</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text">{device.name}</div>
                    {device.pairedAt ? (
                      <div className="text-[12px] text-muted">
                        Paired {formatPairedAt(device.pairedAt)}
                      </div>
                    ) : null}
                  </div>
                  <Button onClick={() => setPendingRevoke(device)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
          {revokeNote ? (
            <p
              className={revokeNote.warn ? 'text-sm' : 'text-sm text-muted'}
              style={revokeNote.warn ? { color: '#ff9f0a' } : undefined}
            >
              {revokeNote.text}
            </p>
          ) : null}
        </div>
      </SearchableRow>

      {pendingRevoke ? (
        <ConfirmDialog
          message={`Revoke “${pendingRevoke.name}”? Its key and Hub registration are removed and it will no longer be able to connect to ${thisMachine()}.`}
          confirmLabel="Revoke"
          onConfirm={() => void revokeDevice(pendingRevoke)}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
