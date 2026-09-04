# OhLab Hub

The Hub lets two OhLab installations find each other and broker end-to-end encrypted relay sessions. It stores team names, public keys, project membership, presence, and join requests, but it cannot read terminal, transcript, canvas, or RPC payloads.

## Two brothers, two homes

Tailscale is the easiest and safest way to make one computer reachable from another home. Install Tailscale on both computers and sign them into the same tailnet first. No router port forwarding is needed.

1. Sebastián opens Settings > Team, enables **Host a hub on this computer**, and leaves port `8791` selected.
2. OhLab shows the Tailscale address when one is available. If it only shows a local-network address, confirm Tailscale is connected before continuing.
3. Sebastián opens the project, returns to Settings > Team, selects **Share this project**, and copies the `ohlab-invite:...` code.
4. His brother installs the OhLab DMG, opens Settings > Team, pastes the code under **Join with an invite code**, enters his name, and selects **Join**.
5. Sebastián receives a notification and approves the pending row in Settings > Team. Decline rejects it instead.
6. Both enable **Agent messaging for this project** in Team. The setting is deliberately per-project and must be on at both ends.
7. Each member now appears with a live online indicator. Select **Open** to open the other computer's project as a tab.

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
| Member is offline | Open OhLab on that computer and confirm Settings > Team says connected. **Open** remains disabled while the directory socket is offline. |
| Agent messages are refused | Enable agent messaging for the shared project on both computers. After restarting OhLab, restart a warm-attached agent from its node menu before messaging it. |

## Privacy and authentication

Accounts have no passwords. OhLab proves possession of its persistent NaCl public key through an encrypted challenge, then receives a short-lived Hub session. Approving a member pins that key; removing the member revokes it and closes the live relay session.
