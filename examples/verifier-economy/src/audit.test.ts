/**
 * The accountability proof: an independent auditor, using only public data, catches a verifier that
 * settled against its own checks. This is what makes "who verifies the verifier" answerable —
 * determinism turns a wrong verdict into an objective, provable fact (the base a stake/slash layer needs).
 */
import { describe, expect, it } from 'vitest'
import { auditVerdict } from './audit.js'
import { bindOrder } from './reference.js'
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
})
