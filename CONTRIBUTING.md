# Contributing

Good contributions make BridgeBrain more measurable, safer, or easier to install.

## Before Opening A PR

Run:

```bash
npm run check
```

If PowerShell is not available on your machine, say so in the PR. Do not pretend Windows syntax was verified.

## Benchmark Results

Include:

- Corpus source or fixture file.
- Query set.
- Relevance labels.
- BridgeBrain profile.
- Dimensions.
- Mock or live mode.
- Recall/MRR output.
- Comparison target, if any.

No hidden corpus, no vague "better search" claims. Evidence or it is bullshit.

## Retrieval Failures

Useful report:

```text
query:
expected document id:
top returned ids:
profile:
dimensions:
live or mock:
why expected doc should match:
```

Do not include private documents unless you are comfortable making them public.

## Security Fixes

Keep credential handling boring:

- No raw credential reads.
- No cookie scraping.
- No login automation.
- No extra provider keys.
- No public cache artifacts.

## Code Style

- Node.js built-in modules only for the adapter and repo scripts.
- Keep platform installers readable.
- Prefer hard failure over silent partial setup.
- Preserve 1536 as default quality mode.
- Keep 768 as explicit compatibility fallback.
