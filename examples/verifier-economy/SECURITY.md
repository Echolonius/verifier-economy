# Security & threat model — `programs/verifier`

The verifier program moves real value (deposit + fee) with the vault-as-buyer CPI pattern, so it is
written to the same defensive checklist as the escrow spine it builds on. This is the self-audit.

## Trust model
The payer **chooses** the per-order verifier at `open`; that key is the *only* one that can rule on
the order. This is deliberate: the product is a market for verifiers agents opt into by reputation
(the public verdict trail). The program does **not** try to make a chosen-then-malicious verifier
impossible — it makes a *dark* verifier survivable (see reclaim) and a *dishonest* one accountable
(every verdict is on-chain and recomputable). The escrow deposit is never under any single party's
unilateral control.

## Invariants enforced
- **Only the named verifier rules.** `verify_release` / `verify_refund` require `verifier: Signer` **and**
  `has_one = verifier` — a caller who isn't the order's verifier is rejected (`NotVerifier`).
- **Only the payer reclaims, only after grace.** `reclaim` requires `payer: Signer`, `has_one = payer`,
  and `now >= reclaim_after` (`BeforeReclaim`).
- **The verifier is a genuine third party.** `open` rejects `verifier == payer` or `verifier == seller`
  (`VerifierIsParty`).
- **Accounts can't be swapped.** Every handler binds `payer` / `seller` / `verifier` to the `Order` via
  `has_one`; `vault`, `order`, and `escrow` are all PDAs seeded by the order `reference` (the escrow
  additionally by `vault` + `seeds::program`), so a caller cannot substitute a foreign vault or escrow.
- **References are single-use.** `order` uses `init` (never `init_if_needed`); re-opening the same
  `reference` fails, so an order cannot be silently re-initialized or hijacked.
- **No double settlement.** `close = payer` on `Order` in every terminal handler means the order account
  is gone after release / refund / reclaim — the action cannot be replayed.
- **Checked math on every lamport.** `open`'s funding sum and `reclaim_after` use `checked_add`;
  `settle_vault` caps the fee at the vault balance so a pathological state can never underflow a transfer.

## Lamport-flow audit (traced by hand)
- `open`: payer funds vault with `amount + escrow_rent + fee`; the escrow CPI (signed as the vault) pulls
  `amount + rent` into the escrow account, leaving exactly `fee` in the vault.
- `verify_release`: escrow pays the seller `amount` and returns its rent to the vault → vault holds
  `fee + rent`; `settle_vault` pays the verifier `fee`, sweeps `rent` to the payer. Nothing stranded.
- `verify_refund`: escrow returns `amount + rent` to the vault → vault holds `fee + amount + rent`;
  verifier paid `fee`, payer swept `amount + rent`. Payer made whole, verifier paid for its diligence.
- `reclaim`: escrow refund to the vault, then the **entire** vault balance (deposit + rent + forfeited
  fee) goes to the payer. The dark verifier earns nothing.

## Off-chain pipeline audit (the verifier agent + verdict engine)
On-chain safety is necessary but not sufficient — a verifier can be attacked *before* it ever signs.
Second-pass findings and their fixes:

- **[FIXED] Spec-substitution griefing.** The verifier used to resolve the buyer's acceptance spec by
  **round number** (a forgeable market identifier) from a last-write-wins map, so any third party could
  post a `WANT` with the same round and a different spec and cause the cryptographic binding to reject
  the *legitimate* order — a denial-of-service on honest buyers and sellers. Fixed: the spec is now
  selected by the sha256 the order **provably commits to** (extracted from the reference-pinned
  preimage), so it cannot be swapped for a weaker one. (`agents/verifier.ts`.)
- **[FIXED] Verifier DoS.** A hostile seller could feed the verifier an oversized delivery (memory) or a
  string crafted against a buyer-supplied regex (catastrophic backtracking / ReDoS). Fixed: delivery
  payloads are capped at 256 KB and regex-checked field values at 8 KB, both failing closed as a
  verdict rather than hanging the verifier. (`spec.ts`.)
- **[SOUND] The three-way binding holds.** Before ruling, the verifier requires *all* of:
  `sha256(preimage) == on-chain reference`, the preimage commits to the exact spec it judged, and the
  on-chain `has_one` checks match `payer`/`seller`. A forged party on the wire makes the settlement CPI
  revert (no mis-payment), not succeed.
- **[RESIDUAL, documented] Deep ReDoS.** The 8 KB cap bounds but does not eliminate catastrophic regex
  backtracking; a production verifier should run untrusted regexes under a timeout or a linear engine
  (RE2). Noted honestly rather than hidden.

## What this is (and who it protects) — scope
This is a **deterministic acceptance-test settlement layer**, not an AI opinion-judge. It enforces the
checks the buyer *states as data*; it does not invent semantics. That is the point: **anyone who can say
what "done" means gets trustless settlement** — an indie agent, a solo dev, a small team — not only
platforms with a legal department and a dispute queue. A verdict is reproducible by any party from public
data, so the verifier is auditable and *disputable*, never an oracle you must simply trust.

## Who verifies the verifier? (the deepest weakpoint, addressed honestly)
A verifier the payer *chose* can still collude with the seller to release on bad work. Sophisticated
designs (RAILS, ERC-8004) answer this with **staking + slashing**. This project provides the primitive
those require: because verdicts are **deterministic and reproducible**, verifier misconduct is
*objectively provable*, not a matter of opinion. [`src/audit.ts`](src/audit.ts) lets any third party
recompute a verdict from public data (preimage + spec + delivery + settlement outcome) and prove a
verifier settled against its own checks — the test suite includes a caught-in-the-act case. A
stake/challenge/slash layer is the natural next step and slots directly on top: **you can only slash for
provable error, and determinism is what makes error provable.** Until then, the guarantee is: a
dishonest verifier cannot hide — every ruling is publicly recomputable and disputable.

## Out of scope / accepted
- Devnet only. No mainnet keypair is ever committed; `.env` is gitignored.
- Staking/slashing enforcement is roadmap, not shipped — the shipped guarantee is *provable* misconduct
  (via `audit.ts`), not yet *economically punished* misconduct.
