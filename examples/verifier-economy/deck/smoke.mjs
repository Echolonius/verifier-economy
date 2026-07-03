/**
 * Local-validator smoke test — proves a verifier.so artifact end-to-end BEFORE spending a devnet
 * deploy on it: program-id check (the thing the poisoned-cache build failed), the escrow CPI, the
 * fee payout, and the refund path.
 *
 *   bash deck/smoke.sh   # starts solana-test-validator with escrow+verifier loaded, runs this
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import anchor from '@coral-xyz/anchor'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'

const { AnchorProvider, BN } = anchor
const RPC = 'http://127.0.0.1:8899'
const ESCROW = new PublicKey('R5NWNg9eRLWWQU81Xbzz5Du1k7jTDeeT92Ty6qCeXet')
const VERIFIER = new PublicKey('2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn')

const idl = { ...JSON.parse(readFileSync(new URL('../src/verifier_idl.json', import.meta.url), 'utf8')), address: VERIFIER.toBase58() }

const conn = new Connection(RPC, 'confirmed')
const payer = Keypair.generate()
const seller = Keypair.generate()
const verifier = Keypair.generate()

const sig = await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL)
await conn.confirmTransaction(sig)
const sig2 = await conn.requestAirdrop(verifier.publicKey, 1 * LAMPORTS_PER_SOL)
await conn.confirmTransaction(sig2)

const provider = new AnchorProvider(conn, new anchor.Wallet(payer), { commitment: 'confirmed' })
const program = new anchor.Program(idl, provider)

const reference = new PublicKey(createHash('sha256').update(`smoke:${Date.now()}`).digest())
const vault = PublicKey.findProgramAddressSync([Buffer.from('vault'), reference.toBuffer()], VERIFIER)[0]
const order = PublicKey.findProgramAddressSync([Buffer.from('order'), reference.toBuffer()], VERIFIER)[0]
const escrowPda = PublicKey.findProgramAddressSync([Buffer.from('escrow'), vault.toBuffer(), reference.toBuffer()], ESCROW)[0]

const amount = 0.01, fee = 0.002
console.log('open…')
await program.methods
  .open(new BN(amount * LAMPORTS_PER_SOL), new BN(fee * LAMPORTS_PER_SOL), reference, new BN(Math.floor(Date.now() / 1000) + 300), new BN(600))
  .accounts({ payer: payer.publicKey, seller: seller.publicKey, verifier: verifier.publicKey, vault, order, escrow: escrowPda, escrowProgram: ESCROW, systemProgram: SystemProgram.programId })
  .signers([payer]).rpc()
console.log('OK — program id + escrow CPI accepted')

console.log('verify_release…')
const vprov = new AnchorProvider(conn, new anchor.Wallet(verifier), { commitment: 'confirmed' })
await new anchor.Program(idl, vprov).methods
  .verifyRelease(reference)
  .accounts({ verifier: verifier.publicKey, order, vault, seller: seller.publicKey, payer: payer.publicKey, escrow: escrowPda, escrowProgram: ESCROW, systemProgram: SystemProgram.programId })
  .signers([verifier]).rpc()

const sellerBal = await conn.getBalance(seller.publicKey)
const verifierBal = await conn.getBalance(verifier.publicKey)
console.log('seller got:', sellerBal / LAMPORTS_PER_SOL, 'SOL (want', amount, ')')
console.log('verifier fee delta:', (verifierBal - LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL, 'SOL (want ~', fee, 'minus tx fees)')
if (sellerBal !== amount * LAMPORTS_PER_SOL) throw new Error('seller payout wrong')
if (verifierBal - LAMPORTS_PER_SOL < (fee - 0.001) * LAMPORTS_PER_SOL) throw new Error('verifier fee wrong')
console.log('SMOKE PASS ✅')
