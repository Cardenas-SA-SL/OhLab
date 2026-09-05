# OhLab Hub

The Hub lets two OhLab installations find each other and broker end-to-end encrypted relay sessions. It stores team names, public keys, project membership, presence, and join requests, but it cannot read terminal, transcript, canvas, or RPC payloads.

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
