/**
 * Independent verdict audit — the answer to "who verifies the verifier?".
 *
 * A paid verifier you simply trust is a weak guarantee (the failure mode the RAILS paper and the
 * ERC-8004 discourse tackle with staking + slashing). This design's edge is that its verdicts are
 * **deterministic and reproducible**, so a wrong verdict is *objectively provable* by anyone — which
 * is the precondition any staking/challenge layer needs to slash on.
 *
 * `auditVerdict` re-derives everything from PUBLIC data — the order preimage, the buyer's spec, the
 * delivered payload, and the settlement outcome read off-chain — and reports whether the verifier
 * ruled honestly. No trust in the verifier required; the math is checked, not believed.
 */
import type { AcceptanceSpec } from './spec.js'
import { judge } from './spec.js'
import { referenceOf, preimageMatches } from './reference.js'

/** What actually happened on-chain, read from the settlement transaction. */
export type Outcome = 'released' | 'refunded' | 'reclaimed'

export interface AuditInput {
  preimage: string
  spec: AcceptanceSpec
  round: number
  /** base64url delivery the seller posted (or null if it never delivered). */
  payloadB64: string | null
  /** the escrow reference the order actually settled (base58), read on-chain. */
  onchainReference: string
  /** the settlement outcome, read on-chain. */
  outcome: Outcome
}

export interface AuditResult {
  /** Does the order provably commit to this exact spec, at this reference? */
  bindingValid: boolean
  /** The independently recomputed verdict (null when there was no delivery to judge). */
  recomputedPass: boolean | null
  /** Recomputed failure reasons — anyone gets the identical list. */
  recomputedFailures: string[]
  /** Did the verifier's on-chain action match what the checks actually say? */
  verifierHonest: boolean
  reason: string
}

export function auditVerdict(input: AuditInput): AuditResult {
  const { preimage, spec, round, payloadB64, onchainReference, outcome } = input

  // 1) Binding: the preimage must hash to the settled reference AND commit to this spec. If not, the
  //    order was never "this work judged by these checks" — the verifier should not have ruled at all.
  const bindingValid =
    referenceOf(preimage).toBase58() === onchainReference && preimageMatches(preimage, round, spec)
  if (!bindingValid) {
    return { bindingValid: false, recomputedPass: null, recomputedFailures: [], verifierHonest: false, reason: 'order binding does not commit to this spec/reference — no valid verdict was possible' }
  }

  // 2) Recompute the verdict from public data. A reclaim is the payer's liveness backstop (verifier
  //    went dark), so it is honest by construction — there was no verdict to get wrong.
  if (outcome === 'reclaimed') {
    return { bindingValid: true, recomputedPass: null, recomputedFailures: [], verifierHonest: true, reason: 'reclaimed by payer after the grace window — verifier never ruled (no misconduct)' }
  }

  if (payloadB64 == null) {
    // No delivery → the only correct settlement is a refund. A release here is provable theft.
    const honest = outcome === 'refunded'
    return { bindingValid: true, recomputedPass: false, recomputedFailures: ['no delivery'], verifierHonest: honest, reason: honest ? 'no delivery → refund is correct' : `no delivery but funds were ${outcome} — verifier misconduct` }
  }

  const verdict = judge(payloadB64, spec)
  // The checks say: pass → the ONLY honest outcome is release; fail → the only honest outcome is refund.
  const shouldRelease = verdict.pass
  const verifierHonest = shouldRelease ? outcome === 'released' : outcome === 'refunded'
  return {
    bindingValid: true,
    recomputedPass: verdict.pass,
    recomputedFailures: verdict.failures,
    verifierHonest,
    reason: verifierHonest
      ? `checks ${verdict.pass ? 'pass' : 'fail'} → ${outcome} is correct`
      : `checks ${verdict.pass ? 'pass' : 'fail'} but funds were ${outcome} — provable verifier misconduct`,
  }
}
