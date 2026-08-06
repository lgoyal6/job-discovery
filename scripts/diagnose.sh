#!/usr/bin/env bash
# Show why the digest did or did not send, reading n8n's execution records directly.
#
#   ./scripts/diagnose.sh          # last 12 executions
#   DIAGNOSE_LIMIT=40 ./scripts/diagnose.sh
#
# Railway's Postgres is private and n8n's container log omits provider error
# detail, so this pipes the query over SSH and runs it next to the database.
# Requires a registered Railway SSH key:
#   railway ssh keys add --key ~/.ssh/id_ed25519.pub --name laksh-mac-debug
#   railway ssh config --service n8n --identity-file ~/.ssh/id_ed25519
set -euo pipefail

HOST="${RAILWAY_SSH_HOST:-railway-n8n}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec ssh -o BatchMode=yes "$HOST" \
  "DIAGNOSE_LIMIT=${DIAGNOSE_LIMIT:-12} node --input-type=commonjs" < "$HERE/diagnose.cjs"
