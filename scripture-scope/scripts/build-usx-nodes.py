#!/usr/bin/env python3
"""Convert one or more USX Bible files into passage nodes for BERTopic.

The default output is one node per Scripture body paragraph. Notes,
references, headings, and other non-Bible-text paragraphs are excluded from
`text`; the nearest section heading is retained as metadata and can optionally
be prepended to the model text.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from bible_books import canonical_book_name, canonicalize_reference

GENERATOR_VERSION = "1.0.0"
SPACE_RE = re.compile(r"\s+")
VERSE_ID_RE = re.compile(r"^(?P<book>[1-3A-Z]{3})\s+(?P<chapter>\d+):(?P<verse>[0-9]+(?:[-–][0-9]+)?[a-z]?)$")
CHAPTER_ID_RE = re.compile(r"^(?P<book>[1-3A-Z]{3})\s+(?P<chapter>\d+)$")

# Paragraph styles that contain canonical Scripture text. The list is broad
# enough for prose, poetry, lists, quotations, signatures, and introductions
# used inside the biblical text, while excluding headings and cross-references.
DEFAULT_TEXT_STYLES = {
    "p", "m", "po", "pr", "cls", "pmo", "pm", "pmc", "pmr", "pi", "pi1", "pi2", "pi3",
    "mi", "nb", "pc", "ph", "ph1", "ph2", "ph3", "ph4",
    "q", "q1", "q2", "q3", "q4", "qr", "qc", "qa", "qm", "qm1", "qm2", "qm3", "qm4",
    "li", "li1", "li2", "li3", "li4", "lim", "lim1", "lim2", "lim3", "lim4",
    "lh", "lf", "d", "sp", "b", "tr", "th1", "th2", "th3", "th4", "tc1", "tc2", "tc3", "tc4",
}
HEADING_STYLES = {"s", "s1", "s2", "s3", "s4", "sr", "ms", "ms1", "ms2", "ms3", "mr"}
IGNORED_SUBTREES = {"note"}


def normalize_space(value: str) -> str:
    return SPACE_RE.sub(" ", value).strip()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_verse_id(value: str) -> tuple[str, int, str]:
    match = VERSE_ID_RE.match(value.strip())
    if not match:
        raise ValueError(f"Unsupported verse identifier: {value!r}")
    return match.group("book"), int(match.group("chapter")), match.group("verse").replace("–", "-")


def verse_sort_key(verse: str) -> tuple[int, int, str]:
    match = re.match(r"^(\d+)(?:-(\d+))?([a-z]?)$", verse)
    if not match:
        return (10**9, 10**9, verse)
    start = int(match.group(1))
    end = int(match.group(2) or start)
    return (start, end, match.group(3))


def iter_visible_text(element: ET.Element) -> Iterable[str]:
    """Yield visible Bible text while excluding notes and milestone elements."""
    if element.text:
        yield element.text
    for child in element:
        name = local_name(child.tag)
        if name not in IGNORED_SUBTREES and name not in {"verse", "chapter"}:
            yield from iter_visible_text(child)
        if child.tail:
            yield child.tail


def element_text(element: ET.Element) -> str:
    return normalize_space("".join(iter_visible_text(element)))


@dataclass
class VerseText:
    id: str
    text_parts: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return normalize_space(" ".join(self.text_parts))


@dataclass
class Passage:
    book: str
    heading: str | None
    paragraph_style: str
    verses: list[VerseText]

    @property
    def verse_ids(self) -> list[str]:
        return [verse.id for verse in self.verses]

    @property
    def text(self) -> str:
        return normalize_space(" ".join(verse.text for verse in self.verses if verse.text))


def append_text(target: VerseText | None, value: str | None) -> None:
    if target is None or not value:
        return
    normalized = normalize_space(value)
    if normalized:
        target.text_parts.append(normalized)


def parse_usx_file(path: Path, text_styles: set[str]) -> tuple[str, list[Passage], dict[str, str]]:
    tree = ET.parse(path)
    root = tree.getroot()
    if local_name(root.tag) != "usx":
        raise ValueError(f"{path}: root element must be <usx>.")

    book_element = next((child for child in root if local_name(child.tag) == "book"), None)
    if book_element is None or not book_element.get("code"):
        raise ValueError(f"{path}: missing <book code=...> element.")
    book = book_element.get("code", "").strip().upper()
    title = ""
    headings: dict[str, str] = {}
    current_heading: str | None = None
    current_verse: VerseText | None = None
    verse_map: dict[str, VerseText] = {}
    passages: list[Passage] = []

    for child in root:
        name = local_name(child.tag)
        if name == "para":
            style = child.get("style", "").strip()
            visible = element_text(child)
            if style == "h" and visible:
                title = visible
            if style in HEADING_STYLES:
                if visible:
                    current_heading = visible
                continue
            if style not in text_styles or style == "b":
                continue

            paragraph_verses: list[VerseText] = []
            paragraph_seen: set[str] = set()

            # A `vid` paragraph continues a verse opened in an earlier paragraph.
            vid = child.get("vid")
            if vid:
                current_verse = verse_map.get(vid)
                if current_verse is None:
                    current_verse = VerseText(vid)
                    verse_map[vid] = current_verse
                paragraph_verses.append(current_verse)
                paragraph_seen.add(current_verse.id)

            append_text(current_verse, child.text)
            for item in child:
                item_name = local_name(item.tag)
                if item_name == "verse":
                    sid = item.get("sid")
                    eid = item.get("eid")
                    if sid:
                        current_verse = verse_map.get(sid)
                        if current_verse is None:
                            current_verse = VerseText(sid)
                            verse_map[sid] = current_verse
                        if current_verse.id not in paragraph_seen:
                            paragraph_verses.append(current_verse)
                            paragraph_seen.add(current_verse.id)
                    if eid:
                        if current_verse is not None and current_verse.id != eid:
                            raise ValueError(
                                f"{path}: verse end {eid!r} does not match open verse {current_verse.id!r}."
                            )
                        current_verse = None
                elif item_name not in IGNORED_SUBTREES:
                    append_text(current_verse, "".join(iter_visible_text(item)))
                append_text(current_verse, item.tail)

            # Only create a passage when this paragraph contributes canonical text.
            used = [verse for verse in paragraph_verses if verse.text]
            if used:
                passages.append(Passage(book, current_heading, style, used))
                for verse in used:
                    if current_heading:
                        headings[verse.id] = current_heading

        elif name == "chapter":
            # No action is needed; verse SIDs contain the canonical chapter.
            continue

        # Collapse paragraphs that continue the same verse set.
    merged: list[Passage] = []
    merged_indexes: dict[tuple[str, ...], int] = {}

    for passage in passages:
        key = tuple(passage.verse_ids)
        existing_index = merged_indexes.get(key)

        if existing_index is not None:
            existing = merged[existing_index]
            if existing.heading is None and passage.heading:
                existing.heading = passage.heading
            continue

        merged_indexes[key] = len(merged)
        merged.append(passage)

    if not merged:
        raise ValueError(f"{path}: no Scripture text paragraphs were found.")

    return book, merged, {
        "title": title or book,
        "usxVersion": root.get("version", ""),
    }


def passage_node(passage: Passage, include_heading_in_text: bool) -> dict[str, Any]:
    refs = passage.verse_ids
    parsed = [parse_verse_id(ref) for ref in refs]
    first_book, first_chapter, first_verse = parsed[0]
    last_book, last_chapter, last_verse = parsed[-1]
    if first_book != last_book:
        raise ValueError(f"Passage crosses books: {refs}")

    if len(refs) == 1:
        node_id = refs[0]
    elif first_chapter == last_chapter:
        node_id = f"{first_book} {first_chapter}:{first_verse}-{last_verse}"
    else:
        node_id = f"{refs[0]}-{last_chapter}:{last_verse}"

    text = passage.text
    if include_heading_in_text and passage.heading:
        text = f"{passage.heading}. {text}"

    canonical_id = canonicalize_reference(node_id)
    return {
        "id": canonical_id,
        "text": text,
        "reference": canonical_id,
        "book": canonical_book_name(first_book),
        "chapterStart": first_chapter,
        "verseStart": first_verse,
        "chapterEnd": last_chapter,
        "verseEnd": last_verse,
        "verses": [canonicalize_reference(ref) for ref in refs],
        "heading": passage.heading,
        "paragraphStyle": passage.paragraph_style,
    }


def verse_nodes(passages: list[Passage], headings: dict[str, str], include_heading_in_text: bool) -> list[dict[str, Any]]:
    ordered: dict[str, VerseText] = {}
    for passage in passages:
        for verse in passage.verses:
            ordered.setdefault(verse.id, verse)
    nodes: list[dict[str, Any]] = []
    for verse_id, verse in ordered.items():
        book, chapter, number = parse_verse_id(verse_id)
        heading = headings.get(verse_id)
        text = verse.text
        if include_heading_in_text and heading:
            text = f"{heading}. {text}"
        canonical_id = canonicalize_reference(verse_id)
        nodes.append({
            "id": canonical_id,
            "text": text,
            "reference": canonical_id,
            "book": canonical_book_name(book),
            "chapterStart": chapter,
            "verseStart": number,
            "chapterEnd": chapter,
            "verseEnd": number,
            "verses": [canonical_id],
            "heading": heading,
            "paragraphStyle": None,
        })
    return nodes


def chapter_nodes(passages: list[Passage], include_heading_in_text: bool) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, int], list[VerseText]] = {}
    seen: set[str] = set()
    for passage in passages:
        for verse in passage.verses:
            if verse.id in seen:
                continue
            seen.add(verse.id)
            book, chapter, _ = parse_verse_id(verse.id)
            grouped.setdefault((book, chapter), []).append(verse)

    nodes: list[dict[str, Any]] = []
    for (book, chapter), verses in grouped.items():
        verses.sort(key=lambda v: verse_sort_key(parse_verse_id(v.id)[2]))
        verse_ids = [v.id for v in verses]
        text = normalize_space(" ".join(v.text for v in verses))
        node_id = canonicalize_reference(f"{book} {chapter}")
        nodes.append({
            "id": node_id,
            "text": text,
            "reference": node_id,
            "book": canonical_book_name(book),
            "chapterStart": chapter,
            "verseStart": parse_verse_id(verse_ids[0])[2],
            "chapterEnd": chapter,
            "verseEnd": parse_verse_id(verse_ids[-1])[2],
            "verses": [canonicalize_reference(verse_id) for verse_id in verse_ids],
            "heading": None,
            "paragraphStyle": None,
        })
    return nodes


def discover_inputs(inputs: list[str], input_dir: str | None) -> list[Path]:
    paths = [Path(value) for value in inputs]
    if input_dir:
        paths.extend(sorted(Path(input_dir).glob("*.usx")))
    unique = sorted({path.resolve() for path in paths})
    if not unique:
        raise ValueError("No USX files supplied. Use positional paths or --input-dir.")
    missing = [str(path) for path in unique if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing input file(s): " + ", ".join(missing))
    return unique


def validate_nodes(nodes: list[dict[str, Any]]) -> None:
    if not nodes:
        raise ValueError("No nodes were generated.")
    seen: set[str] = set()
    for index, node in enumerate(nodes):
        node_id = node.get("id")
        text = node.get("text")
        if not isinstance(node_id, str) or not node_id.strip():
            raise ValueError(f"Node {index} has a blank id.")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Node {node_id!r} has blank text.")
        if node_id in seen:
            raise ValueError(f"Duplicate node id: {node_id}")
        seen.add(node_id)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="*", help="USX files to convert")
    parser.add_argument("--input-dir", help="Directory containing *.usx files")
    parser.add_argument("--output", required=True, help="Destination JSON path")
    parser.add_argument("--granularity", choices=["paragraph", "verse", "chapter"], default="paragraph")
    parser.add_argument(
        "--include-heading-in-text",
        action="store_true",
        help="Prepend the nearest section heading to text used by the model",
    )
    parser.add_argument(
        "--wrapped",
        action="store_true",
        help="Write an object containing metadata and a nodes array instead of a bare array",
    )
    parser.add_argument("--force", action="store_true", help="Replace an existing output file")
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    output = Path(args.output)
    if output.exists() and not args.force:
        raise FileExistsError(f"Output already exists: {output}. Pass --force to replace it.")

    input_paths = discover_inputs(args.inputs, args.input_dir)
    all_nodes: list[dict[str, Any]] = []
    books: list[dict[str, str]] = []

    for path in input_paths:
        book, passages, info = parse_usx_file(path, DEFAULT_TEXT_STYLES)
        if args.granularity == "paragraph":
            nodes = [passage_node(p, args.include_heading_in_text) for p in passages]
        elif args.granularity == "verse":
            headings = {verse.id: passage.heading for passage in passages for verse in passage.verses if passage.heading}
            nodes = verse_nodes(passages, headings, args.include_heading_in_text)
        else:
            nodes = chapter_nodes(passages, args.include_heading_in_text)
        all_nodes.extend(nodes)
        books.append({
            "code": book,
            "name": canonical_book_name(book),
            "title": info["title"],
            "source": path.name,
            "usxVersion": info["usxVersion"],
        })

    validate_nodes(all_nodes)
    payload: Any = all_nodes
    if args.wrapped:
        payload = {
            "format": "scripture-scope-source-nodes",
            "formatVersion": "1.0",
            "generator": {"name": Path(__file__).name, "version": GENERATOR_VERSION},
            "granularity": args.granularity,
            "books": books,
            "nodes": all_nodes,
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"Wrote {len(all_nodes):,} {args.granularity} nodes from {len(input_paths)} USX file(s) to {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
