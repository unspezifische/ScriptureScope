# TF-IDF cosine mutual-kNN v1

This packet is ScriptureScope's interpretable lexical baseline. It changes only the representation and relationship calculation while holding the passage corpus, groups, and DrL coordinates constant.

## Contents

- `nodes.json`: 3,016 valid passages with the controlled coordinates shared by the LDA comparison packet.
- `links.json`: 8,643 canonical undirected links with cosine similarity, endpoint ranks, and up to five shared evidence terms.
- `metadata.json`: complete corpus, representation, relationship, layout, and artifact provenance.
- `export-report.json`: source export diagnostics and the rejected empty `-11:` record.
- `model-report.json`: vocabulary, score distribution, and graph structure diagnostics.

For the inspected `1 Kings 6:23-6:30` passage about the temple cherubim, the strongest results include the parallel in `2 Chronicles 3:10-3:13`, related temple imagery in `Ezekiel 41`, adjacent temple construction passages in `1 Kings 6`, and the tabernacle cherubim in `Exodus 25` and `Exodus 37`. The stored shared terms make the reason for each lexical relationship inspectable.

This graph shares only 282 edges with the Jensen–Shannon LDA graph: a 1.55% edge-set Jaccard overlap, with 96.74% of the TF-IDF links absent from that topic graph. The two packets therefore provide materially different relationship signals for the planned evaluation; this difference alone is not evidence that either graph is generally better.

Regenerate the links with:

```bash
cd scripture-scope
npm run model:tfidf-links -- \
  --input ../datasets/tfidf_cosine_mutual_knn_v1/nodes.json \
  --output ../datasets/tfidf_cosine_mutual_knn_v1/links.json \
  --report ../datasets/tfidf_cosine_mutual_knn_v1/model-report.json \
  --k 10 \
  --min-df 2 \
  --max-df-ratio 0.8 \
  --force
```
