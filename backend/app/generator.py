"""Turns a search query into a lesson: name the topic, research it, write it.

Three model calls, through whichever provider is configured (app/providers):
1. name_topic   - canonical title + slug, so different phrasings share one lesson
2. research     - web-grounded notes and sources
3. write_lesson - the lesson JSON, validated and repaired if needed
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from .coverage import check_coverage
from .expr_check import find_expression_errors
from .lesson_schema import Lesson
from . import search
from .providers import GenerationError, MissingCredentials, ProviderUnavailable, Turn, get_provider
from .slugs import slugify

log = logging.getLogger(__name__)

PROMPTS = Path(__file__).parent / "prompts"
MAX_REPAIRS = 2

Progress = Callable[[str], Awaitable[None]]

__all__ = ["GenerationError", "MissingCredentials", "ProviderUnavailable", "name_topic", "research", "write_lesson"]


# ---------- 1. naming ----------


class TopicName(BaseModel):
    learnable: bool = Field(description="False if this isn't a topic someone could learn about (gibberish, a request for something else).")
    title: str = Field(description="Canonical topic title in Title Case, 2-6 words, e.g. 'Mushroom Life Cycle'.")
    slug: str = Field(description="Lowercase hyphenated id for the canonical topic, e.g. 'mushroom-life-cycle'.")


NAMING_SYSTEM = (
    "You map a learner's search to the canonical name of the topic they want explained, "
    "so that different phrasings of the same topic get the same slug. Prefer the common "
    "textbook name of the concept ('how do mushrooms make babies' -> 'Mushroom Life Cycle', "
    "slug 'mushroom-life-cycle'). Keep scope as broad as the question, no broader."
)


async def name_topic(query: str) -> TopicName:
    result = await get_provider().structured(NAMING_SYSTEM, f"Search: {query}", TopicName)
    assert isinstance(result, TopicName)
    result.slug = slugify(result.slug) or slugify(result.title)
    return result


# ---------- 2. research ----------

RESEARCH_SYSTEM = """You research topics for an interactive lesson that will be generated from your notes.
Search the web and use the most reliable sources (textbooks, universities, government agencies, review articles, reputable encyclopedias). Then write research notes covering:

1. The core story of the topic as an ordered sequence of 4-6 stages or ideas, each with the mechanism (what physically happens and why).
2. Key terms with one-sentence definitions.
3. Real quantities, ranges, thresholds and optimal conditions that a slider simulation could be built on (with units and which source says so).
4. Any compatibility rules, pairings or classifications that a drag-and-match activity could use.
5. Any ordered process with distinct steps a learner could perform.
6. Common misconceptions, and good quiz questions that test understanding.
7. What the key objects look like (shapes, colors, relative sizes), so they can be drawn simply.

Be concrete and accurate; mark anything uncertain. End with a list of the sources you relied on as "- Title: URL"."""


async def research(title: str, query: str, progress: Progress) -> tuple[str, list[dict[str, str]]]:
    provider = get_provider()
    prompt = f"Topic: {title}\nThe learner searched for: {query}\n\n"

    # Preferred: Tavily search results, summarized by the model.
    if search.enabled():
        await progress("Searching the web for reliable sources…")
        try:
            pages = await search.search_topic(title, query)
        except search.SearchUnavailable as e:
            log.warning("Tavily search failed, falling back: %s", e)
            pages = []
        if pages:
            await progress(f"Found {len(pages)} sources. Taking notes…")
            excerpts = "\n\n".join(
                f'<source index="{i + 1}" title="{p["title"]}" url="{p["url"]}">\n{p["content"]}\n</source>'
                for i, p in enumerate(pages)
            )
            notes = await provider.complete(
                RESEARCH_SYSTEM.replace("Search the web and use", "Using only the search results provided, prefer"),
                prompt + f"<search_results>\n{excerpts}\n</search_results>\n\nWrite the research notes from these results.",
            )
            if notes:
                return notes, [{"title": p["title"], "url": p["url"]} for p in pages]

    # Fallback: the provider's own search (Google Search grounding on Gemini, web search on Claude).
    await progress("Researching the topic…")
    notes, sources = await provider.research(RESEARCH_SYSTEM, prompt + "Research this topic for the lesson.")
    if not notes:
        raise GenerationError("Research came back empty. Please try again.")
    return notes, sources


# ---------- 3. writing ----------


def _writer_system() -> str:
    spec = (PROMPTS / "lesson_format.md").read_text(encoding="utf-8")
    example = (PROMPTS / "example_lesson.json").read_text(encoding="utf-8")
    return (
        "You write interactive lessons as JSON for a web lesson player.\n\n"
        f"{spec}\n\n"
        "## Example\n\nA complete valid lesson on a different topic, showing every step kind except match. "
        "Match its quality and level of visual detail, but design scenes for your own topic.\n\n"
        f"```json\n{example}\n```\n\n"
        "Reply with the lesson JSON object only: no prose, no code fences."
    )


def _extract_json(text: str) -> dict:
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object found in the reply")
    return json.loads(text[start : end + 1])


def _problems(raw: dict) -> list[str]:
    problems: list[str] = []
    try:
        Lesson.model_validate(raw)
    except ValidationError as e:
        for err in e.errors()[:25]:
            loc = ".".join(str(p) for p in err["loc"])
            problems.append(f"{loc}: {err['msg']}")
    problems.extend(find_expression_errors(raw))
    problems.extend(_label_problems(raw))
    problems.extend(_shape_problems(raw))
    return problems


INTRO_ID = "intro"


def _shape_problems(raw: dict) -> list[str]:
    """New lessons open with a short "What you'll learn" chapter."""
    steps = raw.get("steps") or []
    first = steps[0] if steps and isinstance(steps[0], dict) else {}
    if first.get("kind") != "video" or first.get("id") != INTRO_ID:
        return ["steps.0 must be the intro: a video step with id \"intro\" and title \"What you'll learn\" that previews the lesson."]
    out = []
    if not 2 <= len(first.get("narration") or []) <= 4:
        out.append("steps.0 (intro): use 2 to 4 short narration sentences (about 15-25 seconds).")
    if (first.get("scene") or {}).get("duration", 0) > 25:
        out.append("steps.0 (intro): keep scene.duration at 25 seconds or less.")
    return out


def _count_labels(elements) -> int:
    n = 0
    for el in elements if isinstance(elements, list) else []:
        if isinstance(el, dict):
            if el.get("type") in ("label", "callout"):
                n += 1
            n += _count_labels(el.get("children"))
    return n


def _label_problems(raw: dict) -> list[str]:
    """Unlabeled scenes and long token labels are hard to follow; ask for fixes like a reviewer would."""
    out = []
    for i, step in enumerate(raw.get("steps") or []):
        if isinstance(step, dict) and step.get("kind") == "match":
            for t in step.get("tokens") or []:
                if isinstance(t, dict) and len(str(t.get("label", ""))) > 28:
                    out.append(f"steps.{i}.tokens.{t.get('id')}: label {t.get('label')!r} is too long; keep it under 24 characters.")
        if isinstance(step, dict) and step.get("kind") == "video":
            need = max(3, len(step.get("narration") or []))
            have = _count_labels((step.get("scene") or {}).get("elements"))
            if have < need:
                out.append(f"steps.{i} ({step.get('id')}): only {have} labels/callouts for {need} narration sentences. "
                           "Name each object the narration mentions with a callout, and label what is happening.")
    return out


async def write_lesson(title: str, query: str, notes: str, sources: list[dict[str, str]], progress: Progress) -> dict:
    provider = get_provider()
    system = _writer_system()
    source_list = "\n".join(f"- {s['title']}: {s['url']}" for s in sources[:30]) or "(none captured)"
    turns = [Turn("user", (
        f"Topic: {title}\nThe learner searched for: {query}\n\n"
        f"<research_notes>\n{notes}\n</research_notes>\n\n"
        f"<source_urls>\n{source_list}\n</source_urls>\n\n"
        "Write the lesson."
    ))]

    for attempt in range(MAX_REPAIRS + 1):
        reply = await provider.write(system, turns)
        try:
            if reply.truncated:
                raise ValueError("the reply was cut off at the length limit; make the lesson more compact")
            raw = _extract_json(reply.text)
            problems = _problems(raw)
        except ValueError as e:  # includes json.JSONDecodeError
            raw, problems = None, [f"could not parse the JSON: {e}"]

        if not problems and raw is not None:
            # Quizzes and activities may only test what earlier chapters taught.
            await progress("Checking quizzes and activities against the chapters…")
            try:
                raw, problems = await check_coverage(raw)
            except Exception as e:  # a failed review shouldn't sink an otherwise good lesson
                log.warning("coverage check failed for %r: %s", title, e)
                problems = []
            if not problems:
                return raw

        log.warning("lesson attempt %d for %r had %d problems: %s", attempt + 1, title, len(problems), problems[:5])
        if attempt == MAX_REPAIRS:
            break
        await progress(f"Fixing {len(problems)} problem{'s' if len(problems) != 1 else ''} in the draft…")
        turns += [
            Turn("assistant", reply.text),
            Turn("user", "The lesson failed validation:\n" + "\n".join(f"- {p}" for p in problems)
                 + "\n\nReply with the complete corrected lesson JSON object only."),
        ]

    raise GenerationError("The generated lesson didn't pass checks. Please try again.")
