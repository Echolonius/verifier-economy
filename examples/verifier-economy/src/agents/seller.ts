/**
 * Seller agents — personas competing for extraction work. The persona (floor price, how it actually
 * does the work) is config, exactly like the kit's coral-agents/seller personas:
 *
 *   - `honest` does the extraction properly (LLM if a key is configured, deterministic parser
 *     otherwise — the demo stays reproducible with zero keys).
 *   - `slop`   underbids everyone and delivers something that LOOKS right (valid JSON! plausible
 *     fields!) but fails the buyer's invariants — the adverse selection that makes unverified
 *     price competition unsafe.
 *   - `noshow` bids and never delivers.
 *
 * Sellers never touch the chain here: they receive on release, so they hold no funded key at all.
 */
import type { Keypair } from '@solana/web3.js'
import { complete } from '@pay/agent-runtime'
import type { MarketBus } from '../bus.js'
import { formatBid, parseWant, parseAward, parseDeposited, type Want } from '@pay/agent-runtime'
import { formatDeliver } from '../protocol.js'
import { b64, unb64 } from '../spec.js'
import { jobById } from '../data.js'

export type SellerConduct = 'honest' | 'slop' | 'noshow'

export interface SellerPersona {
  name: string
  wallet: Keypair
  conduct: SellerConduct
  /** Lowest price this persona will work for, in SOL. */
  floorSol: number
}

/** Deterministic extraction that actually reads the document — the honest seller's fallback brain,
 * and the reason the demo needs no LLM key to be correct. */
export function extractInvoice(document: string): Record<string, unknown> {
  const lines = document.split('\n').map((l) => l.trim()).filter(Boolean)
  const text = document
  const invoiceNo = text.match(/(?:invoice\s*#|\binv\b|\bno\.)\s*:?\s*([A-Z]{2}-?[A-Z0-9-]+)/i)?.[1]?.toUpperCase()
  const date = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
  const currency = text.match(/\b(USD|EUR)\b/)?.[1]
  const vendor = lines[0]?.replace(/[—\-\/|].*$/, '').replace(/invoice/i, '').trim()

  // Line items: "description .... 123.45" rows, with "Nx ... 12.34 ea" quantity handling.
  const items: { description: string; amount: number }[] = []
  for (const line of lines) {
    if (/total|amount due|balance/i.test(line)) continue
    const m = line.match(/^(.*?)[\s.]{2,}(\d+(?:\.\d{1,2})?)(\s*ea\b)?/i)
    if (!m) continue
    const qty = Number(m[1].match(/^(\d+)x\b/i)?.[1] ?? '1')
    const unit = Number(m[2])
    const description = m[1].replace(/^\d+x\s*/i, '').replace(/[\s.]+$/, '').trim()
    if (description) items.push({ description, amount: Math.round(qty * unit * 100) / 100 })
  }
  // Inline "@ 45.00" rate rows (no dot leaders), e.g. "Chassis rental, 2 days @ 45.00   90.00".
  const total = Number(text.match(/(?:total(?: due)?|amount due|balance due)[:\s]*([\d,]+\.\d{2})/i)?.[1]?.replace(',', ''))

  return {
    vendor, invoiceNo, date, currency,
    total: Number.isFinite(total) ? total : items.reduce((a, i) => a + i.amount, 0),
    items,
  }
}

/** A convincing-but-wrong delivery: right shape, made-up numbers. */
function slopInvoice(document: string): Record<string, unknown> {
  const honest = extractInvoice(document)
  const items = (honest.items as { description: string; amount: number }[]).slice(0, 1)
  return { ...honest, items, total: honest.total } // drops line items; total no longer sums
}

async function produce(persona: SellerPersona, docId: string): Promise<string | null> {
  const job = jobById(docId)
  if (!job || persona.conduct === 'noshow') return null
  if (persona.conduct === 'slop') return b64(JSON.stringify(slopInvoice(job.document)))
  // honest: LLM proposes when configured; the deterministic parser is both fallback and guard.
  const deterministic = extractInvoice(job.document)
  try {
    if (process.env.VENICE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
      const reply = await complete({
        system: 'You extract invoices to JSON. Reply with JSON only — no prose, no code fences.',
        user: `Fields: vendor, invoiceNo, date (ISO), currency, total, items[{description, amount}].\n\n${job.document}`,
      })
      const parsed = JSON.parse(reply.trim().replace(/^```json?|```$/g, ''))
      // The model proposes, code disposes: only ship the LLM's read if it agrees on the money.
      if (typeof parsed?.total === 'number' && Math.abs(parsed.total - (deterministic.total as number)) < 0.005)
        return b64(JSON.stringify(parsed))
    }
  } catch { /* fall through to the deterministic read */ }
  return b64(JSON.stringify(deterministic))
}

/** Wire a seller onto the market: bid on WANTs, deliver (per conduct) once awarded + escrowed. */
export function runSeller(bus: MarketBus, persona: SellerPersona): void {
  const wants = new Map<number, Want>()
  let pendingAward: number | null = null

  bus.onMessage(({ from, text }) => {
    if (from === persona.name) return
    const want = parseWant(text)
    if (want) {
      wants.set(want.round, want)
      // Persona pricing: floor plus a persona-stable margin; slop undercuts to win on price.
      const margin = persona.conduct === 'slop' ? 0 : 0.25 + (persona.name.length % 3) * 0.15
      const price = Math.min(want.budgetSol, Math.round(persona.floorSol * (1 + margin) * 1e6) / 1e6)
      bus.post(persona.name, formatBid({ round: want.round, priceSol: price, by: persona.name, note: `conduct-profile:${persona.conduct === 'honest' ? 'standard' : 'value'}` }))
      return
    }
    const award = parseAward(text)
    if (award && award.to === persona.name) { pendingAward = award.round; return }
    const dep = parseDeposited(text)
    if (dep && pendingAward === dep.round) {
      pendingAward = null
      const want = wants.get(dep.round)
      if (!want) return
      void produce(persona, want.arg).then((payload) => {
        if (payload)
          bus.post(persona.name, formatDeliver({ round: dep.round, reference: dep.reference, by: persona.name, payload }))
        // noshow: silence — the deadline and the verifier handle the rest.
      })
    }
  })
}

export { unb64 }
