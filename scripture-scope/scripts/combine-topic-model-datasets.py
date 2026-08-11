#!/usr/bin/env python3
"""Combine node-aligned BERTopic and LDA distributions into one hybrid graph."""

from __future__ import annotations

import argparse
from pathlib import Path

from topic_model_fusion import (
    assert_aligned_nodes,
    distribution_matrix,
    generated_at,
    load_json,
    load_nodes,
    mutual_knn_links,
    require_output_directory,
    sha256_file,
    write_json,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bertopic-dir", type=Path, default=Path("output/bsb-bertopic-v1"))
    parser.add_argument("--lda-dir", type=Path, default=Path("output/bsb-lda-aligned-v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("output/bsb-bertopic-lda-hybrid-v1"))
    parser.add_argument("--bertopic-weight", type=float, default=0.5)
    parser.add_argument("--lda-weight", type=float, default=0.5)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--candidate-k", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    require_output_directory(args.output_dir, args.force)
    bertopic_nodes = load_nodes(args.bertopic_dir)
    lda_nodes = assert_aligned_nodes(bertopic_nodes, load_nodes(args.lda_dir))
    bertopic_metadata = load_json(args.bertopic_dir / "metadata.json")
    lda_metadata = load_json(args.lda_dir / "metadata.json")
    bertopic_matrix = distribution_matrix(bertopic_nodes, ["topicDistribution"])
    lda_matrix = distribution_matrix(lda_nodes, ["topicDistribution", "topic_distribution"])

    links, link_report = mutual_knn_links(
        [node["id"] for node in bertopic_nodes],
        [bertopic_matrix, lda_matrix],
        [args.bertopic_weight, args.lda_weight],
        args.k,
        args.candidate_k,
        args.seed,
        ["bertopic", "lda"],
    )
    output_nodes = []
    for bertopic, lda in zip(bertopic_nodes, lda_nodes):
        output_nodes.append({
            **bertopic,
            "bertopicTopicId": bertopic.get("topicId"),
            "bertopicTopicName": bertopic.get("topicName"),
            "bertopicTopicProbability": bertopic.get("topicProbability"),
            "ldaTopicId": lda.get("topicId"),
            "ldaTopicName": lda.get("topicName"),
            "ldaTopicProbability": lda.get("topicProbability"),
            "ldaTopicDistribution": lda.get("topicDistribution"),
            "ldaTopicTerms": lda.get("topicTerms"),
        })

    generated = generated_at()
    write_json(args.output_dir / "nodes.json", output_nodes)
    write_json(args.output_dir / "links.json", links)
    report = {
        "generatedAt": generated,
        "alignment": {
            "status": "exact",
            "rule": "BERTopic is canonical; every LDA node must have the same id and exact text",
            "nodeCount": len(output_nodes),
        },
        "inputs": {
            "bertopic": {
                "id": bertopic_metadata.get("id"),
                "nodesSha256": sha256_file(args.bertopic_dir / "nodes.json"),
            },
            "lda": {
                "id": lda_metadata.get("id"),
                "nodesSha256": sha256_file(args.lda_dir / "nodes.json"),
            },
        },
        "relationshipGraph": link_report,
        "distanceFormula": "combined = normalized_bertopic_weight * JSD_distance(bertopic) + normalized_lda_weight * JSD_distance(lda)",
    }
    write_json(args.output_dir / "model-report.json", report)
    metadata = {
        "id": "bsb-bertopic-lda-hybrid-v1",
        "displayName": "BSB Hybrid Topics · BERTopic + LDA v1",
        "description": "A node-aligned hybrid graph combining transformer-based semantic topic affinity with lexical LDA topic affinity for every canonical BSB passage.",
        "calculation": "Each model independently supplies a base-2 square-root Jensen-Shannon distance in the zero-to-one range. The hybrid distance is their normalized weighted arithmetic mean, and reciprocal top-k neighbors become links.",
        "methodType": "analysis-and-layout",
        "bibleVersion": bertopic_metadata.get("bibleVersion", "Berean Study Bible (BSB)"),
        "corpusVersion": bertopic_metadata.get("corpusVersion", "unknown"),
        "generatedAt": generated,
        "representation": {
            "id": "aligned-bertopic-and-lda-distributions", "version": "1.0.0",
            "description": "Every passage carries its BERTopic semantic-affinity distribution and its independently fitted LDA lexical-topic distribution on exactly matching text.",
            "parameters": {
                "bertopicDimensions": int(bertopic_matrix.shape[1]),
                "ldaDimensions": int(lda_matrix.shape[1]),
                "alignment": "exact id and text equality",
            },
        },
        "relationship": {
            "id": "weighted-bertopic-lda-jsd-mutual-knn", "version": "1.0.0",
            "metric": "weighted mean of per-model base-2 square-root Jensen-Shannon distances",
            "scoreKind": "distance", "scoreDirection": "lower-is-closer",
            "linkRule": "Candidate neighbors are proposed independently in each model, exactly reranked by the hybrid distance, and retained only for reciprocal top-k pairs.",
            "parameters": link_report,
        },
        "layout": {
            **bertopic_metadata["layout"],
            "distanceMeaning": "Coordinates are the original BERTopic UMAP projection and are held constant across the BERTopic, aligned LDA, and hybrid views; link distance is separate from screen distance.",
        },
        "models": {
            "bertopic": {"datasetId": bertopic_metadata.get("id"), "metadata": bertopic_metadata.get("topicModel")},
            "lda": {"datasetId": lda_metadata.get("id"), "metadata": lda_metadata.get("ldaModel")},
        },
        "parameters": {"nodeCount": len(output_nodes), "linkCount": len(links)},
        "artifacts": {
            "nodesSha256": sha256_file(args.output_dir / "nodes.json"),
            "linksSha256": sha256_file(args.output_dir / "links.json"),
        },
        "sources": [
            "https://maartengr.github.io/BERTopic/",
            "https://scikit-learn.org/stable/modules/decomposition.html#latentdirichletallocation",
        ],
    }
    write_json(args.output_dir / "metadata.json", metadata)
    print(f"Wrote {len(output_nodes):,} hybrid nodes and {len(links):,} links to {args.output_dir}")


if __name__ == "__main__":
    main()
