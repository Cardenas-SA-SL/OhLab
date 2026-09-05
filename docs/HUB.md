# OhLab Hub

The Hub lets two OhLab installations find each other and broker end-to-end encrypted relay sessions. It stores team names, public keys, project membership, presence, and join requests, but it cannot read terminal, transcript, canvas, or RPC payloads.

Guía rápida en español: [GUIA-RAPIDA-ES.md](./GUIA-RAPIDA-ES.md).

## Two brothers, two homes

Tailscale is the easiest and safest way to make one computer reachable from another home. Install Tailscale on both computers and sign them into the same tailnet first. No router port forwarding is needed.

1. Sebastián opens Settings > Team, enables **Host a hub on this computer**, and leaves port `8791` selected.
2. OhLab shows the Tailscale address when one is available. If it only shows a local-network address, confirm Tailscale is connected before continuing.
3. Sebastián opens the project, returns to Settings > Team, selects **Share this project**, and copies the `ohlab-invite:...` code. Sharing binds the open project as his side of the team project and starts hosting it for approved members.
4. His brother installs the OhLab DMG, opens Settings > Team, pastes the code under **Join with an invite code**, enters his name, chooses his side of the project (**Create an empty project named "..."**, the default, or **Use the current project as my side**), and selects **Join**.
5. Sebastián receives a notification and approves the pending row in Settings > Team. Decline rejects it instead. Approving connects both ways at once.
6. Both enable **Agent messaging for this project** in Team. The setting is deliberately per-project and must be on at both ends.
7. Each member now appears with a live online indicator, their machine, and the agents they are running. Nobody clicks Open: whenever a member is online, their copy of the project opens here as a tab named `<project> · <member>`, and yours opens for them.

## Symmetric sharing

A shared project has one copy per member, each on that member's own machine, and every member sees every other member's copy:

- Sebastián sees his own tab plus **Horacio Team · Jorge** and **Horacio Team · Ana**; Jorge sees his own plus Sebastián's and Ana's. The tabs open in the background and never take the view you are working in.
- A member who goes offline is a greyed tab that reconnects by itself when they are back. Agent reads and sends against a greyed tab are refused with "member offline".
- Closing a member's tab is remembered on this computer (`hubMutedMembers` in `settings.json`): it does not reopen until you select **Open** on that member in Team. **Close** in Team does the same.
- A member who has not bound a local project yet is listed as "not sharing an agent canvas yet". Their tab appears the moment they share or join with a side of their own.
- The binding between a local project and the team project is machine-local (`hubProjectId` on the workspace index entry). It is never written into the shared `.nodeterm/project.json`, so cloning a repository never enrolls the clone in a team.
- `ohlab list` on any member shows every other member's agents with the member and machine on each row; `link --to <id>` reads them and `send`/`reply` talk to them.

The embedded Hub binds all interfaces. OhLab does not use UPnP or open router ports. A plain LAN address only works within one home unless you configure Tailscale or a port forward yourself.

## Always-on standalone Hub

For an always-on computer or VPS, run the Electron-free service separately with Node 22 or newer:

```sh
npm run hub
```

It listens on `0.0.0.0:8791` and stores data in `~/.ohlab-hub`. Override these with `--data-dir`, `--host`, and `--port`, or `OHLAB_HUB_DATA_DIR`, `OHLAB_HUB_HOST`, and `OHLAB_HUB_PORT`.

Docker is also supported:

```sh
docker build -f Dockerfile.hub -t ohlab-hub .
docker run --restart unless-stopped -p 8791:8791 -v ohlab-hub:/data ohlab-hub
```

Check readiness with `curl http://127.0.0.1:8791/healthz`. For a public VPS, put an HTTPS reverse proxy such as Caddy in front of the Hub and proxy WebSocket upgrades. Plain HTTP should be limited to a trusted LAN or tailnet.

## Exposing a Hub to the internet

Prefer not to. A tailnet is the recommended perimeter: every Hub endpoint that mints a token, issues a key challenge or registers an account is reachable without a credential by design (a fresh installation has nothing to present yet), so on the open internet the Hub's own ceilings are the only thing between a script in a loop and a full disk. Those ceilings exist and are on by default, but they are a floor, not a substitute for a perimeter:

- Every non-GET request and every WebSocket upgrade is metered per client address (token bucket; a refused request gets `429` with `Retry-After`). GETs are answered from memory and are not metered.
- Live relay tokens, paired devices and open key challenges are capped per client address and overall; sessions are capped per account; accounts and projects are capped overall. A full ceiling answers `429` and never crashes the Hub.
- A request body must arrive within 10 s (a stalled upload is answered `408` and the socket closed), and expired tokens, challenges and sessions are swept out of memory and off disk every minute instead of living for the life of the process.

If a public deployment is unavoidable, put a reverse proxy with its own rate limiting and TLS in front (Caddy, nginx, Traefik), proxy WebSocket upgrades, and start the Hub with `--trust-proxy` (or `OHLAB_HUB_TRUST_PROXY=1`, or `"trustProxy": true` in `hub.json`) so the per-address ceilings key on the real client from `X-Forwarded-For` rather than on the proxy. Never enable that flag on a Hub clients reach directly: an unproxied client could then pick the address its limits are keyed on. The ceilings can be raised for a larger team through a `"limits"` object in `<data-dir>/hub.json` (the field names are those of `DEFAULT_HUB_LIMITS` in `src/hub/limits.ts`).

One residual worth knowing: a standing (phone) host token is minted from a public key alone (`POST /v1/relay/host-token`) and a host's relay room is derived from that key, which is public. Someone who knows a host's key can therefore mint a token into its room and occupy it before the real host reconnects, which stalls that host's phone relay until the squatter is rate-limited or leaves; it never exposes data (the phone pins the host's key and the handshake fails). That endpoint keeps its unauthenticated contract so existing desktops and phones keep working; on a tailnet the tailnet is the answer, on the internet the proxy's rate limiting is.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot reach Hub | Confirm the host says **listening**, both computers are online in Tailscale, port `8791` is allowed by the host firewall, and the invite contains the shown Tailscale address rather than `127.0.0.1` or a home-only LAN address. |
| Join stays pending forever | The owner must be online and select **Approve** in Settings > Team. Regenerating an invite invalidates the old code. |
| Member is offline | Open OhLab on that computer and confirm Settings > Team says connected. Their tab greys out here and reconnects on its own; **Open** stays disabled while they are offline. |
| Member listed as "not sharing an agent canvas yet" | That member has no local side bound: they need to select **Share this project** (owner) or join with a side chosen in the Join dialog. |
| A member's tab does not reappear | You closed it, so it is muted on this computer. Select **Open** on that member in Settings > Team. |
| Agent messages are refused | Enable agent messaging for the shared project on both computers. After restarting OhLab, restart a warm-attached agent from its node menu before messaging it. |

## Privacy and authentication

Accounts have no passwords. OhLab proves possession of its persistent NaCl public key through an encrypted challenge, then receives a short-lived Hub session. Approving a member pins that key; removing the member revokes it and closes the live relay session.

The Hub is the directory, so the brokered session flow (**Open** in Settings > Team) confirms the channel code automatically on both ends and its security reduces to the Hub introducing each member's real key. Two things keep a compromised Hub from quietly standing between two members:

- **Keys are pinned once.** The first time a member's key is seen (approving them, accepting their session, or opening theirs) it is pinned to their account on this computer, in `hub-member-pins.json`. The same account showing up with a different key is refused on both ends, with a notification and a red line in Settings > Team. If a member genuinely reinstalled OhLab, remove them and invite them again; that forgets the pin.
- **Verify code.** Once a session has been opened, Settings > Team shows a six-digit **verify code** beside the member. It is derived from the two computers' identity keys, so it is the same on both screens for the same pair of people, and it does not change between sessions. Read it to each other once, out of band; matching codes mean each side holds the other's real key, and the pins keep it that way from then on.

Each computer also refuses a brokered session whose relay address is not the Hub it is connected to, whatever the request claims.
