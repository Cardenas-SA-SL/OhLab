# OhLab Hub

OhLab Hub is the small, self-hosted rendezvous service used by OhLab desktops and phones. It keeps
the team/project directory, issues short-lived pairing tokens, and forwards WebSocket frames between
two peers. Terminal, transcript, canvas, and RPC payloads remain end-to-end encrypted. The Hub sees
only opaque tunnel frames. The directory necessarily sees account names, public keys, project
membership, presence, and connection requests.

## Run it

With Node 22 or newer:

```sh
npm run hub
```

The default data directory is `~/.ohlab-hub` and the default listener is `0.0.0.0:8791`. Override
them with `--data-dir`, `--host`, and `--port`, or `OHLAB_HUB_DATA_DIR`, `OHLAB_HUB_HOST`, and
`OHLAB_HUB_PORT`. Put `{ "adminToken": "a-long-random-secret" }` in `<data-dir>/hub.json` to enable
the account/project administration endpoints. `--admin-token` can override it for an ephemeral run.

Docker is also supported:

```sh
docker build -f Dockerfile.hub -t ohlab-hub .
docker run --restart unless-stopped -p 8791:8791 -v ohlab-hub:/data ohlab-hub
```

Check it with `curl http://127.0.0.1:8791/healthz`.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Readiness and version |
| `POST` | `/v1/pair/token` | Mint a ten-minute, single-use relay pairing token |
| `POST` | `/v1/relay/host-token` | Register a standing phone host |
| `POST` | `/v1/relay/device` | Register a phone for a standing host |
| `POST` | `/v1/relay/join` | Mint a client token for that standing host |
| `POST` | `/v1/relay/device/revoke` | Revoke a phone relay registration |
| `POST` | `/v1/accounts/challenge` | Start key-possession authentication |
| `POST` | `/v1/accounts/register` | Prove the challenge and receive a bearer session |
| `GET`, `POST` | `/v1/projects` | List or create shared projects |
| `POST` | `/v1/projects/join` | Join by invite code as a pending member |
| `GET` | `/v1/projects/:id/members` | List members, keys, approval, and online status |
| `POST` | `/v1/projects/:id/invite` | Regenerate an invite code as owner |
| `POST` | `/v1/projects/:id/members/:accountId/approve` | Approve a pending member as owner |
| `DELETE` | `/v1/projects/:id/members/:accountId` | Remove a member as owner |
| `POST` | `/v1/projects/:id/connect` | Broker an E2EE relay session to an online approved member |
| `GET`, `DELETE` | `/v1/admin/accounts[/:id]` | List or delete accounts with the admin bearer token |
| `GET`, `DELETE` | `/v1/admin/projects[/:id]` | List or delete projects with the admin bearer token |
| WebSocket | `/relay?token=...` | Forward opaque frames between the two token holders |
| WebSocket | `/dir?session=...` | Presence and directory events for one account |

## Connecting two homes

Tailscale is the recommended deployment. Install it on the Hub machine and both OhLab computers,
then enter `http://<hub-tailscale-name>:8791` in OhLab's Settings > Team. Traffic stays on the tailnet
and no public inbound port is needed.

For a public VPS, bind the Hub locally and put Caddy in front of it. Caddy supplies HTTPS/WSS and
must proxy WebSocket upgrades. For example:

```caddy
hub.example.com {
  reverse_proxy 127.0.0.1:8791
}
```

Enter `https://hub.example.com` in OhLab. The app derives `wss://hub.example.com/relay` and
`wss://hub.example.com/dir` automatically. Plain HTTP is appropriate only on a trusted private
network such as Tailscale. The Hub intentionally contains no TLS stack of its own.

## Key possession authentication

Accounts have no passwords. OhLab reuses its persistent NaCl box peer identity. The Hub encrypts a
fresh challenge to that public key with an ephemeral Hub box key; the desktop decrypts it and returns
the challenge once. A successful proof yields a one-hour bearer session. This avoids creating a
second identity while ensuring that publishing somebody else's public key cannot register or log in
as them.

The directory metadata is not end-to-end encrypted. Administrators of the Hub can see names, public
keys, project membership, presence, and connection timing. They cannot decrypt relayed terminal or
transcript bytes.
