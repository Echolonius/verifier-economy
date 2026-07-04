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

## Out of scope / accepted
- A verifier the payer *chose* can still collude to release on bad work — that is a reputation problem,
  not a settlement one, and is exactly what the public on-chain verdict trail is for.
- Devnet only. No mainnet keypair is ever committed; `.env` is gitignored.
