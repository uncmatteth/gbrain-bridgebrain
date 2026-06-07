---
name: unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit
description: New and exciting explicit-invocation-only ChatGPT/Codex web-login bridge. Use only when the user explicitly asks this skill to connect an agent or skill to an already-authenticated local Codex ChatGPT login; it refuses credential-copying bullshit and warns that ask/smoke prompt text is sent to the authenticated provider.
triggers:
  - "unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
  - "ChatGPT web login bridge"
  - "Codex ChatGPT login bridge"
---

# UNCLEMATTCONNECTTOGPTWEBLOGINOFFIREFORWEBGPTLOGINGTOYOURSHIT

**Who I am:**  
I am the new and exciting bridge uncle that lets an agent use the local Codex ChatGPT web login without shoving your credentials into the model like a dumbass.

## What's New in v1.420.69

- Ships a portable skill, not a plugin.
- Uses the already-authenticated local Codex CLI as the provider.
- Adds a bundled bridge script for `status`, `smoke`, and `ask`.
- Keeps raw auth tokens, browser cookies, API keys, and local auth files the hell out of the package.
- Narrows invocation to explicit bridge/setup requests so ordinary ask/recall/distill/helper work does not accidentally route through this skill.
- Makes the provider data boundary explicit: `ask` and `smoke` send prompt text through the authenticated provider.
- Keeps `status` output boring on purpose. It reports bridge availability without printing auth mode, token presence, API-key presence, or machine paths.
- Gives other skills a clean pattern for using ChatGPT-web-login-backed model calls without pretending an API key exists.

## Why This Hits Different

- The agent never gets your ChatGPT tokens.
- The skill never reads your auth file.
- The package never includes your credentials.
- If the local CLI is not logged in, it says so and stops. It does not beg for secrets like a sloppy little credential vacuum.
- It is strict on purpose. If it blocks a sketchy credential move, it is doing its damn job.

## Core Rule

Never read, print, copy, export, package, or persist raw auth tokens, browser cookies, API keys, session files, or account secrets.

The bridge must call an already-authenticated local CLI and let that CLI handle auth internally. No token spelunking. No cookie scraping. No “just paste your key here” bullshit.

## Data Boundary Warning

This is not an offline local model. `ask` and `smoke` send their prompt text through the already-authenticated local Codex/ChatGPT provider. Treat that prompt text as data sent to the provider account.

Do not send passwords, API keys, browser cookies, private documents, regulated personal data, or other sensitive material unless the user explicitly accepts that provider exposure. This skill keeps credentials out of the agent's hands; it does not magically make submitted prompts private from the provider.

## Quick Start

Use the bundled bridge script:

```bash
node scripts/gpt-web-login-bridge.js status
node scripts/gpt-web-login-bridge.js smoke
node scripts/gpt-web-login-bridge.js ask "Return exactly OK."
```

Default provider is Codex CLI. The script uses:

```bash
codex exec --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral --json
```

This uses Codex auth while avoiding recursive user config, hooks, and persistent session files for the bridge call. It is the clean route: let Codex be logged in, let the bridge call Codex, keep the agent’s grubby little hands away from secrets.

Before running `ask` or `smoke`, confirm the prompt is safe to send to the authenticated provider. If the prompt contains secrets or private material, stop instead of forwarding it.

## Workflow

1. Run `node scripts/gpt-web-login-bridge.js status`.
2. If status shows ChatGPT/Codex login available, use `ask` only for prompt text the user is comfortable sending to the authenticated provider.
3. If status shows no login, report that the local CLI is not authenticated. Do not ask for secrets. Do not invent a fake API key. Do not do weird credential bullshit.
4. For portable packages, keep all paths relative to the skill folder and use environment variables for overrides.

## Commands

- `status`: report only whether the local provider is available. It must not print auth mode, token presence, API-key presence, raw paths, or secrets.
- `smoke`: send a fixed harmless prompt through the authenticated local provider to prove the bridge can get a model response.
- `ask "prompt"`: send the supplied prompt through the authenticated local provider. This transmits prompt content to that provider account.

The script also accepts prompt text on stdin:

```bash
printf '%s\n' "Return exactly OK." | node scripts/gpt-web-login-bridge.js ask
```

## Profane Uncle Matt Safety Voice

Say the real thing plainly: this skill exists so agents can use a logged-in local provider without doing dumb motherfucking secret-handling bullshit.

Use that voice in normal explanations for this skill. If bridge status fails, say exactly what failed; do not hide missing proof behind profanity.

## Files In This Skill

- `SKILL.md`: this loud no-secrets bridge rulebook.
- `scripts/gpt-web-login-bridge.js`: portable bridge script.
- `agents/openai.yaml`: UI metadata.

## Environment Overrides

- `GPT_WEB_LOGIN_PROVIDER=codex`: provider selector. Codex is the only provider shipped by default.
- `GPT_WEB_LOGIN_CODEX_BIN=codex`: Codex executable path or name.
- `GPT_WEB_LOGIN_CWD=/path`: working directory for bridge calls.

Do not add environment variables that contain secrets.

## TL;DR For Operators

- Install the skill.
- Make sure local Codex is logged in through ChatGPT.
- Run `node scripts/gpt-web-login-bridge.js status`.
- Run `node scripts/gpt-web-login-bridge.js smoke`.
- Use `ask` from this skill or copy the bridge pattern into another skill only for prompt text safe to send to the provider.
- If somebody wants raw tokens in the package, tell them no, because that is how people get wrecked.

## ClawHub Packaging Rules

- Include `SKILL.md`, `agents/openai.yaml`, and `scripts/gpt-web-login-bridge.js`.
- Do not include local auth files, browser cookie stores, API keys, local rollout logs, or machine-specific memory files.
- Do not hardcode user-specific paths.
- Publish as a **skill**, not a plugin.
- Target release: `1.420.69`.
- Before publishing, run:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" .
clawhub scan .
```

If publishing from another machine, use that machine's local validator path or skip only the validator path that does not exist. Keep `clawhub scan .` as the ClawHub readiness check.
