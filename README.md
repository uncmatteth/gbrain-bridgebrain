# GBrain BridgeBrain

GBrain embeddings through your own Codex ChatGPT web-login bridge. No Ollama, no GPU, no extra embedding API key. Benchmark it, break it, prove it.

BridgeBrain is a local OpenAI-compatible embeddings adapter for GBrain. It turns text into fixed-width vectors by asking a bundled Codex ChatGPT web-login bridge for structured semantic fingerprints, then hashing those fingerprints into deterministic normalized vectors.

This exists because the normal setup path is annoying as hell if you want strong retrieval without running a local embedding daemon or paying another embedding provider.

## What It Ships

- Local `/v1/embeddings`, `/v1/models`, and `/health` HTTP service.
- Bundled `unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit` bridge skill.
- Default `quality` profile: `chatgpt-bridge-semantic-hash-1536`.
- Explicit `compat` fallback: `chatgpt-bridge-semantic-hash-768`.
- `mock` profile for CI and no-login tests.
- Linux user `systemd`, macOS `launchd`, and Windows Scheduled Task installers.
- GBrain LiteLLM compatibility patch with backups and hard failure if the expected upstream code changed.
- Eval fixtures and recall/MRR scoring.
- Hygiene checks for public repo safety.

## What It Does Not Do

- No Ollama.
- No GPU embedding daemon.
- No extra embedding API key.
- No login automation.
- No credential copying.
- No shared ChatGPT account trick.
- No benchmark victory lap without data.

Every machine uses its own already-authenticated Codex ChatGPT login. BridgeBrain never reads, copies, prints, packages, or persists raw credentials. If Codex is not logged in, install stops instead of doing credential-handling bullshit.

## Architecture

```text
GBrain
  -> LiteLLM/OpenAI-compatible embedding route
  -> http://127.0.0.1:4127/v1
  -> BridgeBrain local Node.js adapter
  -> bundled ChatGPT web-login bridge skill
  -> local Codex CLI auth path
  -> structured semantic fingerprint
  -> deterministic feature hashing
  -> normalized 1536-dimensional vector
```

The adapter uses Node.js built-in modules only. It listens on loopback by default. It stores cache files keyed by source text hash and does not store raw source text, but cached semantic fingerprints are still derived data. Do not embed secrets unless provider exposure and derived local cache are acceptable.

## Install

Prereqs:

- Node.js 18+.
- Codex CLI installed and already logged in with ChatGPT auth.
- GBrain installed, or Bun installed if you want `--install-gbrain`.

Linux or macOS:

```bash
git clone https://github.com/<owner>/gbrain-bridgebrain.git
cd gbrain-bridgebrain
scripts/install.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/<owner>/gbrain-bridgebrain.git
cd gbrain-bridgebrain
.\scripts\install.ps1
```

The installer copies the bundled bridge skill into the current user's Codex home, installs the adapter service, patches GBrain's LiteLLM model-id check, configures GBrain, and runs verification.

It also generates a per-install local token. GBrain's LiteLLM base URL is written as `http://127.0.0.1:<port>/v1/t/<generated-token>`, and the service receives the matching `BRIDGEBRAIN_API_TOKEN`. Do not publish that local config or service file.

If you use a non-default GBrain home, set `GBRAIN_HOME` before installing and verifying.

If GBrain already has pages, the installer does not wipe the brain. It updates provider config and reports that a supported migration or reindex is needed if existing embeddings use another width.

## Compatibility Mode

Default is 1536 dimensions:

```text
litellm:chatgpt-bridge-semantic-hash-1536
```

Use 768 only when you need an existing smaller schema:

```bash
BRIDGEBRAIN_PROFILE=compat \
GBRAIN_CHATGPT_EMBED_MODEL=chatgpt-bridge-semantic-hash-768 \
GBRAIN_CHATGPT_EMBED_DIMENSIONS=768 \
scripts/install.sh
```

PowerShell:

```powershell
$env:BRIDGEBRAIN_PROFILE="compat"
$env:GBRAIN_CHATGPT_EMBED_MODEL="chatgpt-bridge-semantic-hash-768"
$env:GBRAIN_CHATGPT_EMBED_DIMENSIONS="768"
.\scripts\install.ps1
```

## Verify

Linux or macOS:

```bash
scripts/verify.sh
```

Windows:

```powershell
.\scripts\verify.ps1
```

Repo-local checks:

```bash
npm test
npm run eval
npm run hygiene
npm run check
```

`npm test` uses mock mode and does not require ChatGPT login. Live install verification does require the local Codex ChatGPT login because that is the whole point.

## Benchmark It

Mock eval:

```bash
node scripts/eval.js
```

Live eval against a running BridgeBrain service:

```bash
BRIDGEBRAIN_EVAL_BASE_URL=http://127.0.0.1:4127/v1 node scripts/eval.js --live
```

The eval prints recall@K and MRR. The bundled fixture is small on purpose: it proves the harness works. Bring a better corpus, submit results, and break the damn thing in public.

## Security Boundary

BridgeBrain sends text being embedded through the already-authenticated provider account via Codex. It does not make provider submission private from the provider. It does keep raw credentials out of the repo and out of the adapter.

The bundled bridge passes prompt text through stdin, not command-line args, and disables the child Codex shell/browser/app/search tool surfaces before model calls.

Embedding POSTs require the per-install local token, either in the tokenized `/v1/t/<token>/...` path written by the installer or as `Authorization: Bearer <token>`.

Never publish:

- Codex auth material.
- Browser cookies.
- API keys.
- Raw tokens.
- Session databases.
- GBrain databases or caches.
- Local private memory files.

See `SECURITY.md` for the full boundary.

## Files

- `src/gbrain-chatgpt-embeddings-server.js` - local embeddings adapter.
- `bridge-skill/` - bundled ChatGPT web-login bridge skill.
- `scripts/install.sh` - Linux/macOS installer.
- `scripts/install.ps1` - Windows installer.
- `scripts/verify.sh` and `scripts/verify.ps1` - install verification.
- `scripts/patch-gbrain-litellm.js` - safe GBrain compatibility patch.
- `scripts/test-adapter.js` - no-login adapter smoke test.
- `scripts/test-bridge.js` - bridge stdin/no-shell-tool smoke test.
- `scripts/eval.js` - recall/MRR eval harness.
- `scripts/hygiene-scan.sh` - public-release hygiene scan.
- `systemd/` and `launchd/` - user service templates.
- `evals/` - fixture corpus and query set.

## Agent Handoff

Give an agent this repo and `AGENT_HANDOFF.md`. Tell it: do not use Ollama, do not ask for embedding keys, do not copy credentials, run the checks, and stop if the bridge or GBrain patch fails.

## License

MIT.
