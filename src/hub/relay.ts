import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { HubTokenStore } from './tokens'

interface WaitingPeer {
  ws: WebSocket
  token: string
  queued: Array<{ data: Buffer; binary: boolean }>
  queuedBytes: number
}

export interface HubRelay {
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void
  close(): void
}

export function createRelay(tokens: HubTokenStore, log: (line: string) => void = console.log): HubRelay {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  const waiting = new Map<string, WaitingPeer>()
  const joining = new Set<string>()
  const peers = new Map<WebSocket, WebSocket>()

  const label = (req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown'

  function closePair(ws: WebSocket, code = 1000, reason = 'peer closed'): void {
    const peer = peers.get(ws)
    peers.delete(ws)
    if (peer) {
      peers.delete(peer)
      const outboundCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1001
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close(outboundCode, reason)
    }
  }

  wss.on('connection', (ws, req, token: string, roomId: string) => {
    log(`[hub:relay] connect room=${roomId} from=${label(req)}`)
    const first = waiting.get(roomId)
    if (!first || first.ws.readyState !== WebSocket.OPEN) {
      waiting.set(roomId, { ws, token, queued: [], queuedBytes: 0 })
    } else {
      waiting.delete(roomId)
      peers.set(first.ws, ws)
      peers.set(ws, first.ws)
      void tokens.consume([first.token, token])
      for (const frame of first.queued) ws.send(frame.data, { binary: frame.binary })
      log(`[hub:relay] bridge room=${roomId}`)
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const peer = peers.get(ws)
      if (peer?.readyState === WebSocket.OPEN) {
        if (peer.bufferedAmount > 8 * 1024 * 1024) {
          ws.close(1009, 'relay backpressure limit')
          return
        }
        peer.send(data, { binary: isBinary })
        return
      }
      const pending = waiting.get(roomId)
      if (pending?.ws === ws) {
        const frame = Buffer.from(data as ArrayBuffer)
        pending.queuedBytes += frame.byteLength
        if (pending.queuedBytes > 8 * 1024 * 1024) {
          waiting.delete(roomId)
          ws.close(1009, 'relay queue limit')
          return
        }
        pending.queued.push({ data: frame, binary: isBinary })
      }
    })
    ws.on('close', (code) => {
      if (waiting.get(roomId)?.ws === ws) waiting.delete(roomId)
      closePair(ws, code === 1005 ? 1000 : code || 1000)
      log(`[hub:relay] close room=${roomId} code=${code}`)
    })
    ws.on('error', () => closePair(ws, 1011, 'relay socket error'))
  })

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }
  }, 30_000)
  ping.unref()

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://hub.invalid')
      const token = url.searchParams.get('token') ?? ''
      const item = tokens.resolve(token)
      if (!item) {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'unknown or expired token'))
        return
      }
      const occupied = waiting.get(item.roomId)
      if (joining.has(item.roomId) || (occupied && peers.has(occupied.ws))) {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'token already bridged'))
        return
      }
      if (occupied) joining.add(item.roomId)
      wss.handleUpgrade(req, socket, head, (ws) => {
        joining.delete(item.roomId)
        wss.emit('connection', ws, req, token, item.roomId)
      })
    },
    close() {
      clearInterval(ping)
      for (const ws of wss.clients) ws.close(1001, 'hub shutting down')
      wss.close()
      waiting.clear()
      joining.clear()
      peers.clear()
    }
  }
}
