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

hard_fail_fixed() {
  local label="$1"
  local text="$2"
  if [[ -z "$text" ]]; then
    return 0
  fi
  if rg -l -F --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!scripts/hygiene-scan.sh' "$text" .; then
    echo "HYGIENE FAIL: $label" >&2
    failures=$((failures + 1))
  fi
}

hard_fail_private_regex() {
  local label="$1"
  local pattern="$2"
  if rg -l -P --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!scripts/hygiene-scan.sh' "$pattern" .; then
    echo "HYGIENE FAIL: $label" >&2
    failures=$((failures + 1))
  fi
}

check_private_blocklist() {
  local blocklist="${BRIDGEBRAIN_PRIVATE_BLOCKLIST:-}"
  local line
  if [[ -z "$blocklist" ]]; then
    return 0
  fi
  if [[ ! -f "$blocklist" ]]; then
    echo "HYGIENE FAIL: private blocklist file not found" >&2
    failures=$((failures + 1))
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    if [[ "${#line}" -lt 4 ]]; then
      continue
    fi
    hard_fail_fixed "private blocklist match" "$line"
  done < "$blocklist"
}

echo "Reviewing broad sensitive-word surface..."
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' \
  --glob '!scripts/hygiene-scan.sh' \
  '(/home|/Users)/[^[:space:]"<>]+|[A-Za-z]:\\Users\\[^[:space:]"<>]+|auth|cookie|token|api[_-]?key|session|\.gbrain|\.codex|\.openclaw|ollama|chatgpt-bridge-semantic-hash-768|embedding_dimensions.*768|not to win academic|best practical' . || true

echo
echo "Checking hard public-release blockers..."
hard_fail_fixed "current local home path" "${HOME:-}"
local_user="${USER:-}"
local_logname="${LOGNAME:-}"
blocked_owner="${BRIDGEBRAIN_BLOCKED_OWNER:-}"
if [[ "${#local_user}" -ge 4 ]]; then
  hard_fail_fixed "current local username" "$local_user"
fi
if [[ "$local_logname" != "$local_user" && "${#local_logname}" -ge 4 ]]; then
  hard_fail_fixed "current local logname" "$local_logname"
fi
hard_fail_fixed "blocked owner placeholder leaked" "$blocked_owner"
hard_fail "old academic-benchmark dodge" 'not to win academic'
hard_fail "old lazy quality framing" 'best practical'
hard_fail "Ollama instruction instead of No Ollama boundary" 'ollama (pull|run|serve|install|embedding)'
hard_fail_private_regex "email address" '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b'
hard_fail_private_regex "phone-number-shaped text" '(?<![0-9])(?:\+1[\s.-]?)?(?:\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-][0-9]{4}(?![0-9])'
hard_fail_private_regex "street-address-shaped text" '\b[0-9]{1,6}\s+[A-Z][A-Za-z0-9 .'\''-]{1,50}\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Place|Pl|Way|Circle|Cir)\b'
check_private_blocklist

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
