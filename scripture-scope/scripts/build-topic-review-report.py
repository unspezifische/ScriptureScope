#!/usr/bin/env python3
"""Generate a self-contained HTML review report for a BERTopic dataset.

The dataset directory must contain the files produced by
build-bertopic-dataset.py: nodes.json, topic-labels.json, and metadata.json.
model-report.json is optional but contributes model-quality statistics.

Example:
    python build-topic-review-report.py \
        --dataset-dir output/bsb-bertopic-v1 \
        --output output/bsb-topic-review.html \
        --force
"""

from __future__ import annotations

import argparse
import html
import json
import random
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset-dir",
        required=True,
        help="Directory containing nodes.json, topic-labels.json, and metadata.json",
    )
    parser.add_argument("--output", required=True, help="Destination HTML file")
    parser.add_argument(
        "--representative-count",
        type=int,
        default=8,
        help="Maximum representative passages per topic (default: 8)",
    )
    parser.add_argument(
        "--low-confidence-count",
        type=int,
        default=5,
        help="Lowest-affinity passages per topic (default: 5)",
    )
    parser.add_argument(
        "--ambiguous-count",
        type=int,
        default=5,
        help="Smallest assignment-margin passages per topic (default: 5)",
    )
    parser.add_argument(
        "--random-count",
        type=int,
        default=5,
        help="Deterministic random passages per topic (default: 5)",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="Replace an existing report")
    return parser.parse_args()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {path}: {error}") from error


def require_file(path: Path) -> None:
    if not path.is_file():
        raise ValueError(f"Required file does not exist: {path}")


def number(value: Any, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{label} must be numeric; received {value!r}")
    return float(value)


def fmt(value: float) -> str:
    return f"{value:.3f}"


def percent(value: float) -> str:
    return f"{value * 100:.1f}%"


def passage_html(node: dict[str, Any]) -> str:
    margin_class = "negative" if node["assignmentMargin"] < 0 else ""
    return f"""
      <article class="passage">
        <div class="passage-heading">
          <strong>{html.escape(node['id'])}</strong>
          <span>assigned affinity {fmt(node['assignedAffinity'])}</span>
          <span class="{margin_class}">margin {fmt(node['assignmentMargin'])}</span>
          <span>alternative: {html.escape(node['alternativeName'])} ({fmt(node['alternativeAffinity'])})</span>
        </div>
        <p>{html.escape(node['text'])}</p>
      </article>
    """


def sample_section(title: str, explanation: str, nodes: list[dict[str, Any]]) -> str:
    passages = "".join(passage_html(node) for node in nodes)
    if not passages:
        passages = '<p class="muted">No additional distinct passages were available.</p>'
    return f"""
      <section class="sample-group">
        <h4>{html.escape(title)} <span class="count">{len(nodes)}</span></h4>
        <p class="hint">{html.escape(explanation)}</p>
        {passages}
      </section>
    """


def choose_distinct(
    candidates: list[dict[str, Any]],
    count: int,
    used_ids: set[str],
) -> list[dict[str, Any]]:
    if count == 0:
        return []
    selected: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate["id"] in used_ids:
            continue
        selected.append(candidate)
        used_ids.add(candidate["id"])
        if len(selected) == count:
            break
    return selected


def make_topic_card(
    label: dict[str, Any],
    members: list[dict[str, Any]],
    nodes_by_id: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> tuple[str, dict[str, Any]]:
    if not members:
        raise ValueError(f"Topic {label['id']} has no members.")

    affinities = [node["assignedAffinity"] for node in members]
    margins = [node["assignmentMargin"] for node in members]
    negative_count = sum(margin < 0 for margin in margins)
    summary = {
        "count": len(members),
        "minimumAffinity": min(affinities),
        "medianAffinity": statistics.median(affinities),
        "maximumAffinity": max(affinities),
        "medianMargin": statistics.median(margins),
        "negativeMarginCount": negative_count,
    }

    used_ids: set[str] = set()
    representative_candidates = [
        nodes_by_id[node_id]
        for node_id in label.get("representativePassages", [])
        if node_id in nodes_by_id and nodes_by_id[node_id]["topicId"] == label["id"]
    ]
    representatives = choose_distinct(
        representative_candidates, args.representative_count, used_ids
    )

    low_confidence = choose_distinct(
        sorted(members, key=lambda node: (node["assignedAffinity"], node["id"])),
        args.low_confidence_count,
        used_ids,
    )
    ambiguous = choose_distinct(
        sorted(members, key=lambda node: (node["assignmentMargin"], node["id"])),
        args.ambiguous_count,
        used_ids,
    )

    remaining = [node for node in members if node["id"] not in used_ids]
    rng = random.Random(args.seed + int(label["modelTopic"]))
    rng.shuffle(remaining)
    random_nodes = choose_distinct(remaining, args.random_count, used_ids)

    terms = ", ".join(str(term) for term in label.get("terms", []))
    original_name = str(label["name"])
    negative_class = " attention" if negative_count else ""
    card = f"""
    <details class="topic-card{negative_class}" data-topic-id="{html.escape(str(label['id']))}"
      data-model-topic="{int(label['modelTopic'])}" data-status="unreviewed">
      <summary>
        <span class="topic-title"><code>{html.escape(str(label['id']))}</code> {html.escape(original_name)}</span>
        <span class="topic-summary">
          {len(members):,} passages · median affinity {fmt(summary['medianAffinity'])} ·
          {negative_count:,} prefer another centroid
        </span>
      </summary>
      <div class="topic-body">
        <div class="review-grid">
          <label>
            Reviewed label
            <input class="review-name" value="{html.escape(original_name, quote=True)}">
          </label>
          <label>
            Review status
            <select class="review-status">
              <option value="unreviewed">Unreviewed</option>
              <option value="approved">Approved</option>
              <option value="renamed">Renamed</option>
              <option value="merge">Merge candidate</option>
              <option value="split">Split candidate</option>
              <option value="incoherent">Incoherent</option>
            </select>
          </label>
          <label class="notes-label">
            Notes
            <textarea class="review-notes" rows="3" placeholder="Record label rationale, misplaced passages, or possible merge/split targets."></textarea>
          </label>
        </div>

        <dl class="metrics">
          <div><dt>Model topic</dt><dd>{int(label['modelTopic'])}</dd></div>
          <div><dt>Passages</dt><dd>{len(members):,}</dd></div>
          <div><dt>Affinity range</dt><dd>{fmt(summary['minimumAffinity'])}–{fmt(summary['maximumAffinity'])}</dd></div>
          <div><dt>Median affinity</dt><dd>{fmt(summary['medianAffinity'])}</dd></div>
          <div><dt>Median margin</dt><dd>{fmt(summary['medianMargin'])}</dd></div>
          <div><dt>Prefer another centroid</dt><dd>{negative_count:,} ({percent(negative_count / len(members))})</dd></div>
        </dl>
        <p class="terms"><strong>Terms:</strong> {html.escape(terms)}</p>

        {sample_section('Representative passages', 'Highest-affinity examples selected by the dataset builder.', representatives)}
        {sample_section('Low-confidence passages', 'Members with the weakest affinity to their assigned topic.', low_confidence)}
        {sample_section('Ambiguous passages', 'Members whose assigned topic has the smallest advantage over the strongest alternative. A negative margin means another centroid has higher affinity.', ambiguous)}
        {sample_section('Random passages', 'Deterministic random members used to reduce representative-sample bias.', random_nodes)}
      </div>
    </details>
    """
    return card, summary


def main() -> int:
    args = parse_arguments()
    for name in [
        "representative_count",
        "low_confidence_count",
        "ambiguous_count",
        "random_count",
    ]:
        if getattr(args, name) < 0:
            raise ValueError(f"--{name.replace('_', '-')} must be nonnegative.")

    dataset_dir = Path(args.dataset_dir).resolve()
    output_path = Path(args.output).resolve()
    nodes_path = dataset_dir / "nodes.json"
    labels_path = dataset_dir / "topic-labels.json"
    metadata_path = dataset_dir / "metadata.json"
    model_report_path = dataset_dir / "model-report.json"
    for path in [nodes_path, labels_path, metadata_path]:
        require_file(path)
    if output_path.exists() and not args.force:
        raise FileExistsError(f"Output already exists: {output_path}. Pass --force to replace it.")

    nodes = load_json(nodes_path)
    labels = load_json(labels_path)
    metadata = load_json(metadata_path)
    model_report = load_json(model_report_path) if model_report_path.is_file() else {}
    if not isinstance(nodes, list) or not isinstance(labels, list) or not isinstance(metadata, dict):
        raise ValueError("Unexpected dataset JSON structure.")

    labels_by_id: dict[str, dict[str, Any]] = {}
    labels_by_distribution: dict[int, dict[str, Any]] = {}
    for label in labels:
        if not isinstance(label, dict):
            raise ValueError("Every topic-labels.json entry must be an object.")
        topic_id = str(label.get("id", ""))
        if not topic_id or topic_id in labels_by_id:
            raise ValueError(f"Missing or duplicate topic label id: {topic_id!r}")
        distribution_index = label.get("distributionIndex")
        if not isinstance(distribution_index, int) or distribution_index < 0:
            raise ValueError(f"Topic {topic_id} has an invalid distributionIndex.")
        if distribution_index in labels_by_distribution:
            raise ValueError(f"Duplicate distributionIndex: {distribution_index}")
        if not isinstance(label.get("modelTopic"), int):
            raise ValueError(f"Topic {topic_id} has an invalid modelTopic.")
        labels_by_id[topic_id] = label
        labels_by_distribution[distribution_index] = label

    distribution_count = len(labels_by_distribution)
    expected_indexes = set(range(distribution_count))
    if set(labels_by_distribution) != expected_indexes:
        raise ValueError("Topic distribution indexes must be contiguous and zero-based.")

    nodes_by_id: dict[str, dict[str, Any]] = {}
    members_by_topic: dict[str, list[dict[str, Any]]] = {
        topic_id: [] for topic_id in labels_by_id
    }
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError(f"Node {index} must be an object.")
        node_id = str(node.get("id", ""))
        topic_id = str(node.get("topicId", ""))
        text = node.get("text")
        distribution = node.get("topicDistribution")
        if not node_id or node_id in nodes_by_id:
            raise ValueError(f"Missing or duplicate node id at index {index}: {node_id!r}")
        if topic_id not in labels_by_id:
            raise ValueError(f"Node {node_id} references unknown topic {topic_id!r}.")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Node {node_id} has blank text.")
        if not isinstance(distribution, list) or len(distribution) != distribution_count:
            raise ValueError(
                f"Node {node_id} topicDistribution must contain {distribution_count} values."
            )
        distribution_values = [
            number(value, f"Node {node_id} topicDistribution") for value in distribution
        ]
        assigned_index = int(labels_by_id[topic_id]["distributionIndex"])
        assigned_affinity = distribution_values[assigned_index]
        alternative_index = max(
            (candidate for candidate in range(distribution_count) if candidate != assigned_index),
            key=distribution_values.__getitem__,
        )
        alternative_affinity = distribution_values[alternative_index]
        alternative_label = labels_by_distribution[alternative_index]
        enriched = dict(node)
        enriched.update(
            {
                "assignedAffinity": assigned_affinity,
                "alternativeAffinity": alternative_affinity,
                "assignmentMargin": assigned_affinity - alternative_affinity,
                "alternativeTopicId": alternative_label["id"],
                "alternativeName": str(alternative_label["name"]),
            }
        )
        nodes_by_id[node_id] = enriched
        members_by_topic[topic_id].append(enriched)

    topic_cards: list[str] = []
    topic_summaries: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for label in sorted(labels, key=lambda item: int(item["distributionIndex"])):
        card, summary = make_topic_card(
            label,
            members_by_topic[str(label["id"])],
            nodes_by_id,
            args,
        )
        topic_cards.append(card)
        topic_summaries.append((label, summary))

    quality = model_report.get("quality", {}) if isinstance(model_report, dict) else {}
    parameters = metadata.get("parameters", {}) if isinstance(metadata, dict) else {}
    topic_model = metadata.get("topicModel", {}) if isinstance(metadata, dict) else {}
    dataset_id = str(metadata.get("id", dataset_dir.name))
    display_name = str(metadata.get("displayName", dataset_id))
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    negative_total = sum(summary["negativeMarginCount"] for _, summary in topic_summaries)

    minimum_affinity = min(summary["medianAffinity"] for _, summary in topic_summaries)
    maximum_affinity = max(summary["medianAffinity"] for _, summary in topic_summaries)
    minimum_margin = min(summary["medianMargin"] for _, summary in topic_summaries)
    maximum_margin = max(summary["medianMargin"] for _, summary in topic_summaries)
    minimum_prefer_ratio = min(
        summary["negativeMarginCount"] / summary["count"] for _, summary in topic_summaries
    )
    maximum_prefer_ratio = max(
        summary["negativeMarginCount"] / summary["count"] for _, summary in topic_summaries
    )

    def extreme_class(value: float, minimum: float, maximum: float, higher_is_better: bool) -> str:
        if value == minimum:
            return "best" if not higher_is_better else "worst"
        if value == maximum:
            return "best" if higher_is_better else "worst"
        return ""

    rows = "".join(
        f"""
        <tr data-topic-id="{html.escape(str(label['id']))}"
            data-topic-name="{html.escape(str(label['name']), quote=True)}"
            data-count="{summary['count']}"
            data-median-affinity="{summary['medianAffinity']}"
            data-median-margin="{summary['medianMargin']}"
            data-prefer-ratio="{summary['negativeMarginCount'] / summary['count']}">
          <td><a href="#" data-open-topic="{html.escape(str(label['id']))}">{html.escape(str(label['id']))}</a></td>
          <td>{html.escape(str(label['name']))}</td>
          <td>{summary['count']:,}</td>
          <td class="{extreme_class(summary['medianAffinity'], minimum_affinity, maximum_affinity, True)}">{fmt(summary['medianAffinity'])}</td>
          <td class="{extreme_class(summary['medianMargin'], minimum_margin, maximum_margin, True)}">{fmt(summary['medianMargin'])}</td>
          <td class="{extreme_class(summary['negativeMarginCount'] / summary['count'], minimum_prefer_ratio, maximum_prefer_ratio, False)}">{summary['negativeMarginCount']:,} ({percent(summary['negativeMarginCount'] / summary['count'])})</td>
        </tr>
        """
        for label, summary in topic_summaries
    )

    storage_key = json.dumps(
        f"topic-review:{dataset_id}:{topic_model.get('version', 'unknown')}"
    ).replace("<", "\\u003c")
    report = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(display_name)} — Topic Review</title>
  <style>
    :root {{ color-scheme: light dark; --accent: #5b7cfa; --danger: #c44536; --border: color-mix(in srgb, CanvasText 18%, transparent); }}
    * {{ box-sizing: border-box; }}
    body {{ max-width: 1200px; margin: 0 auto; padding: 2rem; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }}
    h1, h2, h3, h4 {{ line-height: 1.2; }}
    code {{ font-size: .9em; }}
    button, input, select, textarea {{ font: inherit; }}
    button {{ cursor: pointer; padding: .55rem .8rem; border: 1px solid var(--border); border-radius: .4rem; background: ButtonFace; color: ButtonText; }}
    input, select, textarea {{ width: 100%; padding: .55rem; border: 1px solid var(--border); border-radius: .35rem; background: Field; color: FieldText; }}
    textarea {{ resize: vertical; }}
    .lede, .hint, .muted {{ color: color-mix(in srgb, CanvasText 68%, transparent); }}
    .dashboard {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin: 1.2rem 0; }}
    .stat {{ padding: 1rem; border: 1px solid var(--border); border-radius: .5rem; }}
    .stat strong {{ display: block; font-size: 1.4rem; }}
    .toolbar {{ position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: .5rem; padding: .75rem 0; background: Canvas; }}
    .toolbar input {{ flex: 1 1 280px; }}
    .progress {{ margin-left: auto; align-self: center; font-weight: 600; }}
    .table-wrap {{ overflow-x: auto; }}
    table {{ width: 100%; border-collapse: collapse; margin: 1rem 0 2rem; }}
    th, td {{ padding: .55rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }}
    th {{ position: sticky; top: 3.7rem; background: Canvas; }}
    .sort-button {{ display: inline-flex; align-items: center; gap: .3rem; padding: 0; border: 0; background: transparent; color: inherit; font-weight: 700; }}
    .sort-indicator {{ min-width: 1em; color: color-mix(in srgb, CanvasText 55%, transparent); }}
    td.best {{ color: #208044; font-weight: 750; }}
    td.worst {{ color: var(--danger); font-weight: 750; }}
    .topic-card {{ margin: .8rem 0; border: 1px solid var(--border); border-radius: .55rem; overflow: clip; }}
    .topic-card[data-status="approved"], .topic-card[data-status="renamed"] {{ border-left: 5px solid #2e8b57; }}
    .topic-card[data-status="merge"], .topic-card[data-status="split"], .topic-card[data-status="incoherent"] {{ border-left: 5px solid var(--danger); }}
    .topic-card summary {{ cursor: pointer; padding: .9rem 1rem; display: flex; gap: 1rem; justify-content: space-between; background: color-mix(in srgb, CanvasText 5%, Canvas); }}
    .topic-title {{ font-weight: 700; }}
    .topic-summary {{ text-align: right; color: color-mix(in srgb, CanvasText 68%, transparent); }}
    .topic-body {{ padding: 1rem; }}
    .review-grid {{ display: grid; grid-template-columns: 2fr 1fr; gap: .8rem; }}
    .review-grid label {{ font-weight: 650; }}
    .notes-label {{ grid-column: 1 / -1; }}
    .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: .5rem; margin: 1rem 0; }}
    .metrics div {{ padding: .6rem; border: 1px solid var(--border); border-radius: .35rem; }}
    .metrics dt {{ font-size: .82rem; color: color-mix(in srgb, CanvasText 65%, transparent); }}
    .metrics dd {{ margin: .15rem 0 0; font-weight: 700; }}
    .terms {{ overflow-wrap: anywhere; }}
    .sample-group {{ margin-top: 1.4rem; }}
    .sample-group h4 {{ margin-bottom: .2rem; }}
    .count {{ display: inline-block; min-width: 1.6rem; padding: .05rem .4rem; border-radius: 1rem; text-align: center; background: color-mix(in srgb, var(--accent) 18%, Canvas); font-size: .8rem; }}
    .passage {{ margin: .65rem 0; padding: .8rem; border-left: 3px solid var(--accent); background: color-mix(in srgb, CanvasText 4%, Canvas); }}
    .passage p {{ margin: .45rem 0 0; }}
    .passage-heading {{ display: flex; flex-wrap: wrap; gap: .35rem .85rem; font-size: .84rem; color: color-mix(in srgb, CanvasText 70%, transparent); }}
    .passage-heading strong {{ color: CanvasText; }}
    .negative {{ color: var(--danger); font-weight: 700; }}
    [hidden] {{ display: none !important; }}
    @media (max-width: 720px) {{
      body {{ padding: 1rem; }}
      .review-grid {{ grid-template-columns: 1fr; }}
      .notes-label {{ grid-column: auto; }}
      .topic-card summary {{ display: block; }}
      .topic-summary {{ display: block; margin-top: .3rem; text-align: left; }}
    }}
    @media print {{ .toolbar, .review-grid {{ display: none; }} .topic-card {{ break-inside: avoid; }} }}
  </style>
</head>
<body>
  <header>
    <p class="muted">Generated {html.escape(generated_at)}</p>
    <h1>{html.escape(display_name)} — Topic Review</h1>
    <p class="lede">Review labels against representative, low-confidence, ambiguous, and random passages. A negative assignment margin means a passage has greater affinity to another topic centroid than to its assigned hard cluster.</p>
  </header>

  <section class="dashboard">
    <div class="stat"><strong>{len(nodes):,}</strong>passages</div>
    <div class="stat"><strong>{len(labels):,}</strong>topics</div>
    <div class="stat"><strong>{int(parameters.get('originalOutlierCount', 0)):,}</strong>original outliers</div>
    <div class="stat"><strong>{negative_total:,}</strong>prefer another centroid</div>
    <div class="stat"><strong>{html.escape(str(quality.get('cosineSilhouette', 'n/a')))}</strong>cosine silhouette</div>
    <div class="stat"><strong>{html.escape(str(topic_model.get('labelStatus', 'unknown')))}</strong>input label status</div>
  </section>

  <div class="toolbar">
    <input id="search" type="search" placeholder="Search labels, terms, references, or passage text">
    <button id="expand-all" type="button">Expand visible</button>
    <button id="collapse-all" type="button">Collapse all</button>
    <button id="export-labels" type="button">Export label overrides</button>
    <button id="export-review" type="button">Export review notes</button>
    <span class="progress" id="progress"></span>
  </div>

  <section>
    <h2>Topic overview</h2>
    <div class="table-wrap">
      <table id="topic-overview-table">
        <thead><tr>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="topicId" data-sort-type="text">ID <span class="sort-indicator">↕</span></button></th>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="topicName" data-sort-type="text">Current label <span class="sort-indicator">↕</span></button></th>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="count" data-sort-type="number">Count <span class="sort-indicator">↕</span></button></th>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="medianAffinity" data-sort-type="number">Median affinity <span class="sort-indicator">↕</span></button></th>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="medianMargin" data-sort-type="number">Median margin <span class="sort-indicator">↕</span></button></th>
          <th aria-sort="none"><button class="sort-button" type="button" data-sort-key="preferRatio" data-sort-type="number">Prefer another centroid <span class="sort-indicator">↕</span></button></th>
        </tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  </section>

  <main id="topics">
    <h2>Topic review cards</h2>
    {''.join(topic_cards)}
  </main>

  <script>
    const storageKey = {storage_key};
    const cards = [...document.querySelectorAll('.topic-card')];
    const search = document.querySelector('#search');

    function readState() {{
      try {{ return JSON.parse(localStorage.getItem(storageKey) || '{{}}'); }}
      catch (_) {{ return {{}}; }}
    }}

    function writeState() {{
      const state = {{}};
      for (const card of cards) {{
        state[card.dataset.topicId] = {{
          name: card.querySelector('.review-name').value.trim(),
          status: card.querySelector('.review-status').value,
          notes: card.querySelector('.review-notes').value.trim()
        }};
      }}
      try {{ localStorage.setItem(storageKey, JSON.stringify(state)); }} catch (_) {{}}
      updateProgress();
    }}

    function restoreState() {{
      const state = readState();
      for (const card of cards) {{
        const saved = state[card.dataset.topicId];
        if (!saved) continue;
        if (typeof saved.name === 'string') card.querySelector('.review-name').value = saved.name;
        if (typeof saved.status === 'string') card.querySelector('.review-status').value = saved.status;
        if (typeof saved.notes === 'string') card.querySelector('.review-notes').value = saved.notes;
        card.dataset.status = card.querySelector('.review-status').value;
      }}
      updateProgress();
    }}

    function updateProgress() {{
      const reviewed = cards.filter(card => card.querySelector('.review-status').value !== 'unreviewed').length;
      document.querySelector('#progress').textContent = `${{reviewed}} / ${{cards.length}} reviewed`;
    }}

    function applySearch() {{
      const query = search.value.trim().toLowerCase();
      for (const card of cards) card.hidden = query && !card.textContent.toLowerCase().includes(query);
    }}

    function installTableSorting() {{
      const table = document.querySelector('#topic-overview-table');
      const body = table.querySelector('tbody');
      const buttons = [...table.querySelectorAll('.sort-button')];
      let activeKey = null;
      let direction = 1;

      for (const button of buttons) button.addEventListener('click', () => {{
        const key = button.dataset.sortKey;
        const type = button.dataset.sortType;
        direction = activeKey === key ? -direction : 1;
        activeKey = key;

        const rows = [...body.querySelectorAll('tr')];
        rows.sort((first, second) => {{
          const firstValue = first.dataset[key];
          const secondValue = second.dataset[key];
          const comparison = type === 'number'
            ? Number(firstValue) - Number(secondValue)
            : firstValue.localeCompare(secondValue, undefined, {{numeric: true, sensitivity: 'base'}});
          return comparison * direction;
        }});
        rows.forEach(row => body.appendChild(row));

        for (const candidate of buttons) {{
          const selected = candidate === button;
          candidate.querySelector('.sort-indicator').textContent = selected
            ? (direction === 1 ? '↑' : '↓')
            : '↕';
          candidate.closest('th').setAttribute(
            'aria-sort', selected ? (direction === 1 ? 'ascending' : 'descending') : 'none'
          );
        }}
      }});
    }}

    function download(filename, value) {{
      const blob = new Blob([JSON.stringify(value, null, 2) + '\\n'], {{type: 'application/json'}});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }}

    for (const card of cards) {{
      card.querySelectorAll('input, select, textarea').forEach(element => {{
        element.addEventListener('input', () => {{
          card.dataset.status = card.querySelector('.review-status').value;
          writeState();
        }});
        element.addEventListener('change', () => {{
          card.dataset.status = card.querySelector('.review-status').value;
          writeState();
        }});
      }});
    }}

    search.addEventListener('input', applySearch);
    document.querySelector('#expand-all').addEventListener('click', () => cards.filter(card => !card.hidden).forEach(card => card.open = true));
    document.querySelector('#collapse-all').addEventListener('click', () => cards.forEach(card => card.open = false));
    document.querySelectorAll('[data-open-topic]').forEach(link => link.addEventListener('click', event => {{
      event.preventDefault();
      const card = cards.find(item => item.dataset.topicId === link.dataset.openTopic);
      if (card) {{ card.hidden = false; card.open = true; card.scrollIntoView({{behavior: 'smooth'}}); }}
    }}));

    document.querySelector('#export-labels').addEventListener('click', () => {{
      const labels = {{}};
      cards.sort((a, b) => Number(a.dataset.modelTopic) - Number(b.dataset.modelTopic)).forEach(card => {{
        labels[card.dataset.modelTopic] = card.querySelector('.review-name').value.trim();
      }});
      download('label-overrides.json', labels);
    }});

    document.querySelector('#export-review').addEventListener('click', () => {{
      const review = {{
        datasetId: {json.dumps(dataset_id).replace('<', '\\u003c')},
        exportedAt: new Date().toISOString(),
        topics: cards.map(card => ({{
          topicId: card.dataset.topicId,
          modelTopic: Number(card.dataset.modelTopic),
          proposedLabel: card.querySelector('.review-name').value.trim(),
          status: card.querySelector('.review-status').value,
          notes: card.querySelector('.review-notes').value.trim()
        }}))
      }};
      download('topic-review.json', review);
    }});

    installTableSorting();
    restoreState();
  </script>
</body>
</html>
"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f"{output_path.name}.tmp")
    temporary.write_text(report, encoding="utf-8")
    temporary.replace(output_path)
    print(
        f"Wrote review report for {len(nodes):,} passages across {len(labels):,} topics "
        f"to {output_path}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileExistsError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
