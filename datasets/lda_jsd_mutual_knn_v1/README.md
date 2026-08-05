# LDA Jensen–Shannon mutual-kNN v1

This packet is the first controlled relationship-model comparison for ScriptureScope. It changes the legacy LDA link metric and neighbor-selection rule while holding passage text, ten-topic representations, groups, and DrL coordinates constant.

## Contents

- `nodes.json`: 3,016 valid passages with typed ten-topic vectors and controlled DrL coordinates.
- `links.json`: 9,797 canonical undirected mutual-neighbor relationships.
- `metadata.json`: corpus, representation, relationship, layout, and artifact provenance.
- `export-report.json`: Firestore export counts and the rejected empty `-11:` record.
- `model-report.json`: graph structure and score-distribution diagnostics.

No distance threshold was applied. The 96 isolated passages and smaller components are intentionally preserved so weak relationships are not fabricated. A threshold should only be introduced after benchmark and reader evaluation.

This metric change does not by itself solve the legacy topic model's relevance problems. For the inspected `1 Kings 6:23-6:30` passage about temple cherubim, it retained the same ten neighbors as the legacy squared-Euclidean graph, including several passages with no obvious study relationship. Treat this packet as a controlled metric/link-rule experiment, not as a presumed replacement.

Regenerate the packet from the repository root with:

```bash
cd scripture-scope
npm run data:export-legacy-topic-corpus -- \
  --output ../datasets/lda_jsd_mutual_knn_v1/nodes.json \
  --report ../datasets/lda_jsd_mutual_knn_v1/export-report.json \
  --allow-rejected 1 \
  --force

npm run model:topic-links -- \
  --input ../datasets/lda_jsd_mutual_knn_v1/nodes.json \
  --output ../datasets/lda_jsd_mutual_knn_v1/links.json \
  --report ../datasets/lda_jsd_mutual_knn_v1/model-report.json \
  --k 10 \
  --force
```
