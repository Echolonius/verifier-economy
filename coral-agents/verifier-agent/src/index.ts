/**
 * Verifier agent for the CoralOS runtime — the same referee as the in-process demo, deployed as a
 * first-class Coral agent (coral-server discovers it from coral-agent.toml and launches it). It joins
 * the shared market thread, and when a buyer opens an order that NAMES it, it re-derives the order
 * binding, runs the buyer's acceptance spec against the delivery, and signs the escrow settlement.
 *
 * Transport is the only difference from `examples/verifier-economy`: mentions/replies over the CoralOS
 * MCP client instead of the in-process bus. The verdict logic, the order binding, and the on-chain
 * settlement are the identical, unit-tested modules (copied verbatim from the example).
 */
import { PublicKey } from '@solana/web3.js'
import { startCoralAgent, parseWant, parseDeposited, loadKeypairB58 } from '@pay/agent-runtime'
import { parseDeliver, formatVerdict } from './protocol.js'
import { judge, b64, unb64, specHash, validateSpec, type AcceptanceSpec } from './spec.js'
import { referenceOf, preimageMatches } from './reference.js'
import { makeVerifierProgram, verifyRelease, verifyRefund } from './chain.js'

const NAME = process.env.AGENT_NAME ?? 'verifier-agent'
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'
const wallet = loadKeypairB58(process.env.VERIFIER_KEYPAIR_B58 ?? '')

interface Engagement {
  round: number
  reference: string
  threadId: string
  payer: PublicKey
  seller: PublicKey
  spec: AcceptanceSpec
  deadlineAt: number
  delivered?: string
  ruled?: boolean
}

await startCoralAgent({ agentName: NAME }, async (ctx) => {
  const program = makeVerifierProgram(wallet, RPC)
  const specsByHash = new Map<string, AcceptanceSpec>() // by hash, never by forgeable round
  const engagements = new Map<string, Engagement>()
  console.error(`[${NAME}] ready: verifier=${wallet.publicKey.toBase58()} rpc=${RPC}`)

  const post = async (threadId: string, content: string) => ctx.send(content, threadId, []).catch((e) => console.error(`[${NAME}] send:`, e))

  const rule = async (e: Engagement): Promise<void> => {
    if (e.ruled) return
    e.ruled = true
    const reference = new PublicKey(e.reference)
    if (e.delivered) {
      // Belt-and-brace: judge() never throws, but an unexpected throw must become a refund, never an
      // escaped exception that leaves the order ruled-but-unsettled (honest seller stranded).
      let verdict
      try { verdict = judge(e.delivered, e.spec) }
      catch (err) { verdict = { pass: false, failures: [`verifier error: ${String(err)}`] } }
      if (verdict.pass) {
        const sig = await verifyRelease(program, wallet, e.seller, e.payer, reference)
        await post(e.threadId, formatVerdict({ round: e.round, reference: e.reference, result: 'VERIFIED', sig }))
        return
      }
      await post(e.threadId, formatVerdict({ round: e.round, reference: e.reference, result: 'REJECTED', reason: b64(verdict.failures.join('; ')) }))
    } else {
      await post(e.threadId, formatVerdict({ round: e.round, reference: e.reference, result: 'REJECTED', reason: b64('no delivery by deadline') }))
    }
    // Refund is only valid at/after the escrow deadline — wait it out, then settle.
    await new Promise((r) => setTimeout(r, Math.max(0, e.deadlineAt - Date.now()) + 2_000))
    const sig = await verifyRefund(program, wallet, e.payer, reference)
    await post(e.threadId, formatVerdict({ round: e.round, reference: e.reference, result: 'REJECTED', sig }))
  }

  while (true) {
    try {
      const mention = await ctx.waitForMention()
      if (!mention) continue
      const text = mention.text.trim()
      const threadId = mention.threadId ?? ''

      const want = parseWant(text)
      if (want) {
        const specB64 = text.match(/spec=(\S+)/)?.[1]
        if (specB64) {
          try {
            const s = JSON.parse(unb64(specB64)) as AcceptanceSpec
            // Refuse an unusable spec (e.g. an uncompilable regex) so no order can bind to it and
            // later strand — same guard as the in-process referee.
            if (validateSpec(s).length === 0) specsByHash.set(specHash(s), s)
          } catch { /* ignore malformed */ }
        }
        continue
      }

      const dep = parseDeposited(text)
      if (dep) {
        const verifier = text.match(/verifier=(\S+)/)?.[1]
        const preimage = text.match(/preimage=(\S+)/)?.[1]
        const seller = text.match(/seller=(\S+)/)?.[1]
        const deadlineTs = Number(text.match(/deadlineAt=(\d+)/)?.[1])
        if (verifier !== wallet.publicKey.toBase58() || !preimage || !seller) continue
        const pre = unb64(preimage)
        const committedHash = pre.match(/:spec=([0-9a-f]{64}):/)?.[1]
        const spec = committedHash ? specsByHash.get(committedHash) : undefined
        if (!spec || referenceOf(pre).toBase58() !== dep.reference || !preimageMatches(pre, dep.round, spec)) {
          await post(threadId, formatVerdict({ round: dep.round, reference: dep.reference, result: 'REJECTED', reason: b64('order binding does not match a spec advertised on the market') }))
          continue
        }
        const e: Engagement = {
          round: dep.round, reference: dep.reference, threadId,
          payer: new PublicKey(dep.buyer), seller: new PublicKey(seller), spec,
          deadlineAt: Number.isFinite(deadlineTs) ? deadlineTs * 1000 : Date.now() + 60_000,
        }
        engagements.set(dep.reference, e)
        setTimeout(() => { void rule(e).catch((err) => console.error(`[${NAME}]`, err)) }, Math.max(0, e.deadlineAt - Date.now()) + 500)
        continue
      }

      const del = parseDeliver(text)
      if (del) {
        const e = engagements.get(del.reference)
        if (e && !e.ruled) { e.delivered = del.payload; void rule(e).catch((err) => console.error(`[${NAME}]`, err)) }
      }
    } catch (e) {
      console.error(`[${NAME}] loop error:`, e)
    }
  }
})
