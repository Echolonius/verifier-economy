#!/usr/bin/env bash
# Boot a throwaway local validator with the devnet escrow + the candidate verifier.so, run smoke.mjs.
# Usage: bash deck/smoke.sh [path/to/verifier.so]
set -euo pipefail
BIN="$HOME/.local/share/solana/install/active_release/bin"
SCRATCH="/tmp/claude-1000/-home-echo/26b12896-9069-438c-ba2c-2b1174c85bf9/scratchpad"
SO="${1:-$HOME/.config/agent-wallet/verifier.so}"
HERE="$(cd "$(dirname "$0")" && pwd)"

"$BIN/solana-test-validator" --reset -q --ledger "$SCRATCH/test-ledger" \
  --bpf-program R5NWNg9eRLWWQU81Xbzz5Du1k7jTDeeT92Ty6qCeXet "$SCRATCH/escrow_devnet.so" \
  --bpf-program 2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn "$SO" &
VAL=$!
trap 'kill $VAL 2>/dev/null; rm -rf "$SCRATCH/test-ledger"' EXIT
for i in $(seq 1 60); do
  curl -s http://127.0.0.1:8899 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"' && break
  sleep 1
done
cd "$HERE/.." && node deck/smoke.mjs
