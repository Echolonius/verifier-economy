/**
 * Full market-round integration test with the CHAIN mocked — proves the agent choreography (bid →
 * award → open → deliver → verdict → reputation) without a funded wallet, the same way the kit
 * e2e-tests its round logic. The on-chain legs are covered by the program's constraints + the
 * devnet demo; this covers everything the agents decide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@solana/web3.js'

const sent: string[] = []
vi.mock('./chain.js', () => ({
  makeVerifierProgram: () => ({}),
  openOrder: vi.fn(async () => { sent.push('open'); return 'OPEN_SIG' }),
  verifyRelease: vi.fn(async () => { sent.push('release'); return 'RELEASE_SIG' }),
  verifyRefund: vi.fn(async () => { sent.push('refund'); return 'REFUND_SIG' }),
  vaultPda: () => Keypair.generate().publicKey,
  explorer: (k: string, id: string) => `mock://${k}/${id}`,
}))

const { MarketBus } = await import('./bus.js')
const { runSeller } = await import('./agents/seller.js')
const { runVerifier } = await import('./agents/verifier.js')
const { runRound } = await import('./agents/buyer.js')
const { parseVerdict } = await import('./protocol.js')
const { INVOICE_SPEC, JOBS } = await import('./data.js')

const personas = () => ({
  honest: { name: 'atlas-extracts', wallet: Keypair.generate(), conduct: 'honest' as const, floorSol: 0.006 },
  slop: { name: 'quickparse-99', wallet: Keypair.generate(), conduct: 'slop' as const, floorSol: 0.004 },
})

describe('a full round on the bus (chain mocked)', () => {
  beforeEach(() => { sent.length = 0 })

  const cfg = (payer: Keypair, verifier: Keypair) => ({
    name: 'procura', wallet: payer, rpcUrl: 'mock', verifier: verifier.publicKey,
    feeSol: 0.002, budgetSol: 0.02, deadlineSecs: 2, graceSecs: 60, bidWindowMs: 300,
  })

  it('slop wins on price, gets REJECTED with reasons, and the refund settles', async () => {
    const bus = new MarketBus()
    const { honest, slop } = personas()
    const payer = Keypair.generate(); const verifier = Keypair.generate()
    runSeller(bus, honest); runSeller(bus, slop)
    runVerifier(bus, { name: 'veritas', wallet: verifier, rpcUrl: 'mock' })

    const settledP = bus.waitFor(({ text }) => { const v = parseVerdict(text); return v?.sig ? v : null }, 15_000)
    const result = await runRound(bus, cfg(payer, verifier), 1, JOBS[0].docId, INVOICE_SPEC,
      (name) => [honest, slop].find((p) => p.name === name)?.wallet.publicKey)

    expect(result?.winner.by).toBe('quickparse-99') // cheapest bid wins
    const settled = await settledP
    expect(settled?.result).toBe('REJECTED')
    expect(settled?.sig).toBe('REFUND_SIG')
    expect(sent).toEqual(['open', 'refund'])
    // The rejection reason is on the wire, recomputable by anyone.
    const reasons = bus.log.map((e) => e.text).filter((t) => t.includes('result=REJECTED') && t.includes('reason='))
    expect(reasons.join(' ')).toContain('reason=')
  })

  it('honest seller wins when slop is reputation-filtered, and the release settles', async () => {
    const bus = new MarketBus()
    const { honest, slop } = personas()
    const payer = Keypair.generate(); const verifier = Keypair.generate()
    runSeller(bus, honest); runSeller(bus, slop)
    runVerifier(bus, { name: 'veritas', wallet: verifier, rpcUrl: 'mock' })

    const settledP = bus.waitFor(({ text }) => { const v = parseVerdict(text); return v?.sig ? v : null }, 15_000)
    const result = await runRound(bus, cfg(payer, verifier), 2, JOBS[0].docId, INVOICE_SPEC,
      (name) => (name === slop.name ? undefined : [honest].find((p) => p.name === name)?.wallet.publicKey))

    expect(result?.winner.by).toBe('atlas-extracts')
    const settled = await settledP
    expect(settled?.result).toBe('VERIFIED')
    expect(settled?.sig).toBe('RELEASE_SIG')
    expect(sent).toEqual(['open', 'release'])
  })

  it('no delivery → ruled at the deadline as REJECTED (refund)', async () => {
    const bus = new MarketBus()
    const payer = Keypair.generate(); const verifier = Keypair.generate()
    const ghost = { name: 'ghostworks', wallet: Keypair.generate(), conduct: 'noshow' as const, floorSol: 0.005 }
    runSeller(bus, ghost)
    runVerifier(bus, { name: 'veritas', wallet: verifier, rpcUrl: 'mock' })

    const settledP = bus.waitFor(({ text }) => { const v = parseVerdict(text); return v?.sig ? v : null }, 15_000)
    await runRound(bus, cfg(payer, verifier), 3, JOBS[1].docId, INVOICE_SPEC,
      (name) => (name === ghost.name ? ghost.wallet.publicKey : undefined))

    const settled = await settledP
    expect(settled?.result).toBe('REJECTED')
    expect(sent).toEqual(['open', 'refund'])
  }, 20_000)
})
