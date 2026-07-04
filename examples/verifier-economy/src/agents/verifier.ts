/**
 * The verifier agent — the product this economy sells: a neutral third party that gets PAID to rule
 * on deliveries, with exactly the on-chain power the verifier program grants it (release or refund
 * this one order; never custody).
 *
 * Its verdict is code, not vibes (the kit's own rule — the model proposes, code disposes — applied
 * to arbitration): re-derive the order binding from the preimage, run the buyer's acceptance spec,
 * and only then sign. Every REJECTED ruling ships its failure list, so any party can recompute the
 * verdict from public data. Diligence is the business model: the fee pays out on either verdict, so
 * the verifier has no reason to favour a side — only to be right.
 */
import type { Keypair } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type { MarketBus } from '../bus.js'
import { parseWant, parseDeposited } from '@pay/agent-runtime'
import { parseDeliver, formatVerdict } from '../protocol.js'
import { judge, b64, unb64, specHash, type AcceptanceSpec } from '../spec.js'
import { referenceOf, preimageMatches } from '../reference.js'
import { makeVerifierProgram, verifyRelease, verifyRefund, explorer } from '../chain.js'

export interface VerifierConfig {
  name: string
  wallet: Keypair
  rpcUrl: string
}

interface Engagement {
  round: number
  reference: string
  preimage: string
  payer: PublicKey
  seller: PublicKey
  spec: AcceptanceSpec
  deadlineAt: number // ms epoch — verify_refund is only valid at/after this (escrow rule)
  delivered?: { by: string; payload: string }
  ruled?: boolean
}

/** Wire the verifier onto the market. It watches WANT (for the spec), DEPOSITED (for the order it
 * has been named on), DELIVER (for the work), then rules — releasing promptly, refunding at the
 * deadline the escrow enforces. */
export function runVerifier(bus: MarketBus, cfg: VerifierConfig): void {
  // Specs are keyed by their own sha256 — NOT by a forgeable round number. This is what stops a
  // third party from overwriting the buyer's spec with a weaker one (round-collision griefing): the
  // spec a verifier rules with is selected by the hash the order provably commits to, below.
  const specsByHash = new Map<string, AcceptanceSpec>()
  const engagements = new Map<string, Engagement>()
  const program = makeVerifierProgram(cfg.wallet, cfg.rpcUrl)

  const rule = async (e: Engagement): Promise<void> => {
    if (e.ruled) return
    e.ruled = true
    const reference = new PublicKey(e.reference)

    if (e.delivered) {
      const verdict = judge(e.delivered.payload, e.spec)
      if (verdict.pass) {
        const sig = await verifyRelease(program, cfg.wallet, e.seller, e.payer, reference)
        bus.post(cfg.name, formatVerdict({ round: e.round, reference: e.reference, result: 'VERIFIED', sig }))
        console.log(`[${cfg.name}] release ${explorer('tx', sig)}`)
        return
      }
      bus.post(cfg.name, formatVerdict({
        round: e.round, reference: e.reference, result: 'REJECTED',
        reason: b64(verdict.failures.join('; ')),
      }))
      console.log(`[${cfg.name}] rejected round ${e.round}: ${verdict.failures.join('; ')}`)
    } else {
      bus.post(cfg.name, formatVerdict({ round: e.round, reference: e.reference, result: 'REJECTED', reason: b64('no delivery by deadline') }))
    }

    // Refund path: the escrow only allows refund at/after its deadline — wait it out, then rule.
    const waitMs = Math.max(0, e.deadlineAt - Date.now()) + 2_000 // +2s clock skew headroom
    await new Promise((r) => setTimeout(r, waitMs))
    const sig = await verifyRefund(program, cfg.wallet, e.payer, reference)
    bus.post(cfg.name, formatVerdict({ round: e.round, reference: e.reference, result: 'REJECTED', sig }))
    console.log(`[${cfg.name}] refund ${explorer('tx', sig)}`)
  }

  bus.onMessage(({ from, text }) => {
    if (from === cfg.name) return

    const want = parseWant(text)
    if (want) {
      // The spec rides the WANT as spec=<b64 json>; kit parsers ignore it, we require it. Store it
      // under its own hash (not the round) so a later WANT can never silently replace it.
      const specB64 = text.match(/spec=(\S+)/)?.[1]
      if (specB64) {
        try { const spec = JSON.parse(unb64(specB64)) as AcceptanceSpec; specsByHash.set(specHash(spec), spec) }
        catch { /* a malformed spec is simply not registered — it can never be ruled on */ }
      }
      return
    }

    const dep = parseDeposited(text)
    if (dep) {
      // Only engage on orders that name THIS verifier and whose reference provably commits to a spec
      // we were actually shown on the market — refuse to rule on anything else.
      const verifier = text.match(/verifier=(\S+)/)?.[1]
      const preimage = text.match(/preimage=(\S+)/)?.[1]
      const seller = text.match(/seller=(\S+)/)?.[1]
      const deadlineTs = Number(text.match(/deadlineAt=(\d+)/)?.[1])
      if (verifier !== cfg.wallet.publicKey.toBase58() || !preimage || !seller) return
      const pre = unb64(preimage)
      // Resolve the spec by the hash the ORDER commits to — pinned by sha256 into the on-chain
      // reference — so it cannot be swapped for a weaker one. Then re-verify the full binding.
      const committedHash = pre.match(/:spec=([0-9a-f]{64}):/)?.[1]
      const spec = committedHash ? specsByHash.get(committedHash) : undefined
      if (!spec || referenceOf(pre).toBase58() !== dep.reference || !preimageMatches(pre, dep.round, spec)) {
        bus.post(cfg.name, formatVerdict({ round: dep.round, reference: dep.reference, result: 'REJECTED', reason: b64('order binding does not match a spec advertised on the market') }))
        return
      }
      const e: Engagement = {
        round: dep.round, reference: dep.reference, preimage: pre,
        payer: new PublicKey(dep.buyer), seller: new PublicKey(seller),
        spec, deadlineAt: Number.isFinite(deadlineTs) ? deadlineTs * 1000 : Date.now() + 60_000,
      }
      engagements.set(dep.reference, e)
      // No-show timer: if nothing is delivered by the deadline, rule on absence.
      setTimeout(() => { void rule(e).catch((err) => console.error(`[${cfg.name}]`, err)) }, Math.max(0, e.deadlineAt - Date.now()) + 500)
      return
    }

    const del = parseDeliver(text)
    if (del) {
      const e = engagements.get(del.reference)
      if (!e || e.ruled) return
      e.delivered = { by: del.by, payload: del.payload }
      void rule(e).catch((err) => console.error(`[${cfg.name}]`, err))
    }
  })
}
