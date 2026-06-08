# Troubleshooting

## Bridge Status Fails

Run:

```bash
node <codex-home>/skills/unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit/scripts/gpt-web-login-bridge.js status
```

If unavailable, log in to Codex with ChatGPT on that machine. Do not paste credentials into BridgeBrain. Do not invent an API key path.

## Service Is Not Running

Linux:

```bash
systemctl --user status gbrain-chatgpt-embeddings.service
journalctl --user -u gbrain-chatgpt-embeddings.service --no-pager -n 100
```

macOS:

```bash
launchctl list | grep bridgebrain
tail -n 100 <codex-home>/services/gbrain-chatgpt-embeddings/bridgebrain.err.log
```

Windows PowerShell:

```powershell
Get-ScheduledTask -TaskName "GBrain BridgeBrain Embeddings"
Start-ScheduledTask -TaskName "GBrain BridgeBrain Embeddings"
```

### OpenClaw Exec Policy Blocks Windows Commands

If you run the Windows install through OpenClaw and see:

```text
No matching rule; default policy applied
```

that is usually an OpenClaw exec-routing problem, not a BridgeBrain installer failure. Check whether OpenClaw is routing `tools.exec` through a constrained Windows node. From the OpenClaw gateway shell, route `tools.exec` through the gateway with full exec mode, then validate and restart the gateway:

```powershell
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.mode full
openclaw config unset tools.exec.security
openclaw config unset tools.exec.ask
openclaw config validate
openclaw gateway restart
```

If OpenClaw runs inside WSL, prefix those commands with `wsl -d <gateway-distro> --`.

Do not loosen a Windows node policy unless the actual task needs Windows-host commands. Keep BridgeBrain fixes in BridgeBrain; keep OpenClaw runner-policy fixes in OpenClaw.

## Endpoint Fails

```bash
curl -fsS http://127.0.0.1:4127/health
curl -fsS http://127.0.0.1:4127/v1/models
```

Embedding calls require the generated local token. The installer stores the tokenized base URL in `provider_base_urls.litellm`:

```bash
node -e 'const fs=require("fs"); const path=require("path"); const f=path.join(process.env.GBRAIN_HOME||process.env.HOME,".gbrain","config.json"); console.log(JSON.parse(fs.readFileSync(f,"utf8")).provider_base_urls.litellm)'
```

Expected default model:

```text
chatgpt-bridge-semantic-hash-1536
```

## Wrong Dimensions

Default must be 1536. Check config:

```bash
gbrain doctor --json
```

If an existing brain was created with 768 dimensions, do not wipe it. Use compat mode or run a supported migration/reindex.

Compat mode:

```bash
BRIDGEBRAIN_PROFILE=compat \
GBRAIN_CHATGPT_EMBED_MODEL=chatgpt-bridge-semantic-hash-768 \
GBRAIN_CHATGPT_EMBED_DIMENSIONS=768 \
scripts/install.sh
```

## GBrain Patch Fails

Run:

```bash
node scripts/patch-gbrain-litellm.js
```

If the expected pattern is not found, upstream GBrain changed. Stop and inspect `gateway.ts`. Do not patch random nearby code because that is how compatibility fixes turn into dangerous bullshit.

## Existing Brain Detected

Installer does not wipe existing pages. It updates provider config and reports migration/reindex needs.

If `gbrain doctor --json` reports width mismatch, choose one:

- Use explicit 768 compat mode for that existing brain.
- Create a fresh brain intentionally.
- Follow a supported migration/reindex path.

## Mock Checks

No-login adapter test:

```bash
node scripts/test-adapter.js
```

Full repo check:

```bash
npm run check
```
