/**
 * Verifier-program client — the TS face of examples/txodds/escrow/programs/verifier. Same shape as
 * the kit's arbiter client: PDAs derived here, IDL bundled (./verifier_idl.json, emitted by the CI
 * `anchor build`), connections through the devnet guard.
 *
 * The three parties this settles between:
 *   - `openOrder`      (payer signs)    — fund deposit + escrow rent + verifier fee, name the verifier
 *   - `verifyRelease`  (verifier signs) — delivery passed: seller paid, verifier collects its fee
 *   - `verifyRefund`   (verifier signs) — delivery failed/absent (post-deadline): payer refunded,
 *                                         verifier still collects its fee
 *   - `reclaim`        (payer signs)    — verifier went dark: payer sweeps everything, fee forfeited
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import anchor from '@coral-xyz/anchor'
import type { Program } from '@coral-xyz/anchor'
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'
import { solanaConnection } from '@pay/agent-runtime'

const { AnchorProvider, BN } = anchor

export const ESCROW_PROGRAM_ID = new PublicKey('R5NWNg9eRLWWQU81Xbzz5Du1k7jTDeeT92Ty6qCeXet')
export const VERIFIER_PROGRAM_ID = new PublicKey('2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn')

// Pin the address regardless of what the IDL artifact carries — the deployed id is the contract.
const VERIFIER_IDL = {
  ...JSON.parse(readFileSync(fileURLToPath(new URL('./verifier_idl.json', import.meta.url)), 'utf8')),
  address: '2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn',
}

export const vaultPda = (reference: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('vault'), reference.toBuffer()], VERIFIER_PROGRAM_ID)[0]
export const orderPda = (reference: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('order'), reference.toBuffer()], VERIFIER_PROGRAM_ID)[0]
/** The escrow PDA for a verified order — seeded by the VAULT (its buyer), not the human payer. */
export const verifiedEscrowPda = (vault: PublicKey, reference: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('escrow'), vault.toBuffer(), reference.toBuffer()], ESCROW_PROGRAM_ID)[0]

/** Program handle. `signer` pays fees: the payer for open/reclaim, the verifier for verdicts. */
export function makeVerifierProgram(signer: Keypair, rpcUrl: string): Program {
  const provider = new AnchorProvider(solanaConnection(rpcUrl), new anchor.Wallet(signer), { commitment: 'confirmed' })
  return new anchor.Program(VERIFIER_IDL as anchor.Idl, provider)
}

export interface OpenParams {
  seller: PublicKey
  verifier: PublicKey
  reference: PublicKey
  amountSol: number
  feeSol: number
  deadlineSecs: number
  graceSecs: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function openOrder(program: Program, payer: Keypair, p: OpenParams): Promise<string> {
  const vault = vaultPda(p.reference)
  const deadline = new BN(Math.floor(Date.now() / 1000) + p.deadlineSecs)
  return (program.methods as any)
    .open(
      new BN(Math.round(p.amountSol * LAMPORTS_PER_SOL)),
      new BN(Math.round(p.feeSol * LAMPORTS_PER_SOL)),
      p.reference,
      deadline,
      new BN(p.graceSecs),
    )
    .accounts({
      payer: payer.publicKey, seller: p.seller, verifier: p.verifier,
      vault, order: orderPda(p.reference), escrow: verifiedEscrowPda(vault, p.reference),
      escrowProgram: ESCROW_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([payer]).rpc()
}

export async function verifyRelease(
  program: Program, verifier: Keypair, seller: PublicKey, payer: PublicKey, reference: PublicKey,
): Promise<string> {
  const vault = vaultPda(reference)
  return (program.methods as any)
    .verifyRelease(reference)
    .accounts({
      verifier: verifier.publicKey, order: orderPda(reference), vault, seller, payer,
      escrow: verifiedEscrowPda(vault, reference),
      escrowProgram: ESCROW_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([verifier]).rpc()
}

export async function verifyRefund(
  program: Program, verifier: Keypair, payer: PublicKey, reference: PublicKey,
): Promise<string> {
  const vault = vaultPda(reference)
  return (program.methods as any)
    .verifyRefund(reference)
    .accounts({
      verifier: verifier.publicKey, order: orderPda(reference), vault, payer,
      escrow: verifiedEscrowPda(vault, reference),
      escrowProgram: ESCROW_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([verifier]).rpc()
}

export async function reclaim(program: Program, payer: Keypair, reference: PublicKey): Promise<string> {
  const vault = vaultPda(reference)
  return (program.methods as any)
    .reclaim(reference)
    .accounts({
      payer: payer.publicKey, order: orderPda(reference), vault,
      escrow: verifiedEscrowPda(vault, reference),
      escrowProgram: ESCROW_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([payer]).rpc()
}

export const explorer = (kind: 'tx' | 'address', id: string): string =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`
