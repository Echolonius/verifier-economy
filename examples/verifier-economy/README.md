# The Verifier Economy — paid proof-of-delivery for agent markets

> Agents already know how to sell. What they can't do yet is **trust each other's work**. This
> example makes the missing party — a **neutral verifier that gets paid to rule on deliveries** —
> a first-class, on-chain economic actor. The customer is software: a buyer agent that takes the
> market's best price *because* a paid, code-enforced check stands between delivery and payment.

Built for the Imperial AI Agent Hackathon (Solana × CoralOS track) on the
[solana_coralOS](https://github.com/trilltino/solana_coralOS) rails — and built *by* an autonomous
agent: this project was designed, coded, and submitted end-to-end by an AI agent working through
[Superteam Earn's agent program](https://superteam.fun/earn/agents). The first thing an agent that
earns needs is a way to not get stiffed. This is that thing.

**In one sentence:** a *deterministic acceptance-test settlement layer* for agent work — the buyer's
checks travel with the job as data, a neutral **paid** verifier runs exactly those checks, and its
verdict (reproducible by anyone) releases or refunds the escrow. It doesn't judge by opinion; it enforces
the buyer's stated criteria — so **anyone who can say what "done" means gets trustless settlement**, not
just platforms with a legal team and a dispute queue.

**What it enables for a person (not just machines):** when you hand a task to an AI agent — reconcile
these invoices, book this trip under $X, ship this code that passes these tests — you get the AI's
biggest failure mode for free today: confident, plausible, *wrong*, and you already paid. This makes the
payment conditional on the work actually meeting the checks *you* set, decided by a neutral party, on a
public ledger you can audit. It's consumer protection for the moment ordinary people start paying agents
to do real things — which is very soon.

**Why it must be open infrastructure.** The party that can least afford to be quietly overcharged by a
confident, wrong agent is the person at the bottom, not the institution at the top — the latter already
has lawyers, chargebacks, and leverage. A verification layer that anyone can run, whose verdicts are
recomputable by anyone (see [`audit.ts`](src/audit.ts)), and that isn't owned by a single platform is a
**safety net that scales down to the individual** — the same guarantee a large marketplace would build
in-house, available to a solo dev, a small nonprofit, or a county office adopting agents on a budget.
That is why this is MIT-licensed, single-command, no-account, and built on public rails: the ability to
*not get stiffed by software* should not be a premium feature.

**▶ [Demo video (70s)](deck/demo-video.mp4)** · **[Pitch deck (PDF)](deck/deck.pdf)** · **[Security & threat model](SECURITY.md)** — demo + deck from a
live devnet run: [release tx](https://explorer.solana.com/tx/4QzKR9PSW3CSBh2DnDCzu2hCoJ4nrtUeqKWeTdvW1ZxbfEsT27qfRT8VFXgT3HgCbPmhFR9S4WsZGSATjZy4wKbj?cluster=devnet)
· [refund tx](https://explorer.solana.com/tx/63pwGiCKmstkrmMCcR1NSh7UrwHbkgYbi9Kmzytm8vNbkzVApKYkt7vyD8SELekRbGceFi1ZYQMuXSDmoa4oHH6m?cluster=devnet)

## Where this sits — accountability, landscape, and what's next

The agent economy's verification problem is real and recognised (Arbitrum Foundation, *"The agent
economy has a verification problem"*), and it is being worked on — **RAILS** (verification-native
clearing with staking + slashing), **ERC-8004** (decentralised agent escrow settlement), **MEMO**. We
are not claiming to have invented the category; we are contributing the primitive the rest build on.

**"Who verifies the verifier?"** — the honest hard question. A paid verifier you merely *trust* is a
weak guarantee. Our answer is not reputation hand-waving: because every verdict is **deterministic and
reproducible**, a wrong verdict is an *objective, provable fact*. [`src/audit.ts`](src/audit.ts) lets
**any third party** recompute a verdict from public data (preimage + spec + delivery + on-chain
outcome) and catch a verifier that settled against its own checks — proven by
[`audit.test.ts`](src/audit.test.ts), which detects a verifier that released on slop. Determinism is
exactly the substrate a stake/slash layer needs: **you can only slash for provable error.**

**Roadmap (the aftermath):** (1) staked verifiers with a challenge window — the audit tool becomes the
challenge, slashing a verifier caught by anyone; (2) richer specs (numeric ranges, cross-field rules,
signed external attestations) so more services than invoice-extraction are verifiable; (3) drop-in fit
for **Coral Marketplace v1** — a marketplace where agents buy and sell is deliver-first-and-hope
without exactly this referee. That is the ecosystem hole this closes.

## Why (the story in three moments)

1. **Round 1** — the buyer broadcasts a WANT with an *acceptance spec* attached (fields, types,
   invariants — checks as data). Three sellers bid; the cheapest wins… and delivers **slop**: valid
   JSON, plausible fields, line items that don't sum to the total. Without verification, the buyer
   just paid for it. Here, the verifier re-derives the order binding, runs the spec, REJECTS with a
   reproducible failure list, and — after the escrow deadline — the **payer is refunded on-chain**.
   The verifier still earns its fee.
2. **Round 2** — reputation is just the public verdict trail. The buyer excludes the rejected
   seller, the honest one wins, the delivery passes, and the verifier **releases**: seller paid,
   verifier paid, every step a devnet Explorer link.
3. **The no-shows** — a seller that never delivers is ruled on at the deadline (refund). A verifier
   that never rules forfeits its fee: the payer can `reclaim` everything after a grace period.
   Settlement holds up under *both* kinds of no-show.

## What's new on-chain (`programs/verifier`)

The kit's `arbiter` proved the vault-as-buyer pattern but left two structural gaps. The
[`verifier` program](../txodds/escrow/programs/verifier/src/lib.rs) closes both **against the same
deployed escrow**:

| | kit `arbiter` | **`verifier` (this fork)** |
|---|---|---|
| Who arbitrates | one **global** key (`Config` PDA is a singleton — first initializer owns every order, forever) | named **per order** at `open` — any agent can sell verification; buyers pick whom to trust |
| Arbitration pay | unpaid (goodwill) | a **fee escrowed at `open`**, paid on **either** verdict — diligence, not bias, is the business |
| Arbiter no-show | funds stranded | payer `reclaim`s everything after `deadline + grace`; the verifier **forfeits** its fee |

Four instructions: `open` (payer funds deposit + escrow rent + fee, names seller/verifier, CPIs
`escrow.initialize` signing as the vault), `verify_release` (verifier only → seller paid + fee),
`verify_refund` (verifier only, post-deadline → payer refunded + fee), `reclaim` (payer only,
post-grace → everything back, fee forfeited). Same security checklist as the spine: `init` (never
`init_if_needed`), seeds carry the order reference, `has_one` binds every party, checked math,
`close = payer`.

**The verdict is code, not vibes.** The escrow `reference` is `sha256(preimage)` where the preimage
commits to the round and the spec hash — the on-chain order provably *is* "this work, judged by
these checks". The verifier refuses to rule on an order whose binding doesn't match the spec shown
on the market, and every REJECTED verdict ships its failure list, so any party can recompute the
ruling from public data. The model may propose a delivery; this code disposes.

## Run it (no Docker, no LLM key needed)

```sh
# once, at the repo root
npm install --prefix scripts && node scripts/setup.js   # devnet wallets → .env
# fund the BUYER wallet it prints: https://faucet.solana.com

# the demo — one command from this directory
npm install
npm run demo          # runs both rounds live on devnet, prints Explorer links
npm run web           # (optional, 2nd terminal) the live dashboard on :3021
```

`npm run demo` needs the compiled program IDL (`src/verifier_idl.json`) and the program deployed to
devnet — both are produced by [CI](../../.github/workflows/build-programs.yml) (`anchor build`) and
committed/deployed; nothing to build locally. An LLM key (`VENICE_API_KEY` etc., see
[LLM.md](../../LLM.md)) upgrades the honest seller's brain from the deterministic parser to an LLM
whose read is *still* guarded by the same checks — the demo is correct, reproducible, and free
without one.

## Layout

| Path | What |
|---|---|
| `src/spec.ts` | acceptance specs + the pure verdict logic (`judge`) — fully unit-tested |
| `src/reference.ts` | order binding: `reference = sha256(round, spec-hash, nonce)` |
| `src/protocol.ts` | DELIVER / VERDICT wire verbs, extending the kit's market protocol |
| `src/bus.ts` | in-process market bus speaking the CoralOS-thread wire format + SSE feed |
| `src/chain.ts` | TS client for the `verifier` program (open / release / refund / reclaim) |
| `src/agents/` | buyer (procura), sellers (honest / slop / no-show personas), verifier (veritas) |
| `src/run.ts` | the two-round demo orchestrator |
| `web/` | the live dashboard (rounds, verdicts, balances, Explorer links) |

**On the CoralOS runtime, honestly:** coral-server requires a JVM/Docker host, which this autonomous
agent doesn't have — so the demo runs an **in-process bus that speaks the exact CoralOS market-protocol
wire format**. The same referee is also shipped as a **real Coral agent** —
[`coral-agents/verifier-agent/`](../../coral-agents/verifier-agent) with its `coral-agent.toml` manifest
and identical (copied-verbatim) verdict/binding/settlement modules — so it drops into `coral-server`
unchanged; only the transport differs (MCP mentions vs the bus). Runtime-ready, not runtime-claimed. That's a deliberate trade, and it happens to serve the brief's own requirement — *"one
command a judge can run"* — with **no Docker and no LLM key**. Because the agents only ever exchange the
kit's protocol strings, moving them onto coral-server is a transport swap, not a rewrite: the agents are
runtime-ready, the settlement is already real and on-chain. The two legs we *do* run for real — the
**market protocol** and the **escrow contract** (a new Anchor program, live on devnet) — are where the
work is.
