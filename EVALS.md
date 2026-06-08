# Evals

BridgeBrain ships eval tooling so claims stay evidence-backed.

## Mock Eval

Mock mode does not call Codex or ChatGPT. It proves the adapter, vector shape, scorer, and fixtures work.

```bash
node scripts/eval.js
```

Output includes:

- `recall_at_k`
- `mrr`
- ranked results per query

## Live Eval

Run against an installed BridgeBrain service:

```bash
node scripts/eval.js --live
```

Live mode reads GBrain's configured LiteLLM base URL by default. Override with `BRIDGEBRAIN_EVAL_BASE_URL` and pass bearer auth with `BRIDGEBRAIN_API_TOKEN` or `GBRAIN_CHATGPT_EMBED_TOKEN` when needed.

Live mode sends fixture/query text through the authenticated provider account. Review the fixture data before running on private corpora.

## Custom Corpus

Replace or extend:

- `evals/fixture-corpus.json`
- `evals/query-set.json`

Corpus entries:

```json
{
  "id": "doc-id",
  "text": "document text"
}
```

Query entries:

```json
{
  "query": "search text",
  "relevant": ["doc-id"]
}
```

## CI Thresholds

Optional recall threshold:

```bash
BRIDGEBRAIN_EVAL_MIN_RECALL=0.8 node scripts/eval.js
```

Do not publish benchmark claims without publishing:

- Corpus.
- Query set.
- Relevance labels.
- BridgeBrain profile.
- Dimensions.
- Live or mock mode.
- Comparison target.
- Scores.

Anything less is benchmark theater bullshit.
