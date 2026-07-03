/**
 * The market bus — an in-process message board speaking the exact wire format CoralOS threads move
 * (opaque strings, correlated by the `round` tag; see packages/agent-runtime/src/market). Agents
 * publish and subscribe here the way they'd post to a coral-server thread, so the demo runs with
 * zero infrastructure (no Docker), and swapping this file for the runtime's CoralOS client moves
 * the same agents onto a real multi-process deployment unchanged.
 *
 * It also serves the dashboard: `GET /events` streams every message (plus wallet snapshots the
 * orchestrator pushes) as SSE, the same pattern as the marketplace example's feed.
 */
import { EventEmitter } from 'node:events'
import http from 'node:http'

export interface BusEvent {
  at: number
  from: string
  text: string
}

export class MarketBus {
  private readonly emitter = new EventEmitter()
  readonly log: BusEvent[] = []

  post(from: string, text: string): void {
    const ev: BusEvent = { at: Date.now(), from, text }
    this.log.push(ev)
    console.log(`[${from}] ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`)
    this.emitter.emit('message', ev)
  }

  /** Subscribe to every market message; returns the unsubscribe. */
  onMessage(fn: (ev: BusEvent) => void): () => void {
    this.emitter.on('message', fn)
    return () => this.emitter.off('message', fn)
  }

  /** Wait for the first message satisfying `match` (optionally within `timeoutMs`; null on timeout). */
  waitFor<T>(match: (ev: BusEvent) => T | null, timeoutMs?: number): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = timeoutMs
        ? setTimeout(() => { off(); resolve(null) }, timeoutMs)
        : undefined
      const off = this.onMessage((ev) => {
        const hit = match(ev)
        if (hit !== null) {
          if (timer) clearTimeout(timer)
          off()
          resolve(hit)
        }
      })
    })
  }

  /** Serve the SSE feed (+ the whole log so a late-opened dashboard replays the session). */
  serve(port: number): http.Server {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.url?.startsWith('/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        for (const ev of this.log) res.write(`data: ${JSON.stringify(ev)}\n\n`)
        const off = this.onMessage((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`))
        req.on('close', off)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(this.log))
      }
    })
    server.listen(port, () => console.log(`[bus] SSE feed on http://localhost:${port}/events`))
    return server
  }
}
