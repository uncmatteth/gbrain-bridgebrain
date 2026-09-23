# Direct computer tools for ordinary ChatGPT

Use [direct-chat/README.md](direct-chat/README.md).

The new `direct-chat/` package exposes local file, command, Git/worktree, job, browser and desktop tools directly through MCP. It does not launch Codex, call a model API or reuse ChatGPT browser credentials.

The original long-name model-login bridge remains unchanged for existing GBrain embeddings and still uses Codex. Do not use its `ask` command as a fallback for exhausted Codex allowance.

The new package must be initialized on the target computer and connected to an ordinary ChatGPT session that supports its tools. Repository code alone does not grant account features or establish that connection. See the package's verification record for tested behavior and outstanding deployment checks.
