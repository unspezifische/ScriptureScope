#!/usr/bin/env python3
"""Migrate generated graph artifacts from USFM codes to canonical book names."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from bible_books import canonical_book_name, canonicalize_reference
from topic_model_fusion import load_json, sha256_file, write_json

DEFAULT_DATASETS = [
    "bsb-bertopic-v1",
    "bsb-bertopic-linked-v1",
    "bsb-lda-aligned-v1",
    "bsb-bertopic-lda-hybrid-v1",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=Path("output"))
    parser.add_argument("--source-nodes", type=Path, default=Path("output/source-nodes.json"))
    parser.add_argument("--dataset", action="append", dest="datasets")
    return parser.parse_args()


def normalize_node(node: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(node)
    normalized["id"] = canonicalize_reference(node["id"])
    if isinstance(node.get("reference"), str):
        normalized["reference"] = canonicalize_reference(node["reference"])
    if isinstance(node.get("book"), str):
        normalized["book"] = canonical_book_name(node["book"])
    if isinstance(node.get("verses"), list):
        normalized["verses"] = [canonicalize_reference(value) for value in node["verses"]]
    return normalized


def normalize_nodes(nodes: list[dict[str, Any]], label: str) -> list[dict[str, Any]]:
    normalized = [normalize_node(node) for node in nodes]
    ids = [node["id"] for node in normalized]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{label}: canonical book names created duplicate node ids")
    return normalized


def normalize_reference_lists(value: Any) -> Any:
    if isinstance(value, list):
        return [normalize_reference_lists(item) for item in value]
    if not isinstance(value, dict):
        return value
    normalized = {}
    for key, item in value.items():
        if key in {"representativePassages", "verses"} and isinstance(item, list):
            normalized[key] = [canonicalize_reference(reference) for reference in item]
        elif key == "reference" and isinstance(item, str):
            normalized[key] = canonicalize_reference(item)
        else:
            normalized[key] = normalize_reference_lists(item)
    return normalized


def migrate_source(path: Path) -> None:
    payload = load_json(path)
    if isinstance(payload, list):
        write_json(path, normalize_nodes(payload, str(path)))
        return
    payload["nodes"] = normalize_nodes(payload["nodes"], str(path))
    if isinstance(payload.get("books"), list):
        payload["books"] = [
            {**book, "name": canonical_book_name(book.get("code", ""))} for book in payload["books"]
        ]
    write_json(path, payload)


def migrate_dataset(directory: Path) -> None:
    nodes_path = directory / "nodes.json"
    links_path = directory / "links.json"
    write_json(nodes_path, normalize_nodes(load_json(nodes_path), str(nodes_path)))
    if links_path.exists():
        links = load_json(links_path)
        for link in links:
            link["source"] = canonicalize_reference(link["source"])
            link["target"] = canonicalize_reference(link["target"])
        write_json(links_path, links)
    for filename in ["topic-labels.json", "model-report.json"]:
        path = directory / filename
        if path.exists():
            write_json(path, normalize_reference_lists(load_json(path)))


def update_provenance(output_root: Path, source_path: Path, dataset_names: list[str]) -> None:
    source_hash = sha256_file(source_path)
    corpus_version = f"canonical-bsb-passage-corpus-{source_hash[:12]}"
    hashes = {
        name: sha256_file(output_root / name / "nodes.json") for name in dataset_names
    }
    report_updates = {
        "bsb-bertopic-v1": [("input", "sha256", source_hash)],
        "bsb-bertopic-linked-v1": [(None, "sourceNodesSha256", hashes.get("bsb-bertopic-v1"))],
        "bsb-lda-aligned-v1": [("canonicalCorpus", "nodesSha256", hashes.get("bsb-bertopic-v1"))],
    }
    for name, updates in report_updates.items():
        path = output_root / name / "model-report.json"
        if name not in dataset_names or not path.exists():
            continue
        report = load_json(path)
        for parent, key, value in updates:
            if value is not None:
                (report if parent is None else report[parent])[key] = value
        write_json(path, report)

    hybrid_report_path = output_root / "bsb-bertopic-lda-hybrid-v1" / "model-report.json"
    if "bsb-bertopic-lda-hybrid-v1" in dataset_names and hybrid_report_path.exists():
        report = load_json(hybrid_report_path)
        report["inputs"]["bertopic"]["nodesSha256"] = hashes["bsb-bertopic-v1"]
        report["inputs"]["lda"]["nodesSha256"] = hashes["bsb-lda-aligned-v1"]
        write_json(hybrid_report_path, report)

    for name in dataset_names:
        directory = output_root / name
        metadata_path = directory / "metadata.json"
        metadata = load_json(metadata_path)
        metadata["corpusVersion"] = corpus_version
        metadata["referenceFormat"] = "Canonical English book name followed by chapter and verse"
        metadata["artifacts"]["nodesSha256"] = sha256_file(directory / "nodes.json")
        metadata["artifacts"]["linksSha256"] = sha256_file(directory / "links.json")
        labels_path = directory / "topic-labels.json"
        if labels_path.exists():
            metadata["artifacts"]["topicLabelsSha256"] = sha256_file(labels_path)
        write_json(metadata_path, metadata)


def main() -> None:
    args = parse_args()
    dataset_names = args.datasets or DEFAULT_DATASETS
    migrate_source(args.source_nodes)
    for name in dataset_names:
        migrate_dataset(args.output_root / name)
    update_provenance(args.output_root, args.source_nodes, dataset_names)
    print(f"Normalized canonical book names in {len(dataset_names)} datasets and {args.source_nodes}")


if __name__ == "__main__":
    main()
