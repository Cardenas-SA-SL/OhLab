import { describe, expect, it } from 'vitest'
import { buildCodexHooksAndTrust, buildManagedCommand, CODEX_EVENTS } from './codex'
import { computeTrustedHash } from './codex-trust'
import { buildCodexWindowsWrapper, WINDOWS_SH_CANDIDATES } from './codex-windows-wrapper'

// The command form a codex hook carries. The trust hash is computed over THIS exact byte string, so
// the hooks.json command and the config.toml trust entry must always come from the same builder.
describe('buildManagedCommand', () => {
  it('POSIX: wraps the script path in the [ -x ] guard with POSIX single-quoting', () => {
    expect(buildManagedCommand('/a/b/codex.sh', 'linux')).toBe(
      "if [ -x '/a/b/codex.sh' ]; then /bin/sh '/a/b/codex.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('POSIX: drains stdin when it bails — codex writes the payload there (#186/#187)', () => {
    // Without this, a bail that never reads can EPIPE the writer mid-payload. It is the same
    // `else` branch install-helper's command has always carried; codex's was the one without it.
    expect(buildManagedCommand('/a/b/codex.sh', 'darwin')).toContain('else cat >/dev/null 2>&1')
  })

  // Issue #567: codex runs a hook command through `cmd.exe /C` on Windows
  // (codex-rs/hooks/src/engine/command_runner.rs, rust-v0.151.0), which answers
  // "-x was unexpected at this time." and exit 1 to an `sh` one-liner — on EVERY event, for the
  // life of the node.
  it('win32: points cmd.exe at the batch wrapper beside the script, not at an sh one-liner', () => {
    expect(buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\ohlab-codex.sh', 'win32')).toBe(
      '"C:\\Users\\u\\.nodeterm\\agent-hooks\\ohlab-codex-hook.cmd"'
    )
    expect(buildManagedCommand('C:\\a\\codex.sh', 'win32')).not.toContain('[ -x')
    expect(buildManagedCommand('C:\\a\\codex.sh', 'win32')).not.toContain('/bin/sh')
  })

  it('win32: the path stays one quoted token — a user profile routinely has a space in it', () => {
    expect(buildManagedCommand('C:\\Users\\First Last\\agent-hooks\\ohlab-codex.sh', 'win32')).toBe(
      '"C:\\Users\\First Last\\agent-hooks\\ohlab-codex-hook.cmd"'
    )
  })

  // The platform is the machine that will RUN codex. RemoteHooks writes this into an SSH host's
  // hooks.json, and that host is POSIX whatever the desktop is — so a Windows desktop must not put
  // a `.cmd` command on a Linux server.
  it('the platform argument decides, not the host generating the string', () => {
    expect(buildManagedCommand('/home/u/.nodeterm/agent-hooks/ohlab-codex.sh', 'linux')).toContain(
      '/bin/sh'
    )
  })
})

describe('buildCodexWindowsWrapper', () => {
  const wrapper = buildCodexWindowsWrapper()

  it('runs the SAME codex.sh, found beside itself — no second copy of the protocol', () => {
    // The wrapper only locates a shell. Everything about the hook protocol (the POST, the endpoint
    // failover, the node token, the permission-answer poll) stays in the one POSIX script.
    expect(wrapper).toContain('set "NT_SCRIPT=%~dp0ohlab-codex.sh"')
    expect(wrapper).not.toContain('curl')
  })

  it('searches Git for Windows layouts before PATH', () => {
    for (const candidate of WINDOWS_SH_CANDIDATES) expect(wrapper).toContain(candidate)
    const lastCandidate = Math.max(...WINDOWS_SH_CANDIDATES.map((c) => wrapper.indexOf(c)))
    expect(wrapper.indexOf('%%~$PATH:I')).toBeGreaterThan(lastCandidate)
  })

  it('hands sh a forward-slash path, which needs no MSYS conversion', () => {
    expect(wrapper).toContain('set "NT_ARG=%NT_SCRIPT:\\=/%"')
    expect(wrapper).toContain('"%NT_SH%" "%NT_ARG%"')
  })

  it('drains stdin and exits 0 on every bail — no shell, no script', () => {
    // "nodeterm is not installed here" must look like nothing happening, not a broken hook; and a
    // bail that never reads codex's payload can EPIPE the writer.
    expect(wrapper).toContain('if not exist "%NT_SCRIPT%" goto :nt_drain')
    expect(wrapper).toContain('if not defined NT_SH goto :nt_drain')
    expect(wrapper.slice(wrapper.indexOf(':nt_drain'))).toContain('findstr /r ".*" >nul 2>&1')
    expect(wrapper.trimEnd().endsWith('exit /b 0')).toBe(true)
  })

  it('propagates the script exit code on the happy path', () => {
    expect(wrapper).toContain('exit /b %ERRORLEVEL%')
  })

  it('is CRLF — cmd.exe is not reliably tolerant of LF in a batch file', () => {
    expect(wrapper).toContain('\r\n')
    expect(wrapper.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('buildCodexHooksAndTrust', () => {
  it('returns null for an unparseable (null) hooks.json so the caller never clobbers it', () => {
    expect(buildCodexHooksAndTrust(null, 'cmd', '/h/hooks.json')).toBeNull()
  })

  it('appends the managed handler to all eight events + emits one trust entry per event', () => {
    const command = buildManagedCommand('/home/u/.nodeterm/agent-hooks/ohlab-codex.sh')
    const built = buildCodexHooksAndTrust({}, command, '/home/u/.codex/hooks.json')
    expect(built).not.toBeNull()
    const { config, trustEntries } = built!
    // one definition per subscribed event, our managed handler last
    for (const ev of CODEX_EVENTS) {
      const defs = config.hooks?.[ev]
      expect(defs?.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
    expect(trustEntries).toHaveLength(CODEX_EVENTS.length)
    expect(trustEntries.every((e) => e.command === command)).toBe(true)
    expect(trustEntries.every((e) => e.sourcePath === '/home/u/.codex/hooks.json')).toBe(true)
  })

  it('is idempotent — re-running on its own output does not duplicate the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/ohlab-codex.sh')
    const first = buildCodexHooksAndTrust({}, command, '/x/hooks.json')!
    const second = buildCodexHooksAndTrust(first.config, command, '/x/hooks.json')!
    for (const ev of CODEX_EVENTS) {
      // exactly one managed handler, still at the tail
      const defs = second.config.hooks?.[ev] ?? []
      const managed = defs.filter((d) => d.hooks?.some((h) => h.command === command))
      expect(managed).toHaveLength(1)
      expect(defs.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
  })

  it('preserves a user-authored hook at its original index before the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/ohlab-codex.sh')
    const userDef = { hooks: [{ type: 'command' as const, command: 'echo mine' }] }
    const built = buildCodexHooksAndTrust({ hooks: { Stop: [userDef] } }, command, '/x/hooks.json')!
    const stop = built.config.hooks?.Stop ?? []
    expect(stop[0]).toEqual(userDef)
    expect(stop.at(-1)?.hooks?.[0]?.command).toBe(command)
  })

  it('keeps two user definitions at their trust-key indices and trusts the managed tail', () => {
    const command = buildManagedCommand('/x/agent-hooks/ohlab-codex.sh')
    const firstUserDef = { hooks: [{ type: 'command' as const, command: 'echo first' }] }
    const secondUserDef = { hooks: [{ type: 'command' as const, command: 'echo second' }] }
    const built = buildCodexHooksAndTrust(
      { hooks: { SessionStart: [firstUserDef, secondUserDef] } },
      command,
      '/x/hooks.json'
    )!
    const sessionStart = built.config.hooks?.SessionStart ?? []
    expect(sessionStart[0]).toEqual(firstUserDef)
    expect(sessionStart[1]).toEqual(secondUserDef)
    expect(sessionStart[2]?.hooks?.[0]?.command).toBe(command)
    expect(built.trustEntries.find((entry) => entry.eventLabel === 'session_start')).toMatchObject({
      groupIndex: 2,
      handlerIndex: 0
    })
  })

  it('sweeps a stale managed handler out of an event we no longer subscribe to', () => {
    const command = buildManagedCommand('/x/agent-hooks/ohlab-codex.sh')
    // PreCompact is not in CODEX_EVENTS; a stale managed copy there must be removed.
    const stale = { hooks: [{ type: 'command' as const, command }] }
    const built = buildCodexHooksAndTrust({ hooks: { PreCompact: [stale] } }, command, '/x/hooks.json')!
    expect(built.config.hooks?.PreCompact).toBeUndefined()
  })

  // GOLDEN: the first six hashes were read from a LIVE codex config.toml on a host where the status
  // hooks fire correctly (codex-cli 0.114.0). Locking them guards the exact JSON canonicalization
  // codex hashes against — any drift here silently breaks every codex status badge.
  it('matches the byte-exact trust hashes codex accepts in the field', () => {
    // The command is a FROZEN LITERAL, not `buildManagedCommand(...)`. These hashes are evidence
    // about codex's CANONICALIZATION, captured from a live config.toml — regenerating them from
    // whatever the builder currently emits would silently destroy the only external check we have
    // on it. Change the command string here only if you have re-captured the hashes from a host
    // where the hooks demonstrably fire.
    const command =
      "if [ -x '/root/.nodeterm-server/agent-hooks/ohlab-codex.sh' ]; then /bin/sh '/root/.nodeterm-server/agent-hooks/ohlab-codex.sh'; fi"
    const built = buildCodexHooksAndTrust({}, command, '/root/.codex/hooks.json')!
    const byLabel = Object.fromEntries(built.trustEntries.map((e) => [e.eventLabel, computeTrustedHash(e)]))
    expect(byLabel).toMatchObject({
      session_start: 'sha256:0adde47908ceee250d75dc1ee9ed0ea1ee4fd147e11740f7dcefc63b63c113f1',
      user_prompt_submit: 'sha256:50063e0dadd35d5cb3548c8eb606a453cfd14207e7d2f954b7ab0001cc22e238',
      pre_tool_use: 'sha256:ee07d2a98b8cca6fcfc1d0d943364d257927d27636207cc55f8f3335adf9a6b8',
      permission_request: 'sha256:9d154bc439158969aff1fcd56bbd6d9b908ed645dd6a13c31186a52f3e4bd35a',
      post_tool_use: 'sha256:e53bc1daed86794bc0c95f8a662f32bb75083daafa20e0111836554234c68cb6',
      stop: 'sha256:e09fe6b6387e06b410f5a2c2478c12ac7db2e7b420d0794387abb3ade4d52e53',
      // The subagent pair was verified live differently: a capture home whose trust entries were
      // computed by this same algorithm had codex-cli 0.146.0 FIRE SubagentStart/SubagentStop
      // (spawn_agent measurement run, 2026-08-24) — i.e. codex accepted hashes of this shape for
      // these labels. The values below pin the canonicalization for this command string.
      subagent_start: 'sha256:49a46f787dfe2e4beeb58a3fb7d2a1ba901f94f5d1a09f4a9b777e37cf904bf2',
      subagent_stop: 'sha256:d03dbeb7ae37f2fd00aa6bbd78a606f9bd628e96be7802e324e2ae21074a5600'
    })
  })

  // Issue #567 repair. A Windows machine already carries the unrunnable POSIX command in its
  // hooks.json. If the managed-entry matcher only recognized the leaf THIS platform writes, that
  // entry would survive the strip and the fresh `.cmd` entry would be APPENDED beside it — #558's
  // duplicate-per-launch, on the same file. Both leaves are matched, always, so the next app launch
  // collapses the file to exactly one runnable entry.
  it('replaces a pre-fix POSIX entry with the Windows one instead of appending beside it', () => {
    const stale = {
      hooks: [
        {
          type: 'command' as const,
          command:
            "if [ -x 'C:\\Users\\u\\.nodeterm\\agent-hooks\\ohlab-codex.sh' ]; then /bin/sh 'C:\\Users\\u\\.nodeterm\\agent-hooks\\ohlab-codex.sh'; fi"
        }
      ]
    }
    const command = buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\ohlab-codex.sh', 'win32')
    const built = buildCodexHooksAndTrust(
      { hooks: { Stop: [stale], SessionStart: [stale] } },
      command,
      'C:\\Users\\u\\.codex\\hooks.json'
    )!
    for (const ev of ['Stop', 'SessionStart']) {
      expect(built.config.hooks![ev]).toEqual([{ hooks: [{ type: 'command', command }] }])
    }
  })

  // The mirror of the above: a POSIX host that somehow carries a `.cmd` entry (a settings file
  // copied between machines) is repaired the same way rather than accumulating both.
  it('replaces a stray Windows entry on a POSIX install', () => {
    const stale = {
      hooks: [{ type: 'command' as const, command: '"/home/u/.nodeterm/agent-hooks/ohlab-codex-hook.cmd"' }]
    }
    const command = buildManagedCommand('/home/u/.nodeterm/agent-hooks/ohlab-codex.sh', 'linux')
    const built = buildCodexHooksAndTrust({ hooks: { Stop: [stale] } }, command, '/h/hooks.json')!
    expect(built.config.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command }] }])
  })

  it('subscribes the subagent pair (spawn_agent fan-out) with snake_case labels', () => {
    expect(CODEX_EVENTS).toContain('SubagentStart')
    expect(CODEX_EVENTS).toContain('SubagentStop')
  })
})
