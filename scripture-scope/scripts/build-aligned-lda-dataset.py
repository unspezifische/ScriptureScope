#!/usr/bin/env python3
"""Fit LDA to the exact BERTopic passage corpus and emit a comparable graph."""

from __future__ import annotations

import argparse
import platform
from collections import Counter
from pathlib import Path

import numpy as np
import sklearn
from sklearn.decomposition import LatentDirichletAllocation
from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS

from topic_model_fusion import (
    generated_at,
    load_json,
    load_nodes,
    mutual_knn_links,
    require_output_directory,
    sha256_file,
    write_json,
)


EXTRA_STOP_WORDS = {
    "behold", "came", "come", "did", "does", "going", "said", "saying", "shall",
    "therefore", "thing", "things", "went", "will", "would", "yes",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bertopic-dir", type=Path, default=Path("output/bsb-bertopic-v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("output/bsb-lda-aligned-v1"))
    parser.add_argument("--topics", type=int, default=40)
    parser.add_argument("--max-features", type=int, default=30000)
    parser.add_argument("--min-df", type=int, default=3)
    parser.add_argument("--max-df", type=float, default=0.90)
    parser.add_argument("--max-iter", type=int, default=50)
    parser.add_argument("--top-terms", type=int, default=12)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--candidate-k", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.topics < 2:
        raise ValueError("--topics must be at least 2")
    require_output_directory(args.output_dir, args.force)
    canonical_nodes = load_nodes(args.bertopic_dir)
    source_metadata = load_json(args.bertopic_dir / "metadata.json")
    texts = [node["text"] for node in canonical_nodes]

    vectorizer = CountVectorizer(
        lowercase=True,
        stop_words=sorted(set(ENGLISH_STOP_WORDS) | EXTRA_STOP_WORDS),
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z']+\b",
        ngram_range=(1, 2),
        min_df=args.min_df,
        max_df=args.max_df,
        max_features=args.max_features,
    )
    counts = vectorizer.fit_transform(texts)
    if counts.shape[1] < args.topics:
        raise ValueError(f"Only {counts.shape[1]} terms survived vectorization for {args.topics} topics")

    model = LatentDirichletAllocation(
        n_components=args.topics,
        learning_method="batch",
        max_iter=args.max_iter,
        evaluate_every=-1,
        random_state=args.seed,
        n_jobs=1,
    )
    distributions = model.fit_transform(counts)
    distributions /= distributions.sum(axis=1, keepdims=True)
    vocabulary = np.asarray(vectorizer.get_feature_names_out())
    assigned_topics = distributions.argmax(axis=1)
    assigned_counts = Counter(int(topic) for topic in assigned_topics)

    topic_labels = []
    topic_names: list[str] = []
    used_names: Counter[str] = Counter()
    for topic_index, weights in enumerate(model.components_):
        term_indexes = weights.argsort()[::-1][: args.top_terms]
        terms = vocabulary[term_indexes].tolist()
        base_name = " / ".join(term.title() for term in terms[:3])
        used_names[base_name] += 1
        name = base_name if used_names[base_name] == 1 else f"{base_name} · {used_names[base_name]}"
        topic_names.append(name)
        members = np.flatnonzero(assigned_topics == topic_index)
        representatives = sorted(
            members,
            key=lambda index: (-float(distributions[index, topic_index]), canonical_nodes[index]["id"]),
        )[:8]
        topic_labels.append({
            "id": f"lda-topic-{topic_index + 1:02d}",
            "modelTopic": topic_index,
            "distributionIndex": topic_index,
            "name": name,
            "count": assigned_counts[topic_index],
            "terms": terms,
            "representativePassages": [canonical_nodes[index]["id"] for index in representatives],
        })

    output_nodes = []
    for index, source in enumerate(canonical_nodes):
        topic_index = int(assigned_topics[index])
        distribution = [round(float(value), 12) for value in distributions[index]]
        # Correct rounding drift while keeping topicProbability exactly tied to the stored vector.
        distribution[-1] = round(distribution[-1] + (1.0 - sum(distribution)), 12)
        output_nodes.append({
            "id": source["id"],
            "text": source["text"],
            "x": source["x"],
            "y": source["y"],
            "group": topic_names[topic_index],
            "topicId": f"lda-topic-{topic_index + 1:02d}",
            "topicName": topic_names[topic_index],
            "topicProbability": distribution[topic_index],
            "topicDistribution": distribution,
            "topicTerms": topic_labels[topic_index]["terms"],
        })

    links, link_report = mutual_knn_links(
        [node["id"] for node in output_nodes],
        [distributions],
        [1.0],
        args.k,
        args.candidate_k,
        args.seed,
        ["lda"],
    )
    generated = generated_at()
    write_json(args.output_dir / "nodes.json", output_nodes)
    write_json(args.output_dir / "links.json", links)
    write_json(args.output_dir / "topic-labels.json", topic_labels)

    report = {
        "generatedAt": generated,
        "canonicalCorpus": {
            "datasetId": source_metadata.get("id"),
            "nodesSha256": sha256_file(args.bertopic_dir / "nodes.json"),
            "nodeCount": len(output_nodes),
            "alignment": "Exact node ids, text, order, and display coordinates copied from BERTopic",
        },
        "runtime": {
            "pythonVersion": platform.python_version(),
            "numpy": np.__version__,
            "scikitLearn": sklearn.__version__,
        },
        "model": {
            "algorithm": "scikit-learn batch variational LatentDirichletAllocation",
            "topicCount": args.topics,
            "seed": args.seed,
            "maxIterations": args.max_iter,
            "vocabularySize": int(counts.shape[1]),
            "documentTermNonzeroCount": int(counts.nnz),
            "vectorizer": {
                "ngramRange": [1, 2], "minimumDocumentFrequency": args.min_df,
                "maximumDocumentFrequency": args.max_df, "maximumFeatures": args.max_features,
            },
        },
        "relationshipGraph": link_report,
    }
    write_json(args.output_dir / "model-report.json", report)
    metadata = {
        "id": "bsb-lda-aligned-v1",
        "displayName": "BSB Lexical Topics · aligned LDA v1",
        "description": "A lexical LDA topic graph fitted to exactly the same passage nodes and text used by the BERTopic dataset, enabling node-for-node comparison.",
        "calculation": "Passage word and bigram counts are transformed into LDA topic probabilities. Links connect reciprocal nearest neighbors by base-2 square-root Jensen-Shannon distance between those probability vectors.",
        "methodType": "analysis-and-layout",
        "bibleVersion": source_metadata.get("bibleVersion", "Berean Study Bible (BSB)"),
        "corpusVersion": source_metadata.get("corpusVersion", "unknown"),
        "generatedAt": generated,
        "representation": {
            "id": "count-vector-lda-topic-distribution", "version": "1.0.0",
            "description": "Each canonical BERTopic passage is represented as a normalized probability distribution over deterministic lexical LDA topics.",
            "parameters": report["model"],
        },
        "relationship": {
            "id": "lda-jsd-mutual-knn", "version": "1.0.0",
            "metric": "base-2 square-root Jensen-Shannon distance",
            "scoreKind": "distance", "scoreDirection": "lower-is-closer",
            "linkRule": "Retain an undirected edge only when both passages rank each other in their top-k candidate-reranked neighbors.",
            "parameters": link_report,
        },
        "layout": {
            **source_metadata["layout"],
            "distanceMeaning": "Coordinates are copied exactly from the BERTopic UMAP layout so visual changes between model views reflect topic assignments and links, not a moving layout.",
        },
        "ldaModel": report["model"],
        "parameters": {"nodeCount": len(output_nodes), "linkCount": len(links), "topicCount": args.topics},
        "artifacts": {
            "nodesSha256": sha256_file(args.output_dir / "nodes.json"),
            "linksSha256": sha256_file(args.output_dir / "links.json"),
            "topicLabelsSha256": sha256_file(args.output_dir / "topic-labels.json"),
        },
        "sources": ["https://scikit-learn.org/stable/modules/decomposition.html#latentdirichletallocation"],
    }
    write_json(args.output_dir / "metadata.json", metadata)
    print(f"Wrote {len(output_nodes):,} aligned LDA nodes and {len(links):,} links to {args.output_dir}")


if __name__ == "__main__":
    main()
