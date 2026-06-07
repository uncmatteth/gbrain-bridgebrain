#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

hard_fail() {
  local label="$1"
  local pattern="$2"
  if rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!scripts/hygiene-scan.sh' "$pattern" .; then
    echo "HYGIENE FAIL: $label" >&2
    failures=$((failures + 1))
  fi
}

echo "Reviewing broad sensitive-word surface..."
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' \
  --glob '!scripts/hygiene-scan.sh' \
  '/home/dave|uncmatteth|auth|cookie|token|api[_-]?key|session|\.gbrain|\.codex|\.openclaw|ollama|chatgpt-bridge-semantic-hash-768|embedding_dimensions.*768|not to win academic|best practical' . || true

echo
echo "Checking hard public-release blockers..."
hard_fail "real local home path" '/home/dave'
hard_fail "real operator name" '\b[Dd]ave\b'
hard_fail "old repo owner placeholder leaked" 'uncmatteth'
hard_fail "old academic-benchmark dodge" 'not to win academic'
hard_fail "old lazy quality framing" 'best practical'
hard_fail "Ollama instruction instead of No Ollama boundary" 'ollama (pull|run|serve|install|embedding)'

credential_files="$(
  find . \
    -path './.git' -prune -o \
    -path './node_modules' -prune -o \
    -type f \( \
      -name 'auth.json' -o \
      -name 'cookies.sqlite' -o \
      -name 'session.sqlite' -o \
      -name '.env' -o \
      -name '.env.*' -o \
      -name 'id_rsa' \
    \) -print
)"
if [[ -n "$credential_files" ]]; then
  printf '%s\n' "$credential_files"
  echo "HYGIENE FAIL: raw credential-like file present" >&2
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Hygiene scan failed with $failures blocker(s)." >&2
  exit 1
fi

echo "Hygiene scan blockers clear. Review broad hits above before publishing."
