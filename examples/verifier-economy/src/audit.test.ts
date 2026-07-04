/**
 * The accountability proof: an independent auditor, using only public data, catches a verifier that
 * settled against its own checks. This is what makes "who verifies the verifier" answerable —
 * determinism turns a wrong verdict into an objective, provable fact (the base a stake/slash layer needs).
 */
import { describe, expect, it } from 'vitest'
import { auditVerdict, misconductCertificate } from './audit.js'
import { bindOrder, hashInput } from './reference.js'
import { b64, type AcceptanceSpec } from './spec.js'

const SPEC: AcceptanceSpec = {
  service: 'invoice-extraction',
  fields: { vendor: { type: 'string' }, total: { type: 'number' } },
  itemFields: { amount: { type: 'number' } },
  invariants: ['items-nonempty', 'total-equals-item-sum'],
}
const { reference, preimage } = bindOrder(1, SPEC, 42)
const ref = reference.toBase58()

const good = b64(JSON.stringify({ vendor: 'ACME', total: 100, items: [{ amount: 60 }, { amount: 40 }] }))
const slop = b64(JSON.stringify({ vendor: 'ACME', total: 778, items: [{ amount: 300 }, { amount: 120 }] })) // 420 ≠ 778

describe('independent verdict audit (who verifies the verifier)', () => {
  it('confirms an honest release (checks pass → released)', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: good, onchainReference: ref, outcome: 'released' })
    expect(r.bindingValid).toBe(true)
    expect(r.recomputedPass).toBe(true)
    expect(r.verifierHonest).toBe(true)
  })

  it('confirms an honest refund (checks fail → refunded)', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: slop, onchainReference: ref, outcome: 'refunded' })
    expect(r.recomputedPass).toBe(false)
    expect(r.verifierHonest).toBe(true)
  })

  it('CATCHES a lying verifier that released on slop', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: slop, onchainReference: ref, outcome: 'released' })
    expect(r.recomputedPass).toBe(false)
    expect(r.verifierHonest).toBe(false) // provable misconduct
    expect(r.reason).toContain('misconduct')
  })

  it('CATCHES a release when nothing was ever delivered', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: null, onchainReference: ref, outcome: 'released' })
    expect(r.verifierHonest).toBe(false)
  })

  it('rejects a forged binding (preimage does not commit to this reference)', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: good, onchainReference: 'So11111111111111111111111111111111111111112', outcome: 'released' })
    expect(r.bindingValid).toBe(false)
    expect(r.verifierHonest).toBe(false)
  })

  it('treats a payer reclaim as honest-by-construction (verifier went dark)', () => {
    const r = auditVerdict({ preimage, spec: SPEC, round: 1, payloadB64: null, onchainReference: ref, outcome: 'reclaimed' })
    expect(r.verifierHonest).toBe(true)
  })

  it('CATCHES a verdict rendered for a swapped input when the order committed to the input', () => {
    // An order bound to a specific input; the seller then claims it worked on a DIFFERENT input.
    // Even though the delivery passes the checks, it was judged for the wrong task — provable.
    const trueInput = 'INVOICE A — total 100'
    const ih = hashInput(trueInput)
    const bound = bindOrder(1, SPEC, 42, ih)
    const boundRef = bound.reference.toBase58()
    const honest = auditVerdict({
      preimage: bound.preimage, spec: SPEC, round: 1, payloadB64: good,
      onchainReference: boundRef, outcome: 'released', claimedInput: trueInput,
    })
    expect(honest.committedInput).toBe(ih)
    expect(honest.verifierHonest).toBe(true)

    const swapped = auditVerdict({
      preimage: bound.preimage, spec: SPEC, round: 1, payloadB64: good,
      onchainReference: boundRef, outcome: 'released', claimedInput: 'INVOICE B — a different job',
    })
    expect(swapped.verifierHonest).toBe(false)
    expect(swapped.reason).toContain('does not match the input')
  })
})

describe('misconduct certificate (the slashing-ready proof)', () => {
  it('emits nothing when the verifier was honest', () => {
    expect(misconductCertificate({ preimage, spec: SPEC, round: 1, payloadB64: good, onchainReference: ref, outcome: 'released' })).toBeNull()
  })

  it('emits a self-verifying certificate for a lying verifier that ANYONE can re-check', () => {
    const input = { preimage, spec: SPEC, round: 1, payloadB64: slop, onchainReference: ref, outcome: 'released' as const }
    const cert = misconductCertificate(input)
    expect(cert).not.toBeNull()
    expect(cert!.kind).toBe('verifier-misconduct')
    // The certificate is self-verifying: an independent party re-runs the audit on its bundled
    // evidence and MUST reproduce the same finding — no trust in whoever reported it.
    const recheck = auditVerdict(cert!.evidence)
    expect(recheck.verifierHonest).toBe(false)
    expect(recheck.reason).toBe(cert!.finding.reason)
  })
})
