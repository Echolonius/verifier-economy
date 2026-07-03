#!/usr/bin/env bash
# Deploy the verifier program to devnet — run once the buyer wallet holds ~4 SOL
# (deploy needs the programdata rent ~1.9 SOL plus a temporary buffer of the same size,
# refunded on success). Usage: bash deck/deploy.sh
set -euo pipefail

SOLANA="$HOME/.local/share/solana/install/active_release/bin/solana"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRATCH="/tmp/claude-1000/-home-echo/26b12896-9069-438c-ba2c-2b1174c85bf9/scratchpad"
SO="${1:-$HOME/.config/agent-wallet/verifier.so}"
PROGRAM_KEYPAIR="$HOME/.config/agent-wallet/verifier-program-keypair.json"

# The buyer keypair (base58 in .env) becomes the fee payer / upgrade authority, as a JSON keypair.
PAYER_JSON="$SCRATCH/payer-keypair.json"
node -e "
const bs58m=require('$REPO/scripts/node_modules/bs58'); const bs58=bs58m.default||bs58m;
require('fs').writeFileSync('$PAYER_JSON', JSON.stringify(Array.from(bs58.decode(process.env.BUYER_KEYPAIR_B58))));
" < /dev/null
chmod 600 "$PAYER_JSON"

echo "balance: $($SOLANA balance -u devnet -k "$PAYER_JSON")"
$SOLANA program deploy "$SO" \
  -u devnet \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$PAYER_JSON" \
  --max-len "$(stat -c%s "$SO")"
echo "deployed: $($SOLANA program show 2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn -u devnet | head -6)"
rm -f "$PAYER_JSON"
