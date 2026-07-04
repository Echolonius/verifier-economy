/**
 * Order-bound references — the same binding the kit's oracle uses (see examples/txodds
 * `boundReference`): the escrow `reference` is a 32-byte PDA seed, so the sha256 of a preimage IS
 * the PublicKey. Here the preimage commits to the ROUND and the SPEC, so the on-chain order
 * provably is "this work, judged by these checks": anyone with the preimage can recompute it, and
 * the verifier refuses to rule on an order whose reference doesn't match the spec it was shown.
 */
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type { AcceptanceSpec } from './spec.js'
import { specHash } from './spec.js'

export interface OrderBinding {
  reference: PublicKey
  preimage: string
}

/** sha256 (hex) of the task input — the exact bytes the buyer handed over (the invoice text, the
 * job document). Committing to this in the order is what lets an auditor prove a verdict was rendered
 * for THIS input and not silently swapped for an easier one. */
export const hashInput = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

/**
 * Bind an order to a preimage whose sha256 IS the escrow reference. The preimage commits to the round
 * and the spec always; when an `inputHash` is supplied it ALSO commits to the task input, so the order
 * provably is "this input, judged by these checks". Omitting `inputHash` reproduces the original
 * preimage format byte-for-byte (older orders — and the recorded devnet demo — remain valid).
 */
export function bindOrder(round: number, spec: AcceptanceSpec, nonce: number, inputHash?: string): OrderBinding {
  const inputSeg = inputHash ? `:input=${inputHash}` : ''
  const preimage = `verify:${spec.service}:round=${round}:spec=${specHash(spec)}${inputSeg}:nonce=${nonce}`
  return { reference: new PublicKey(createHash('sha256').update(preimage).digest()), preimage }
}

/** Recompute the reference from a preimage (verifier-side check before ruling). */
export function referenceOf(preimage: string): PublicKey {
  return new PublicKey(createHash('sha256').update(preimage).digest())
}

/** The input hash the order committed to, if any (auditors read this to know WHICH input was judged). */
export function inputOf(preimage: string): string | undefined {
  return preimage.match(/:input=([0-9a-f]{64})\b/)?.[1]
}

/**
 * Does this preimage commit to this round + spec (the verifier's precondition for ruling)? When an
 * `inputHash` is given, the order must also commit to exactly that input — so a verifier cannot rule
 * on a delivery produced for a different input than the one the order names.
 */
export function preimageMatches(preimage: string, round: number, spec: AcceptanceSpec, inputHash?: string): boolean {
  const base = preimage.includes(`:round=${round}:`) && preimage.includes(`:spec=${specHash(spec)}:`)
  if (!inputHash) return base
  return base && preimage.includes(`:input=${inputHash}:`)
}
