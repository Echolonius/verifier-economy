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

export function bindOrder(round: number, spec: AcceptanceSpec, nonce: number): OrderBinding {
  const preimage = `verify:${spec.service}:round=${round}:spec=${specHash(spec)}:nonce=${nonce}`
  return { reference: new PublicKey(createHash('sha256').update(preimage).digest()), preimage }
}

/** Recompute the reference from a preimage (verifier-side check before ruling). */
export function referenceOf(preimage: string): PublicKey {
  return new PublicKey(createHash('sha256').update(preimage).digest())
}

/** Does this preimage commit to this round + spec? The verifier's precondition for ruling. */
export function preimageMatches(preimage: string, round: number, spec: AcceptanceSpec): boolean {
  return preimage.includes(`:round=${round}:`) && preimage.includes(`:spec=${specHash(spec)}:`)
}
