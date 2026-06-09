# Evals

BridgeBrain ships eval tooling so claims stay evidence-backed.

## Mock Eval

Mock mode does not call Codex or ChatGPT. It proves the adapter, vector shape, scorer, and fixtures work.

```bash
node scripts/eval.js
```

Output includes:

- `hit_rate_at_k`
- `recall_at_k`
- `mrr`
- ranked results per query

## Live Eval

Run against an installed BridgeBrain service:

```bash
node scripts/eval.js --live
```

Live mode reads GBrain's configured LiteLLM base URL by default. Override with `BRIDGEBRAIN_EVAL_BASE_URL` and pass bearer auth with `BRIDGEBRAIN_API_TOKEN` or `GBRAIN_CHATGPT_EMBED_TOKEN` when needed. Remote eval URLs require `BRIDGEBRAIN_EVAL_ALLOW_REMOTE=1`; mock mode ignores `BRIDGEBRAIN_EVAL_BASE_URL` and uses only the spawned loopback service.

The eval model and dimensions default to the installed GBrain config in live mode, or the 1536 quality profile otherwise. Override with:

```bash
BRIDGEBRAIN_EVAL_MODEL=chatgpt-bridge-semantic-hash-768 \
BRIDGEBRAIN_EVAL_DIMENSIONS=768 \
node scripts/eval.js --live
```

Live mode sends fixture/query text through the authenticated provider account. Review the fixture data before running on private corpora.

## Custom Corpus

Replace or extend:

- `evals/fixture-corpus.json`
- `evals/query-set.json`

Or point at temporary fixture files:

```bash
BRIDGEBRAIN_EVAL_CORPUS=/path/to/corpus.json \
BRIDGEBRAIN_EVAL_QUERY_SET=/path/to/queries.json \
node scripts/eval.js
```

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

The corpus and query set must be non-empty. Every query must name at least one relevant document id, and every relevant id must exist in the corpus. `hit_rate_at_k` is the share of queries with at least one relevant result in the top K. `recall_at_k` is the average per-query share of relevant ids retrieved in the top K.

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
