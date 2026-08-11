# BERTopic + LDA graph pipeline

This pipeline uses the BERTopic dataset as the canonical corpus. The LDA build must
match every BERTopic node by exact `id` and `text`; the combine step stops rather
than silently merging partial or differently chunked corpora.

Run commands from the repository root after activating the project's Python 3.10
environment:

```bash
source .venv/bin/activate
```

## 1. Add BERTopic relationship links (optional separate view)

The original BERTopic output has a layout but an empty `links.json`. This creates
a separate linked copy without changing the original output:

```bash
python scripture-scope/scripts/build-topic-model-links.py \
  --input-dir output/bsb-bertopic-v1 \
  --output-dir output/bsb-bertopic-linked-v1 \
  --k 10 \
  --candidate-k 50
```

## 2. Rebuild LDA on the aligned nodes

```bash
python scripture-scope/scripts/build-aligned-lda-dataset.py \
  --bertopic-dir output/bsb-bertopic-v1 \
  --output-dir output/bsb-lda-aligned-v1 \
  --topics 40 \
  --k 10 \
  --candidate-k 50
```

This copies BERTopic's node IDs, passage text, ordering, and x/y coordinates, then
fits a deterministic LDA model to those exact texts. Holding the layout constant
makes the two separate views directly comparable.

## 3. Build the unified graph

```bash
python scripture-scope/scripts/combine-topic-model-datasets.py \
  --bertopic-dir output/bsb-bertopic-v1 \
  --lda-dir output/bsb-lda-aligned-v1 \
  --output-dir output/bsb-bertopic-lda-hybrid-v1 \
  --bertopic-weight 0.5 \
  --lda-weight 0.5 \
  --k 10 \
  --candidate-k 50
```

The combined distance is:

```text
(BERTopic weight × BERTopic JSD distance)
+ (LDA weight × LDA JSD distance)
```

Weights are normalized to sum to one. Both component distances use base-2,
square-root Jensen-Shannon distance and therefore range from 0 (same distribution)
to 1 (maximally different). Each emitted edge retains `bertopicDistance`,
`ldaDistance`, both normalized weights, and `combinedDistance`.

The large-corpus default uses deterministic NNDescent candidate search followed by
exact distance reranking. A link is kept only if both endpoints select each other
among their top `k`. Increase `--candidate-k` to trade runtime for better neighbor
recall. All scripts refuse to overwrite a nonempty output directory unless
`--force` is passed.

## Suggested experiments

- `0.5 / 0.5`: balanced exploratory view.
- `0.7 / 0.3`: favors semantic paraphrase and concept similarity.
- `0.3 / 0.7`: favors shared vocabulary and lexical themes.

Do not compare screen distance to link distance. Screen coordinates remain the
BERTopic UMAP projection; the edge fields are the calculated relationship measures.
