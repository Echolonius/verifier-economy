/**
 * The buyer agent — software with a budget. It broadcasts a job (WANT + the acceptance spec it
 * will hold the winner to), takes the market's best price, and opens a VERIFIED order: deposit,
 * escrow rent, and the verifier's fee all leave its wallet in one `open`, and from that moment the
 * buyer has no unilateral power over the money — the named verifier's verdict settles it.
 *
 * That's the economic point of the demo: taking the cheapest bid is only safe when a paid neutral
 * check stands between delivery and payment. The buyer buys work AND buys trust, priced separately.
 */
import type { Keypair } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type { MarketBus } from '../bus.js'
import { formatWant, formatAward, formatDeposited, parseBid, selectBids, pickCheapest, type Bid } from '@pay/agent-runtime'
import { b64, type AcceptanceSpec } from '../spec.js'
import { bindOrder } from '../reference.js'
import { makeVerifierProgram, openOrder, vaultPda, explorer } from '../chain.js'

export interface BuyerConfig {
  name: string
  wallet: Keypair
  rpcUrl: string
  verifier: PublicKey
  feeSol: number
  budgetSol: number
  /** Escrow refund deadline, seconds from open — short in the demo so the REFUNDED path is watchable. */
  deadlineSecs: number
  /** Added to the deadline for `reclaim_after` (the verifier-liveness backstop). */
  graceSecs: number
  bidWindowMs: number
}

export interface RoundResult {
  round: number
  winner: Bid
  reference: string
  openSig: string
  deadlineAt: number
}

/** Run one procurement round: WANT -> collect BIDs -> AWARD cheapest -> open the verified order. */
export async function runRound(
  bus: MarketBus, cfg: BuyerConfig, round: number, docId: string, spec: AcceptanceSpec,
  sellerWalletOf: (name: string) => PublicKey | undefined,
): Promise<RoundResult | null> {
  const bids: Bid[] = []
  const off = bus.onMessage(({ text }) => {
    const bid = parseBid(text)
    if (bid && bid.round === round) bids.push(bid)
  })

  bus.post(cfg.name, `${formatWant({ round, service: spec.service, arg: docId, budgetSol: cfg.budgetSol })} spec=${b64(JSON.stringify(spec))}`)
  await new Promise((r) => setTimeout(r, cfg.bidWindowMs))
  off()

  const candidates = selectBids(bids, round).filter((b) => b.priceSol <= cfg.budgetSol && sellerWalletOf(b.by))
  const winner = pickCheapest(candidates)
  if (!winner) { bus.post(cfg.name, `NO_AWARD round=${round} (no eligible bids)`); return null }
  bus.post(cfg.name, formatAward(round, winner.by, `best price ${winner.priceSol} SOL of ${candidates.length} bids`))

  // One on-chain move: deposit + rent + verifier fee into the vault; the escrow now answers only
  // to the verifier. The DEPOSITED broadcast carries everything the verifier needs to engage.
  const { reference, preimage } = bindOrder(round, spec, Date.now())
  const program = makeVerifierProgram(cfg.wallet, cfg.rpcUrl)
  const openSig = await openOrder(program, cfg.wallet, {
    seller: sellerWalletOf(winner.by)!,
    verifier: cfg.verifier,
    reference,
    amountSol: winner.priceSol,
    feeSol: cfg.feeSol,
    deadlineSecs: cfg.deadlineSecs,
    graceSecs: cfg.graceSecs,
  })
  const deadlineAt = Math.floor(Date.now() / 1000) + cfg.deadlineSecs
  bus.post(cfg.name, [
    formatDeposited({ round, reference: reference.toBase58(), buyer: cfg.wallet.publicKey.toBase58(), sig: openSig, settlement: 'arbiter', vault: vaultPda(reference).toBase58() }),
    `verifier=${cfg.verifier.toBase58()}`,
    `seller=${sellerWalletOf(winner.by)!.toBase58()}`,
    `fee=${cfg.feeSol}`,
    `deadlineAt=${deadlineAt}`,
    `preimage=${b64(preimage)}`,
  ].join(' '))
  console.log(`[${cfg.name}] open ${explorer('tx', openSig)}`)

  return { round, winner, reference: reference.toBase58(), openSig, deadlineAt }
}
