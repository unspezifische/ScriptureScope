# Contributing a data method

Create one directory per method using a stable ID that contains only letters, numbers, underscores, or hyphens:

```text
datasets/<method-id>/
  metadata.json
  nodes.json
  links.json
```

`metadata.json` must describe the corpus, passage representation, relationship calculation, and screen layout separately. Pull requests with missing or blank descriptions or calculation details fail validation.

```json
{
  "id": "example_method",
  "displayName": "Example Method",
  "description": "A plain-language explanation of what a reader should understand from this view.",
  "calculation": "A reproducible explanation of preprocessing, model or layout algorithm, parameters, similarity metric, thresholds, and projection steps.",
  "methodType": "analysis-and-layout",
  "bibleVersion": "BSB",
  "corpusVersion": "bsb-curated-passages-v1",
  "generatedAt": "2026-08-04T00:00:00Z",
  "representation": {
    "id": "gensim-lda",
    "version": "1.0.0",
    "description": "Each passage is represented as a probability mixture over ten learned word topics.",
    "parameters": { "topics": 10 }
  },
  "relationship": {
    "id": "lda-jensen-shannon-mutual-knn",
    "version": "1.0.0",
    "metric": "jensen-shannon-distance",
    "scoreKind": "distance",
    "scoreDirection": "lower-is-closer",
    "linkRule": "mutual-knn-with-maximum-distance",
    "parameters": { "k": 10, "maximumDistance": 0.35 }
  },
  "layout": {
    "id": "drl",
    "version": "igraph-2.1",
    "distanceMeaning": "Screen distance reflects force-directed graph geometry and is not the raw relationship distance.",
    "parameters": {}
  },
  "artifacts": {
    "nodesSha256": "64-character lowercase SHA-256 digest",
    "linksSha256": "64-character lowercase SHA-256 digest"
  },
  "parameters": {},
  "sources": []
}
```

`nodes.json` must be a nonempty array. Every node needs a unique nonblank `id`, nonblank `text`, and either finite numeric `x`/`y` coordinates or a numeric `topic_distribution` containing at least two values.

`links.json` represents an undirected graph. Store each passage pair once—never submit a reverse copy or repeated import—and do not submit self-links. Endpoints must match node IDs. Every linked dataset must use the score field declared by `relationship.scoreKind`:

```json
{
  "source": "JHN 3:16",
  "target": "ROM 5:8",
  "distance": 0.1274
}
```

Use `distance` when lower values are closer or `similarity` when higher values are closer. The ambiguous legacy field `value` is not accepted for new datasets. Analysis-only datasets may submit an empty link array, but must set `relationship` to `null` and explain that no links are supplied.

The validator recalculates the `nodes.json` and `links.json` SHA-256 digests, so any regenerated data must be accompanied by updated artifact hashes in `metadata.json`.

## Generate the revised LDA relationship baseline

The first model-side experiment compares topic distributions with Jensen–Shannon distance and keeps only mutual nearest neighbors. This is more appropriate for probability mixtures than the legacy squared Euclidean calculation, avoids guaranteeing weak one-way links, and emits each undirected pair once.

```bash
cd scripture-scope
npm run model:topic-links -- \
  --input ../datasets/<method-id>/nodes.json \
  --output ../datasets/<method-id>/links.json \
  --k 10 \
  --max-distance 0.35
```

`--max-distance` must be chosen from benchmark results; `0.35` above is an example, not a recommended production threshold. Omit it to generate an unthresholded mutual-kNN candidate set for evaluation. Existing output files are protected unless `--force` is supplied.

Validate before opening a pull request:

```bash
cd scripture-scope
npm run validate:datasets
```

See [`schemas/model-metadata.schema.json`](../schemas/model-metadata.schema.json) for the metadata contract.
