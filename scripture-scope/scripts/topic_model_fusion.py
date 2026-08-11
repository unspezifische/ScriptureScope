#!/usr/bin/env python3
"""Shared, deterministic helpers for aligned topic-model graph datasets."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from bible_books import canonicalize_reference


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    """Write JSON atomically so an interrupted model run cannot leave a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def generated_at() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_output_directory(path: Path, force: bool) -> None:
    if path.exists() and any(path.iterdir()) and not force:
        raise ValueError(f"Output directory is not empty: {path}. Pass --force to replace its artifacts.")
    path.mkdir(parents=True, exist_ok=True)


def load_nodes(dataset_dir: Path) -> list[dict[str, Any]]:
    value = load_json(dataset_dir / "nodes.json")
    if not isinstance(value, list) or not value:
        raise ValueError(f"{dataset_dir / 'nodes.json'} must contain a nonempty array")
    seen: set[str] = set()
    for index, node in enumerate(value):
        node_id = node.get("id") if isinstance(node, dict) else None
        text = node.get("text") if isinstance(node, dict) else None
        if not isinstance(node_id, str) or not node_id.strip():
            raise ValueError(f"nodes.json[{index}] has no nonblank id")
        canonical_id = canonicalize_reference(node_id)
        if canonical_id in seen:
            raise ValueError(f"Duplicate node id: {node_id}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Node {node_id} has no nonblank text")
        node["id"] = canonical_id
        seen.add(canonical_id)
    return value


def distribution_matrix(
    nodes: Sequence[dict[str, Any]], fields: Sequence[str]
) -> np.ndarray:
    rows: list[np.ndarray] = []
    dimensions: int | None = None
    for node in nodes:
        raw = next((node.get(field) for field in fields if node.get(field) is not None), None)
        if not isinstance(raw, list) or not raw:
            raise ValueError(f"Node {node['id']} has no distribution in {', '.join(fields)}")
        row = np.asarray(raw, dtype=np.float64)
        if row.ndim != 1 or not np.all(np.isfinite(row)) or np.any(row < 0):
            raise ValueError(f"Node {node['id']} has an invalid probability distribution")
        if dimensions is None:
            dimensions = len(row)
        if len(row) != dimensions:
            raise ValueError(f"Node {node['id']} has {len(row)} dimensions; expected {dimensions}")
        total = float(row.sum())
        if total <= 0:
            raise ValueError(f"Node {node['id']} has a zero-sum probability distribution")
        rows.append(row / total)
    return np.vstack(rows)


def jensen_shannon_distance(left: np.ndarray, right: np.ndarray) -> float:
    """Base-2 square-root Jensen-Shannon distance, bounded from zero to one."""
    midpoint = (left + right) / 2.0
    with np.errstate(divide="ignore", invalid="ignore"):
        left_terms = np.where(left > 0, left * np.log2(left / midpoint), 0.0)
        right_terms = np.where(right > 0, right * np.log2(right / midpoint), 0.0)
    divergence = 0.5 * float(left_terms.sum() + right_terms.sum())
    return math.sqrt(max(0.0, min(1.0, divergence)))


def neighbor_candidates(
    matrix: np.ndarray,
    candidate_k: int,
    seed: int,
    exact_threshold: int = 512,
) -> tuple[list[set[int]], str]:
    node_count = matrix.shape[0]
    if node_count < 2:
        return [set() for _ in range(node_count)], "exact"
    candidate_k = min(max(1, candidate_k), node_count - 1)
    if node_count <= exact_threshold or candidate_k == node_count - 1:
        all_indexes = set(range(node_count))
        return [all_indexes - {index} for index in range(node_count)], "exact"

    try:
        from pynndescent import NNDescent
    except ImportError as error:
        raise RuntimeError(
            "pynndescent is required for a corpus this large; install requirements-bertopic.txt"
        ) from error

    index = NNDescent(
        matrix.astype(np.float32, copy=False),
        n_neighbors=min(node_count, candidate_k + 1),
        metric="jensen-shannon",
        random_state=seed,
        n_jobs=1,
        low_memory=True,
    )
    indexes, _ = index.neighbor_graph
    candidates = []
    for source, row in enumerate(indexes):
        candidates.append({int(target) for target in row if int(target) != source})
    return candidates, "approximate-nndescent-candidates-exact-rerank"


def mutual_knn_links(
    node_ids: Sequence[str],
    matrices: Sequence[np.ndarray],
    weights: Sequence[float],
    k: int,
    candidate_k: int,
    seed: int,
    model_names: Sequence[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not matrices or len(matrices) != len(weights) or len(matrices) != len(model_names):
        raise ValueError("matrices, weights, and model_names must have the same nonzero length")
    node_count = len(node_ids)
    if any(matrix.shape[0] != node_count for matrix in matrices):
        raise ValueError("Every distribution matrix must have one row per node")
    if k < 1 or candidate_k < k:
        raise ValueError("Require k >= 1 and candidate_k >= k")
    normalized_weights = np.asarray(weights, dtype=np.float64)
    if np.any(normalized_weights < 0) or float(normalized_weights.sum()) <= 0:
        raise ValueError("Model weights must be nonnegative and at least one must be positive")
    normalized_weights /= normalized_weights.sum()

    per_model_candidates = [neighbor_candidates(matrix, candidate_k, seed) for matrix in matrices]
    candidate_sets = [set() for _ in range(node_count)]
    for candidates, _ in per_model_candidates:
        for index, values in enumerate(candidates):
            candidate_sets[index].update(values)

    directed: list[list[tuple[int, float, list[float]]]] = []
    for source in range(node_count):
        scored: list[tuple[int, float, list[float]]] = []
        for target in candidate_sets[source]:
            distances = [
                jensen_shannon_distance(matrix[source], matrix[target]) for matrix in matrices
            ]
            combined = float(np.dot(normalized_weights, distances))
            scored.append((target, combined, distances))
        scored.sort(key=lambda item: (item[1], node_ids[item[0]]))
        directed.append(scored[: min(k, len(scored))])

    directed_lookup = [{target: rank for rank, (target, _, _) in enumerate(row, 1)} for row in directed]
    links: list[dict[str, Any]] = []
    for source, row in enumerate(directed):
        for source_rank, (target, combined, distances) in enumerate(row, 1):
            target_rank = directed_lookup[target].get(source)
            if target_rank is None or source >= target:
                continue
            link: dict[str, Any] = {
                "source": node_ids[source],
                "target": node_ids[target],
                "relationshipType": "hybrid-topic" if len(matrices) > 1 else "topic",
                "distance": round(combined, 12),
                "sourceRank": source_rank,
                "targetRank": target_rank,
            }
            if len(matrices) > 1:
                link["combinedDistance"] = round(combined, 12)
            for name, distance, weight in zip(model_names, distances, normalized_weights):
                link[f"{name}Distance"] = round(distance, 12)
                link[f"{name}Weight"] = round(float(weight), 12)
            links.append(link)
    links.sort(key=lambda link: (link["source"], link["target"]))
    methods = sorted({method for _, method in per_model_candidates})
    return links, {
        "nodeCount": node_count,
        "linkCount": len(links),
        "k": k,
        "candidateK": min(candidate_k, max(0, node_count - 1)),
        "candidateMethod": "+".join(methods),
        "weights": {name: round(float(weight), 12) for name, weight in zip(model_names, normalized_weights)},
    }


def assert_aligned_nodes(
    canonical: Sequence[dict[str, Any]], candidate: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    candidate_by_id = {node["id"]: node for node in candidate}
    canonical_ids = {node["id"] for node in canonical}
    missing = sorted(canonical_ids - candidate_by_id.keys())
    extra = sorted(candidate_by_id.keys() - canonical_ids)
    if missing or extra:
        raise ValueError(
            f"Node sets are not aligned: {len(missing)} missing and {len(extra)} extra ids; "
            f"examples missing={missing[:3]}, extra={extra[:3]}"
        )
    ordered = [candidate_by_id[node["id"]] for node in canonical]
    text_mismatches = [
        source["id"] for source, other in zip(canonical, ordered) if source["text"] != other["text"]
    ]
    if text_mismatches:
        raise ValueError(
            f"Node text differs for {len(text_mismatches)} ids; examples={text_mismatches[:3]}"
        )
    return ordered


def artifact_hashes(output_dir: Path, names: Iterable[str]) -> dict[str, str]:
    return {f"{Path(name).stem.replace('-', '_')}Sha256": sha256_file(output_dir / name) for name in names}
