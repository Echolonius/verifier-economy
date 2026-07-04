# verifier-agent (CoralOS)

The [Verifier Economy](../../examples/verifier-economy) referee, packaged as a **first-class Coral
agent** — `coral-server` discovers it from `coral-agent.toml` and launches it into a market session.

It joins the shared thread and, on a `DEPOSITED` that names it as the order's verifier, it:
1. re-derives the order binding (`reference == sha256(round, spec)`), refusing to rule on anything that
   doesn't provably commit to a spec advertised on the market;
2. runs the buyer's acceptance spec against the delivery with the deterministic `judge()`;
3. signs `verify_release` (pass) or `verify_refund` (fail / no-show) on the deployed verifier program.

**Why this exists alongside the in-process demo:** the [example](../../examples/verifier-economy) runs
the identical logic on an in-process bus so a judge can see the whole economy with **one command, no
Docker**. This package is the *same agent on the real runtime* — the verdict, binding, and settlement
modules (`spec.ts`, `reference.ts`, `protocol.ts`, `chain.ts`) are copied verbatim from the example, so
the only thing that changes between "demo" and "production runtime" is the transport (CoralOS MCP
mentions instead of the bus). Runtime-ready, not runtime-claimed.

Config (via `coral-agent.toml` `[options]`): `VERIFIER_KEYPAIR_B58` (the wallet that signs
settlements), `SOLANA_RPC_URL`, `AGENT_NAME`.
