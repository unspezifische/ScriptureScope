#!/usr/bin/env python3
"""Clone a topic-model dataset and add scalable mutual-kNN distribution links."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from topic_model_fusion import (
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
    parser.add_argument("--input-dir", type=Path, default=Path("output/bsb-bertopic-v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("output/bsb-bertopic-linked-v1"))
    parser.add_argument("--dataset-id", default="bsb-bertopic-linked-v1")
    parser.add_argument("--display-name", default="BSB Semantic Topics · BERTopic linked v1")
    parser.add_argument("--distribution-field", default="topicDistribution")
    parser.add_argument("--model-name", default="bertopic")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--candidate-k", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    require_output_directory(args.output_dir, args.force)
    nodes = load_nodes(args.input_dir)
    matrix = distribution_matrix(nodes, [args.distribution_field])
    links, link_report = mutual_knn_links(
        [node["id"] for node in nodes], [matrix], [1.0], args.k, args.candidate_k,
        args.seed, [args.model_name],
    )
    shutil.copyfile(args.input_dir / "nodes.json", args.output_dir / "nodes.json")
    write_json(args.output_dir / "links.json", links)
    labels_path = args.input_dir / "topic-labels.json"
    if labels_path.exists():
        shutil.copyfile(labels_path, args.output_dir / "topic-labels.json")

    generated = generated_at()
    write_json(args.output_dir / "model-report.json", {
        "generatedAt": generated,
        "sourceDataset": str(args.input_dir),
        "sourceNodesSha256": sha256_file(args.input_dir / "nodes.json"),
        "relationshipGraph": link_report,
    })
    metadata = load_json(args.input_dir / "metadata.json")
    metadata.update({
        "id": args.dataset_id,
        "displayName": args.display_name,
        "generatedAt": generated,
        "description": f"{metadata['description']} This linked variant adds reciprocal nearest-neighbor topic-affinity relationships.",
        "calculation": f"{metadata['calculation']} Links use base-2 square-root Jensen-Shannon distance between stored topic distributions.",
        "relationship": {
            "id": f"{args.model_name}-jsd-mutual-knn", "version": "1.0.0",
            "metric": "base-2 square-root Jensen-Shannon distance",
            "scoreKind": "distance", "scoreDirection": "lower-is-closer",
            "linkRule": "Retain an undirected edge only when both passages rank each other in their candidate-reranked top-k neighbors.",
            "parameters": link_report,
        },
        "parameters": {**metadata.get("parameters", {}), "linkCount": len(links)},
        "artifacts": {
            "nodesSha256": sha256_file(args.output_dir / "nodes.json"),
            "linksSha256": sha256_file(args.output_dir / "links.json"),
            **({"topicLabelsSha256": sha256_file(args.output_dir / "topic-labels.json")} if labels_path.exists() else {}),
        },
    })
    write_json(args.output_dir / "metadata.json", metadata)
    print(f"Wrote {len(nodes):,} nodes and {len(links):,} links to {args.output_dir}")


if __name__ == "__main__":
    main()
