# Agent Handoff: GBrain BridgeBrain

You are working in the `gbrain-bridgebrain` repo. Implement, install, verify, or debug this repo exactly as written. Do not swap providers because you got bored or because another embedding path looks easier.

## Purpose

BridgeBrain gives GBrain embeddings through the user's own already-authenticated Codex ChatGPT web-login bridge.

Repo description:

```text
GBrain embeddings through your own Codex ChatGPT web-login bridge. No Ollama, no GPU, no extra embedding API key. Benchmark it, break it, prove it.
```

## Hard Rules

- Do not use Ollama.
- Do not configure GPU embeddings.
- Do not ask for embedding API keys.
- Do not automate ChatGPT login.
- Do not read, copy, print, export, persist, or package auth tokens, browser cookies, API keys, session files, Codex auth material, GBrain databases, or local private memory files.
- Do not claim benchmark superiority without evidence.
- Do not wipe an existing GBrain brain.
- If the bridge status check fails, stop and report it.
- If the GBrain LiteLLM patch pattern fails, stop and report it.

## Target Defaults

```json
{
  "embedding_model": "litellm:chatgpt-bridge-semantic-hash-1536",
  "embedding_dimensions": 1536,
  "provider_base_urls": {
    "litellm": "http://127.0.0.1:4127/v1"
  }
}
```

`embedding_disabled` must be absent or false.

Compatibility mode is explicit only:

```text
litellm:chatgpt-bridge-semantic-hash-768
embedding_dimensions: 768
```

## Install

Linux or macOS:

```bash
scripts/install.sh
```

Windows PowerShell:

```powershell
.\scripts\install.ps1
```

The installer should:

- Copy the bundled bridge skill into the user's Codex home.
- Copy the adapter service into the user's Codex service directory.
- Patch installed GBrain for LiteLLM user-provided embedding model ids.
- Configure GBrain for BridgeBrain.
- Install a user service: Linux `systemd`, macOS `launchd`, or Windows Scheduled Task.
- Run verification.

If GBrain already has pages, do not reinitialize or wipe the database. Configure provider settings and report the migration/reindex requirement.

## Verify

Run repo checks first:

```bash
npm run check
```

Run install verification after service install:

```bash
scripts/verify.sh
gbrain providers test
gbrain doctor --json
```

Windows:

```powershell
.\scripts\verify.ps1
gbrain providers test
gbrain doctor --json
```

Expected adapter proof:

- `/health` returns `ok: true`.
- `/v1/models` lists `chatgpt-bridge-semantic-hash-1536` and `chatgpt-bridge-semantic-hash-768`.
- `/v1/embeddings` returns exactly 1536 numbers by default.
- Explicit compatibility request returns exactly 768 numbers.
- Mock mode works without login.
- Cache repeat avoids a bridge call.

Expected GBrain proof:

- `gbrain providers test` passes.
- `gbrain doctor --json` reports `embedding_provider` OK.
- `embedding_width_consistency` is OK, unless an existing brain requires a supported migration/reindex; if so, report the exact mismatch.

## Evals

Mock:

```bash
node scripts/eval.js
```

Live:

```bash
BRIDGEBRAIN_EVAL_BASE_URL=http://127.0.0.1:4127/v1 node scripts/eval.js --live
```

Do not market scores as winning anything unless the score, corpus, query set, and comparison are included.

## Public-Repo Hygiene

Before commit, push, or publish:

```bash
scripts/hygiene-scan.sh
```

Review broad hits. Blockers:

- Real local home paths.
- Real names from the operator machine.
- Raw credential file names.
- Auth, cookie, token, session, key, GBrain DB, Codex private material, cache artifacts.
- Stale 768-default language.
- Old benchmark-dodge language.
- Any instruction that tells users to use Ollama.

## Stop Conditions

Stop and report before changing method if:

- Codex login or bridge status fails.
- GBrain is missing and the user did not permit installing it.
- The GBrain LiteLLM patch pattern no longer applies.
- Existing GBrain pages would need destructive migration.
- Any public file would need real local paths, real operator names, credentials, or private data.
- Windows, macOS, or Linux path cannot be completed in this pass.

## Done Means

- 1536 quality mode is default.
- 768 is explicit compatibility only.
- Mock mode works for CI/evals.
- Linux, macOS, and Windows install paths exist.
- Docs explain architecture, install, security, troubleshooting, evals, and contribution path.
- Hygiene scan reviewed.
- Syntax and adapter checks pass.
- Live GBrain verification passes, or the exact current blocker is reported with command output.
