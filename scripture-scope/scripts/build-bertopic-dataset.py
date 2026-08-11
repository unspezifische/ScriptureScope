#!/usr/bin/env python3
"""Build a reproducible BERTopic packet from ScriptureScope passage nodes."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bible_books import canonicalize_reference

# UMAP and numerical-library multi-threading can change floating-point reduction
# order. Set these before importing the modeling stack so the pinned runtime and
# seed produce stable output on the recorded platform.
for thread_variable in [
    "NUMBA_NUM_THREADS",
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
]:
    os.environ[thread_variable] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
GENERATOR_VERSION = "1.0.0"
TOPIC_AFFINITY_TEMPERATURE = 0.07
EXPECTED_RUNTIME_VERSIONS = {
    "bertopic": "0.17.4",
    "hdbscan": "0.8.44",
    "numpy": "2.2.6",
    "scikit-learn": "1.7.2",
    "sentence-transformers": "5.7.0",
    "torch": "2.13.0",
    "transformers": "5.14.1",
    "umap-learn": "0.5.12",
}
GENERIC_LABEL = re.compile(r"^topic\s+\d+$", re.IGNORECASE)
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[\"'“‘A-Z0-9])")
EXTRA_STOP_WORDS = {
    "according",
    "also",
    "among",
    "behold",
    "came",
    "come",
    "day",
    "every",
    "going",
    "like",
    "man",
    "men",
    "now",
    "one",
    "people",
    "said",
    "say",
    "says",
    "shall",
    "son",
    "sons",
    "therefore",
    "thing",
    "things",
    "three",
    "told",
    "two",
    "went",
}


def load_modeling_dependencies() -> None:
    global BERTopic, ClassTfidfTransformer, CountVectorizer, ENGLISH_STOP_WORDS
    global KeyBERTInspired, SentenceTransformer, UMAP, hdbscan, np, silhouette_score, torch

    try:
        import hdbscan as hdbscan_module
        import numpy as numpy_module
        import torch as torch_module
        from bertopic import BERTopic as bertopic_class
        from bertopic.representation import KeyBERTInspired as keybert_inspired_class
        from bertopic.vectorizers import ClassTfidfTransformer as ctfidf_class
        from sentence_transformers import SentenceTransformer as sentence_transformer_class
        from sklearn.feature_extraction.text import (
            CountVectorizer as count_vectorizer_class,
            ENGLISH_STOP_WORDS as english_stop_words,
        )
        from sklearn.metrics import silhouette_score as sklearn_silhouette_score
        from umap import UMAP as umap_class
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "BERTopic dependencies are missing. Install "
            "scripture-scope/scripts/requirements-bertopic.txt in a CPython 3.10 environment."
        ) from error

    hdbscan = hdbscan_module
    np = numpy_module
    torch = torch_module
    BERTopic = bertopic_class
    KeyBERTInspired = keybert_inspired_class
    ClassTfidfTransformer = ctfidf_class
    SentenceTransformer = sentence_transformer_class
    CountVectorizer = count_vectorizer_class
    ENGLISH_STOP_WORDS = english_stop_words
    silhouette_score = sklearn_silhouette_score
    UMAP = umap_class


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Source nodes.json path")
    parser.add_argument("--output-dir", required=True, help="Dataset output directory")
    parser.add_argument("--embedding-cache", help="Optional .npz embedding cache")
    parser.add_argument("--label-overrides", help="JSON object mapping model topic IDs to names")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--model-revision", default="")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--chunk-tokens", type=int, default=220)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--umap-neighbors", type=int, default=20)
    parser.add_argument("--min-cluster-size", type=int, default=30)
    parser.add_argument("--min-samples", type=int, default=8)
    parser.add_argument(
        "--allow-draft-labels",
        action="store_true",
        help="Allow keyword-composed draft names when no reviewed override file is supplied",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"Output already exists: {path}. Pass --force to replace it.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_nodes(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_nodes = payload if isinstance(payload, list) else payload.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("Input must be a JSON array or an object containing a nodes array.")

    nodes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw_node in enumerate(raw_nodes):
        if not isinstance(raw_node, dict):
            raise ValueError(f"Input node {index} must be a JSON object.")
        node_id = canonicalize_reference(str(raw_node.get("id", "")).strip())
        text = raw_node.get("text", "")
        text = text.strip() if isinstance(text, str) else ""
        if not node_id or not text:
            raise ValueError(f"Input node {index} needs a nonblank id and text.")
        if node_id in seen_ids:
            raise ValueError(f"Duplicate input node id: {node_id}")
        seen_ids.add(node_id)
        nodes.append({"id": node_id, "text": text})

    nodes.sort(key=lambda node: node["id"])
    return nodes


def split_document(text: str, tokenizer: Any, maximum_tokens: int) -> list[tuple[str, int]]:
    if maximum_tokens < 20:
        raise ValueError("--chunk-tokens must be at least 20.")

    pieces: list[tuple[str, int]] = []
    for sentence in SENTENCE_BOUNDARY.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        token_ids = tokenizer.encode(sentence, add_special_tokens=False)
        for offset in range(0, len(token_ids), maximum_tokens):
            piece_ids = token_ids[offset : offset + maximum_tokens]
            piece = tokenizer.decode(
                piece_ids,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            ).strip()
            if piece:
                pieces.append((piece, len(piece_ids)))

    chunks: list[tuple[str, int]] = []
    current_text: list[str] = []
    current_tokens = 0
    for piece, piece_tokens in pieces:
        if current_text and current_tokens + piece_tokens > maximum_tokens:
            chunks.append((" ".join(current_text), current_tokens))
            current_text = []
            current_tokens = 0
        current_text.append(piece)
        current_tokens += piece_tokens
    if current_text:
        chunks.append((" ".join(current_text), current_tokens))

    if chunks:
        return chunks
    fallback_tokens = tokenizer.encode(text, add_special_tokens=False)[:maximum_tokens]
    fallback_text = tokenizer.decode(
        fallback_tokens,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    ).strip()
    return [(fallback_text or text, max(1, len(fallback_tokens)))]


def embedding_cache_metadata(
    *,
    input_sha256: str,
    model: str,
    model_revision: str,
    chunk_tokens: int,
    model_max_sequence_length: int,
    node_ids: list[str],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "generatorVersion": GENERATOR_VERSION,
        "inputSha256": input_sha256,
        "model": model,
        "modelRevision": model_revision,
        "chunkTokens": chunk_tokens,
        "modelMaxSequenceLength": model_max_sequence_length,
        "runtimeVersions": EXPECTED_RUNTIME_VERSIONS,
        "nodeIdsSha256": hashlib.sha256("\n".join(node_ids).encode("utf-8")).hexdigest(),
    }


def load_embedding_cache(
    path: Path | None, expected_metadata: dict[str, Any], expected_node_count: int
) -> np.ndarray | None:
    if path is None or not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as cached:
            metadata = json.loads(str(cached["metadata"].item()))
            embeddings = cached["embeddings"]
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Ignoring unreadable embedding cache {path}: {error}")
        return None
    embeddings = np.asarray(embeddings, dtype=np.float32)
    embedding_norms = (
        np.linalg.norm(embeddings, axis=1) if embeddings.ndim == 2 else np.asarray([])
    )
    valid_embeddings = (
        embeddings.ndim == 2
        and embeddings.shape[0] == expected_node_count
        and embeddings.shape[1] > 0
        and np.isfinite(embeddings).all()
        and np.allclose(embedding_norms, 1.0, rtol=1e-4, atol=1e-5)
    )
    if metadata != expected_metadata or not valid_embeddings:
        print(f"Ignoring stale embedding cache: {path}")
        return None
    print(f"Loaded {len(embeddings):,} document embeddings from {path}")
    return embeddings


def save_embedding_cache(
    path: Path | None, metadata: dict[str, Any], embeddings: np.ndarray
) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}.npz")
    np.savez_compressed(
        temporary,
        metadata=np.asarray(json.dumps(metadata, sort_keys=True)),
        embeddings=np.asarray(embeddings, dtype=np.float32),
    )
    temporary.replace(path)
    print(f"Cached document embeddings at {path}")


def build_document_embeddings(
    nodes: list[dict[str, Any]],
    sentence_model: SentenceTransformer,
    chunk_tokens: int,
    batch_size: int,
) -> tuple[np.ndarray, int]:
    chunks: list[str] = []
    document_indexes: list[int] = []
    chunk_weights: list[int] = []
    for document_index, node in enumerate(nodes):
        document_chunks = split_document(node["text"], sentence_model.tokenizer, chunk_tokens)
        chunks.extend(chunk for chunk, _ in document_chunks)
        document_indexes.extend([document_index] * len(document_chunks))
        chunk_weights.extend(token_count for _, token_count in document_chunks)

    print(f"Encoding {len(chunks):,} chunks for {len(nodes):,} passages")
    chunk_embeddings = sentence_model.encode(
        chunks,
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    dimensions = chunk_embeddings.shape[1]
    document_embeddings = np.zeros((len(nodes), dimensions), dtype=np.float32)
    token_totals = np.zeros(len(nodes), dtype=np.float64)
    for chunk_embedding, document_index, token_count in zip(
        chunk_embeddings, document_indexes, chunk_weights
    ):
        document_embeddings[document_index] += chunk_embedding * token_count
        token_totals[document_index] += token_count
    document_embeddings /= token_totals[:, np.newaxis]
    norms = np.linalg.norm(document_embeddings, axis=1, keepdims=True)
    document_embeddings /= np.maximum(norms, np.finfo(np.float32).eps)
    return document_embeddings, len(chunks)


def resolved_model_revision(sentence_model: SentenceTransformer, requested_revision: str) -> str:
    if requested_revision:
        return requested_revision
    try:
        revision = sentence_model[0].auto_model.config._commit_hash
    except (AttributeError, IndexError):
        revision = None
    return str(revision or "unresolved")


def title_term(term: str) -> str:
    return " ".join(word.capitalize() for word in term.replace("_", " ").split())


def automatic_topic_name(terms: list[str]) -> str:
    selected: list[str] = []
    seen_words: set[str] = set()
    for term in terms:
        words = set(term.split())
        if not words or words <= seen_words:
            continue
        selected.append(title_term(term))
        seen_words.update(words)
        if len(selected) == 3:
            break
    return " / ".join(selected or ["Uncategorized"])


def load_label_overrides(path: Path | None, topic_ids: list[int]) -> dict[int, str]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Label overrides must be a JSON object keyed by model topic ID.")
    try:
        overrides = {int(key): str(value).strip() for key, value in payload.items()}
    except (TypeError, ValueError) as error:
        raise ValueError("Every topic override key must be an integer model topic ID.") from error
    if len(overrides) != len(payload):
        raise ValueError("Topic override keys must remain unique after integer normalization.")
    if set(overrides) != set(topic_ids):
        missing = sorted(set(topic_ids) - set(overrides))
        unexpected = sorted(set(overrides) - set(topic_ids))
        raise ValueError(
            f"Label overrides must cover every topic exactly; missing={missing}, unexpected={unexpected}"
        )
    if any(not name or GENERIC_LABEL.match(name) for name in overrides.values()):
        raise ValueError("Every topic override must be a meaningful non-placeholder name.")
    if len(set(overrides.values())) != len(overrides):
        raise ValueError("Topic override names must be unique.")
    return overrides


def softmax(
    values: np.ndarray, temperature: float = TOPIC_AFFINITY_TEMPERATURE
) -> np.ndarray:
    scaled = values / temperature
    scaled -= scaled.max(axis=1, keepdims=True)
    exponentials = np.exp(scaled)
    return exponentials / exponentials.sum(axis=1, keepdims=True)


def round_number(value: float, precision: int = 12) -> float:
    return float(f"{float(value):.{precision}g}")


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def validate_runtime_versions() -> dict[str, str]:
    actual_versions = {
        name: package_version(name) for name in EXPECTED_RUNTIME_VERSIONS
    }
    mismatches = {
        name: {"expected": expected, "actual": actual_versions[name]}
        for name, expected in EXPECTED_RUNTIME_VERSIONS.items()
        if actual_versions[name] != expected
    }
    if mismatches:
        raise RuntimeError(
            "The BERTopic runtime does not match requirements-bertopic.txt: "
            + json.dumps(mismatches, sort_keys=True)
        )
    if platform.python_implementation() != "CPython" or sys.version_info[:2] != (3, 10):
        raise RuntimeError(
            "The reproducible BERTopic build requires CPython 3.10; received "
            f"{platform.python_implementation()} {platform.python_version()}."
        )
    return actual_versions


def configure_deterministic_runtime(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)


def main() -> None:
    args = parse_arguments()
    if args.seed < 0:
        raise ValueError("--seed must be nonnegative.")
    if args.batch_size < 1:
        raise ValueError("--batch-size must be positive.")
    if args.chunk_tokens < 20:
        raise ValueError("--chunk-tokens must be at least 20.")
    if args.umap_neighbors < 2:
        raise ValueError("--umap-neighbors must be at least 2.")
    if args.min_cluster_size < 2 or args.min_samples < 1:
        raise ValueError("Cluster sizes must be positive and --min-cluster-size must be at least 2.")
    if not args.model.strip():
        raise ValueError("--model must be nonblank.")
    if args.model_revision and not re.fullmatch(r"[0-9a-f]{40}", args.model_revision):
        raise ValueError("--model-revision must be a full lowercase 40-character commit hash.")
    if not args.label_overrides and not args.allow_draft_labels:
        raise ValueError(
            "A complete reviewed --label-overrides file is required. Pass --allow-draft-labels "
            "only to generate a review draft."
        )

    load_modeling_dependencies()
    runtime_versions = validate_runtime_versions()
    configure_deterministic_runtime(args.seed)

    input_path = Path(args.input).resolve()
    output_directory = Path(args.output_dir).resolve()
    dataset_id = output_directory.name
    if not re.fullmatch(r"[A-Za-z0-9_-]+", dataset_id):
        raise ValueError(
            "The output directory name becomes metadata.id and may contain only letters, "
            "numbers, underscores, and hyphens."
        )
    cache_path = Path(args.embedding_cache).resolve() if args.embedding_cache else None
    overrides_path = Path(args.label_overrides).resolve() if args.label_overrides else None
    output_paths = {
        name: output_directory / name
        for name in ["nodes.json", "links.json", "topic-labels.json", "model-report.json", "metadata.json"]
    }
    if not args.force:
        existing = [str(path) for path in output_paths.values() if path.exists()]
        if existing:
            raise FileExistsError(f"Outputs already exist: {existing}. Pass --force to replace them.")
    paths_by_role = {
        "input": input_path,
        "embedding cache": cache_path,
        "label overrides": overrides_path,
        **{f"output {name}": path for name, path in output_paths.items()},
    }
    populated_paths = [path for path in paths_by_role.values() if path is not None]
    if len(set(populated_paths)) != len(populated_paths):
        raise ValueError("Input, embedding cache, label overrides, and generated output paths must differ.")
    if not input_path.is_file():
        raise ValueError(f"Input nodes file does not exist: {input_path}")
    if overrides_path is not None and not overrides_path.is_file():
        raise ValueError(f"Label override file does not exist: {overrides_path}")

    nodes = load_nodes(input_path)
    if args.umap_neighbors >= len(nodes):
        raise ValueError("--umap-neighbors must be smaller than the passage count.")
    if args.min_cluster_size >= len(nodes):
        raise ValueError("--min-cluster-size must be smaller than the passage count.")
    documents = [node["text"] for node in nodes]
    node_ids = [node["id"] for node in nodes]
    input_sha256 = sha256_file(input_path)

    sentence_model = SentenceTransformer(
        args.model,
        revision=args.model_revision or None,
        device="cpu",
    )
    model_revision = resolved_model_revision(sentence_model, args.model_revision)
    if model_revision == "unresolved" or not re.fullmatch(r"[0-9a-f]{40}", model_revision):
        raise RuntimeError(
            "The embedding model did not resolve to an immutable 40-character revision. "
            "Pass --model-revision with a full Hugging Face commit hash."
        )
    tokenizer_special_tokens = sentence_model.tokenizer.num_special_tokens_to_add(pair=False)
    maximum_chunk_tokens = int(sentence_model.max_seq_length) - tokenizer_special_tokens
    if args.chunk_tokens > maximum_chunk_tokens:
        raise ValueError(
            f"--chunk-tokens {args.chunk_tokens} exceeds the model-safe maximum "
            f"{maximum_chunk_tokens}."
        )
    cache_metadata = embedding_cache_metadata(
        input_sha256=input_sha256,
        model=args.model,
        model_revision=model_revision,
        chunk_tokens=args.chunk_tokens,
        model_max_sequence_length=int(sentence_model.max_seq_length),
        node_ids=node_ids,
    )
    document_embeddings = load_embedding_cache(cache_path, cache_metadata, len(nodes))
    if document_embeddings is None:
        document_embeddings, chunk_count = build_document_embeddings(
            nodes, sentence_model, args.chunk_tokens, args.batch_size
        )
        save_embedding_cache(cache_path, cache_metadata, document_embeddings)
    else:
        chunk_count = sum(
            len(split_document(node["text"], sentence_model.tokenizer, args.chunk_tokens))
            for node in nodes
        )

    stop_words = sorted(set(ENGLISH_STOP_WORDS) | EXTRA_STOP_WORDS)
    passage_vectorizer = CountVectorizer(
        stop_words=stop_words,
        ngram_range=(1, 2),
        min_df=3,
        max_df=0.9,
    )
    passage_vectorizer.fit(documents)
    vectorizer = CountVectorizer(
        stop_words=stop_words,
        ngram_range=(1, 2),
        vocabulary=passage_vectorizer.vocabulary_,
    )
    clustering_umap = UMAP(
        n_neighbors=args.umap_neighbors,
        n_components=5,
        min_dist=0.0,
        metric="cosine",
        random_state=args.seed,
        transform_seed=args.seed,
        low_memory=True,
    )
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
        min_samples=args.min_samples,
        metric="euclidean",
        cluster_selection_method="eom",
        prediction_data=True,
        core_dist_n_jobs=1,
    )
    topic_model = BERTopic(
        embedding_model=sentence_model,
        umap_model=clustering_umap,
        hdbscan_model=clusterer,
        vectorizer_model=vectorizer,
        ctfidf_model=ClassTfidfTransformer(bm25_weighting=True, reduce_frequent_words=True),
        representation_model=KeyBERTInspired(top_n_words=15),
        top_n_words=15,
        calculate_probabilities=False,
        verbose=True,
    )
    original_topics, _ = topic_model.fit_transform(
        documents, embeddings=document_embeddings
    )
    original_outlier_count = sum(topic == -1 for topic in original_topics)
    topics = list(original_topics)
    if original_outlier_count:
        topics = topic_model.reduce_outliers(
            documents,
            topics,
            strategy="embeddings",
            embeddings=document_embeddings,
        )
        topic_model.update_topics(
            documents,
            topics=topics,
            vectorizer_model=vectorizer,
            ctfidf_model=ClassTfidfTransformer(
                bm25_weighting=True, reduce_frequent_words=True
            ),
            representation_model=KeyBERTInspired(top_n_words=15),
            top_n_words=15,
        )
    if -1 in topics:
        raise RuntimeError("Outlier reassignment left one or more passages without a topic.")

    topic_ids = sorted(set(int(topic) for topic in topics))
    if topic_ids != list(range(len(topic_ids))):
        raise RuntimeError(f"Expected contiguous BERTopic IDs, received {topic_ids}.")
    topic_count = len(topic_ids)
    if topic_count < 2:
        raise RuntimeError("The model produced fewer than two topics; adjust clustering parameters.")

    coordinates = UMAP(
        n_neighbors=args.umap_neighbors,
        n_components=2,
        min_dist=0.08,
        metric="cosine",
        random_state=args.seed,
        transform_seed=args.seed,
        low_memory=True,
    ).fit_transform(document_embeddings)

    assignments = np.asarray(topics, dtype=np.int32)
    topic_centroids = np.vstack(
        [document_embeddings[assignments == topic].mean(axis=0) for topic in topic_ids]
    )
    topic_centroid_norms = np.linalg.norm(topic_centroids, axis=1, keepdims=True)
    if np.any(topic_centroid_norms <= np.finfo(np.float32).eps):
        raise RuntimeError("At least one final topic centroid has zero magnitude.")
    topic_centroids /= topic_centroid_norms
    probability_matrix = softmax(document_embeddings @ topic_centroids.T)

    terms_by_topic: dict[int, list[str]] = {}
    weighted_terms_by_topic: dict[int, list[dict[str, Any]]] = {}
    for topic in topic_ids:
        weighted_terms = topic_model.get_topic(topic) or []
        terms_by_topic[topic] = [str(term) for term, _ in weighted_terms[:12]]
        weighted_terms_by_topic[topic] = [
            {"term": str(term), "weight": round_number(weight)}
            for term, weight in weighted_terms[:12]
        ]
    topics_without_terms = [topic for topic in topic_ids if not terms_by_topic[topic]]
    if topics_without_terms:
        raise RuntimeError(f"Topic representations are empty for model topics {topics_without_terms}.")

    overrides = load_label_overrides(overrides_path, topic_ids)
    topic_names = {
        topic: overrides.get(topic, automatic_topic_name(terms_by_topic[topic]))
        for topic in topic_ids
    }
    if not overrides:
        used_names: set[str] = set()
        for topic in topic_ids:
            base_name = topic_names[topic]
            candidate = base_name
            for term in terms_by_topic[topic][3:]:
                if candidate not in used_names:
                    break
                candidate = f"{base_name} · {title_term(term)}"
            if candidate in used_names:
                candidate = f"{base_name} · Cluster {topic + 1}"
            topic_names[topic] = candidate
            used_names.add(candidate)
    if any(not name or GENERIC_LABEL.match(name) for name in topic_names.values()):
        raise RuntimeError("Generated a missing or placeholder topic name.")
    if len(set(topic_names.values())) != topic_count:
        raise RuntimeError("Generated topic names are not unique; provide --label-overrides.")

    members_by_topic: dict[int, list[int]] = defaultdict(list)
    for index, topic in enumerate(assignments):
        members_by_topic[int(topic)].append(index)

    topic_labels: list[dict[str, Any]] = []
    stable_topic_ids: dict[int, str] = {}
    for distribution_index, topic in enumerate(topic_ids):
        stable_id = f"topic-{distribution_index + 1:02d}"
        stable_topic_ids[topic] = stable_id
        member_indexes = members_by_topic[topic]
        representative_indexes = sorted(
            member_indexes,
            key=lambda index: (
                -probability_matrix[index, topic],
                node_ids[index],
            ),
        )[:8]
        topic_labels.append(
            {
                "id": stable_id,
                "modelTopic": topic,
                "distributionIndex": distribution_index,
                "name": topic_names[topic],
                "count": len(member_indexes),
                "terms": terms_by_topic[topic],
                "weightedTerms": weighted_terms_by_topic[topic],
                "representativePassages": [node_ids[index] for index in representative_indexes],
            }
        )

    output_nodes: list[dict[str, Any]] = []
    for index, node in enumerate(nodes):
        topic = int(assignments[index])
        distribution = probability_matrix[index]
        output_nodes.append(
            {
                "id": node["id"],
                "text": node["text"],
                "group": topic_names[topic],
                "topicId": stable_topic_ids[topic],
                "topicName": topic_names[topic],
                "topicProbability": round_number(distribution[topic]),
                "topicDistribution": [round_number(value) for value in distribution],
                "topicTerms": terms_by_topic[topic][:8],
                "x": round_number(coordinates[index, 0]),
                "y": round_number(coordinates[index, 1]),
            }
        )

    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    label_method = (
        "Names supplied by a complete reviewed label override file; KeyBERT-inspired terms "
        "and representative passages retained for audit"
        if overrides
        else "Draft names composed from KeyBERT-inspired topic terms"
    )
    topic_sizes = sorted((len(indexes) for indexes in members_by_topic.values()))
    silhouette = (
        float(silhouette_score(document_embeddings, assignments, metric="cosine"))
        if topic_count > 1
        else None
    )
    model_report = {
        "generatedAt": generated_at,
        "input": {
            "path": str(input_path),
            "sha256": input_sha256,
            "nodeCount": len(nodes),
            "chunkCount": chunk_count,
            "chunkTokens": args.chunk_tokens,
        },
        "runtime": {
            "pythonImplementation": platform.python_implementation(),
            "pythonVersion": platform.python_version(),
            "operatingSystem": platform.system(),
            "operatingSystemRelease": platform.release(),
            "machine": platform.machine(),
            "packages": runtime_versions,
            "determinism": {
                "seed": args.seed,
                "numericalLibraryThreads": 1,
                "torchDeterministicAlgorithms": True,
                "tokenizerParallelism": False,
            },
        },
        "model": {
            "embeddingModel": args.model,
            "embeddingModelRevision": model_revision,
            "embeddingDimensions": int(document_embeddings.shape[1]),
            "seed": args.seed,
            "umap": {
                "nNeighbors": args.umap_neighbors,
                "nComponents": 5,
                "minDist": 0.0,
                "metric": "cosine",
            },
            "hdbscan": {
                "minClusterSize": args.min_cluster_size,
                "minSamples": args.min_samples,
                "metric": "euclidean",
                "clusterSelectionMethod": "eom",
            },
            "representation": {
                "vectorizerNgramRange": [1, 2],
                "vectorizerMinimumDocumentFrequency": 3,
                "vectorizerMaximumDocumentFrequency": 0.9,
                "vectorizerDocumentUnit": "passage",
                "vectorizerVocabularySize": len(passage_vectorizer.vocabulary_),
                "classTfidfBm25Weighting": True,
                "classTfidfReduceFrequentWords": True,
                "keyBertInspired": True,
            },
            "outlierPolicy": (
                "Assign every HDBSCAN outlier to the BERTopic topic embedding with maximum "
                "cosine similarity"
            ),
            "topicAffinityDistribution": {
                "method": (
                    "Softmax-normalized cosine similarity between each normalized passage "
                    "embedding and normalized final hard-topic centroids"
                ),
                "temperature": TOPIC_AFFINITY_TEMPERATURE,
                "calibration": (
                    "Normalized semantic affinity, not a calibrated HDBSCAN membership probability"
                ),
                "assignmentSemantics": (
                    "Hard assignments come from HDBSCAN plus outlier reassignment and need not "
                    "equal the maximum affinity component"
                ),
            },
            "labelingMethod": label_method,
        },
        "quality": {
            "topicCount": topic_count,
            "originalOutlierCount": original_outlier_count,
            "finalOutlierCount": 0,
            "topicSizeMinimum": topic_sizes[0],
            "topicSizeMedian": topic_sizes[len(topic_sizes) // 2],
            "topicSizeMaximum": topic_sizes[-1],
            "cosineSilhouette": round_number(silhouette) if silhouette is not None else None,
            "placeholderLabelCount": sum(
                bool(GENERIC_LABEL.match(node["group"])) for node in output_nodes
            ),
        },
        "topics": topic_labels,
    }
    if overrides_path:
        model_report["input"]["labelOverrides"] = {
            "path": str(overrides_path),
            "sha256": sha256_file(overrides_path),
            "completeTopicCoverage": True,
        }

    write_json(output_paths["nodes.json"], output_nodes, args.force)
    write_json(output_paths["links.json"], [], args.force)
    write_json(output_paths["topic-labels.json"], topic_labels, args.force)
    write_json(output_paths["model-report.json"], model_report, args.force)

    metadata = {
        "id": dataset_id,
        "displayName": "BSB Semantic Topics · BERTopic v1",
        "description": (
            f"A transformer-based topic map of {len(output_nodes):,} Berean Study Bible passage "
            "chunks with reader-facing topic names, explicit topic assignments, and a seeded "
            "UMAP layout."
        ),
        "calculation": (
            f"Passages are split into bounded tokenizer chunks, encoded with the pinned {args.model} "
            "Sentence Transformer, combined as token-weighted normalized passage embeddings, "
            "reduced with seeded UMAP, clustered with HDBSCAN, and represented with BM25-weighted "
            "class TF-IDF plus KeyBERT-inspired terms. HDBSCAN outliers are assigned to the nearest "
            "semantic topic embedding, and topic names are stored in group and topicName."
        ),
        "methodType": "analysis-and-layout",
        "bibleVersion": "Berean Study Bible (BSB)",
        "corpusVersion": f"legacy-bsb-passage-corpus-{input_sha256[:12]}",
        "generatedAt": generated_at,
        "representation": {
            "id": "sentence-transformer-mean-chunk-embedding",
            "version": "1.0.0",
            "description": (
                "Each passage is represented by a normalized token-weighted mean of normalized "
                f"token-chunk embeddings from the pinned {args.model} checkpoint."
            ),
            "parameters": {
                "model": args.model,
                "revision": model_revision,
                "chunkTokens": args.chunk_tokens,
                "modelMaximumSequenceLength": int(sentence_model.max_seq_length),
                "embeddingDimensions": int(document_embeddings.shape[1]),
            },
        },
        "relationship": None,
        "layout": {
            "id": "umap-cosine-2d",
            "version": "1.0.0",
            "distanceMeaning": (
                "Nearby points have similar transformer embeddings in a seeded two-dimensional UMAP "
                "projection; screen distance is qualitative and is not a calibrated probability."
            ),
            "parameters": {
                "nNeighbors": args.umap_neighbors,
                "minDist": 0.08,
                "metric": "cosine",
                "seed": args.seed,
            },
        },
        "topicModel": {
            "id": "bertopic-bsb-semantic-topics",
            "version": "1.0.0",
            "embeddingModel": args.model,
            "embeddingModelRevision": model_revision,
            "clusteringAlgorithm": "UMAP plus HDBSCAN",
            "labelingMethod": label_method,
            "labelStatus": "reviewed" if overrides else "draft",
            "labelOverridesSha256": sha256_file(overrides_path) if overrides_path else None,
            "outlierPolicy": (
                "Maximum cosine similarity to a BERTopic topic embedding; no final unassigned passages"
            ),
            "seed": args.seed,
            "topicCount": topic_count,
            "topicDistributionDimensions": topic_count,
            "topicDistributionMeaning": (
                "Softmax-normalized cosine affinities to final hard-topic centroids; these values "
                "sum to one but are not calibrated HDBSCAN membership probabilities"
            ),
            "topicDistributionTemperature": TOPIC_AFFINITY_TEMPERATURE,
            "parameters": model_report["model"],
        },
        "parameters": {
            "nodeCount": len(output_nodes),
            "linkCount": 0,
            "topicCount": topic_count,
            "originalOutlierCount": original_outlier_count,
            "finalOutlierCount": 0,
        },
        "artifacts": {
            "nodesSha256": sha256_file(output_paths["nodes.json"]),
            "linksSha256": sha256_file(output_paths["links.json"]),
            "topicLabelsSha256": sha256_file(output_paths["topic-labels.json"]),
        },
        "sources": [
            "https://maartengr.github.io/BERTopic/",
            "https://www.sbert.net/",
            "https://umap-learn.readthedocs.io/en/latest/reproducibility.html",
        ],
    }
    write_json(output_paths["metadata.json"], metadata, args.force)
    print(
        f"Wrote {len(output_nodes):,} passages across {topic_count} named topics to {output_directory}"
    )
    print(json.dumps(model_report["quality"], indent=2))


if __name__ == "__main__":
    try:
        main()
    except (FileExistsError, RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
