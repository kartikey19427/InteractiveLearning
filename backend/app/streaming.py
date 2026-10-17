"""Lessons built like a stream: an outline first, then chapters one at a time, in order.

The learner can start as soon as the intro is ready while later chapters are
written ahead of them. Each chapter is written knowing everything before it,
validated on its own, and (for activities and quizzes) checked against the
chapters already written, so checks only test what was taught.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from .coverage import CoverageReport, SYSTEM as COVERAGE_SYSTEM, apply_report, outline as coverage_outline
from .expr_check import find_expression_errors
from .generator import INTRO_ID, MAX_REPAIRS, _extract_json, _label_problems, _shape_problems, _writer_system
from .lesson_schema import Lesson, Source, Step
from .providers import GenerationError, ProviderUnavailable, Turn, get_provider

log = logging.getLogger(__name__)

StepAdapter: TypeAdapter = TypeAdapter(Step)
StepKind = Literal["video", "simulation", "match", "process", "quiz"]


class OutlineStep(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$", max_length=40)
    kind: StepKind
    title: str
    tag: str
    brief: str = Field(description="What this chapter teaches, or for an activity/quiz what it tests (1-2 sentences).")


class Outline(BaseModel):
    title: str
    eyebrow: str
    summary: str
    palette: dict[str, str] = {}
    steps: list[OutlineStep] = Field(min_length=4, max_length=16)
    sources: list[Source]
    note: str | None = None


def outline_problems(o: Outline) -> list[str]:
    out = []
    if o.steps[0].kind != "video" or o.steps[0].id != INTRO_ID:
        out.append('steps[0] must be the intro: kind "video", id "intro", title "What you\'ll learn".')
    if o.steps[-1].kind != "quiz":
        out.append("the last step must be the quiz.")
    ids = [s.id for s in o.steps]
    if len(ids) != len(set(ids)):
        out.append("step ids must be unique.")
    for i, s in enumerate(o.steps[1:], 1):
        if s.kind != "video" and not any(p.kind == "video" and p.id != INTRO_ID for p in o.steps[:i]):
            out.append(f"{s.id}: an activity or quiz must come after at least one teaching chapter.")
    return out


OUTLINE_TASK = (
    "First write only the lesson OUTLINE (chapters are written one at a time afterwards). Follow the "
    "lesson shape rules above. Reply with JSON only:\n"
    '{"title", "eyebrow", "summary", "palette": {name: "#hex"}, '
    '"steps": [{"id", "kind": "video|simulation|match|process|quiz", "title", "tag", "brief"}], '
    '"sources": [{"title", "url"}], "note"}\n'
    "`brief` says what a video chapter teaches, or what an activity or quiz tests; an activity or quiz may "
    "only test what earlier chapters' briefs teach. Put every color the chapters will share in the palette."
)


async def write_outline(title: str, query: str, notes: str, sources: list[dict[str, str]]) -> Outline:
    provider = get_provider()
    system = _writer_system()
    source_list = "\n".join(f"- {s['title']}: {s['url']}" for s in sources[:30]) or "(none captured)"
    turns = [Turn("user", (
        f"Topic: {title}\nThe learner searched for: {query}\n\n<research_notes>\n{notes}\n</research_notes>\n\n"
        f"<source_urls>\n{source_list}\n</source_urls>\n\n{OUTLINE_TASK}"
    ))]
    for attempt in range(MAX_REPAIRS + 1):
        reply = await provider.write(system, turns)
        try:
            o = Outline.model_validate(_extract_json(reply.text))
            problems = outline_problems(o)
        except (ValueError, ValidationError) as e:
            o, problems = None, [f"invalid outline: {str(e)[:500]}"]
        if not problems and o is not None:
            return o
        log.warning("outline attempt %d for %r: %s", attempt + 1, title, problems[:3])
        turns += [Turn("assistant", reply.text), Turn("user", "Fix these and reply with the whole outline JSON only:\n- " + "\n- ".join(problems))]
    raise GenerationError("Couldn't plan this lesson. Please try again.")


def _earlier(steps: list[dict]) -> str:
    """What came before, compactly: what each chapter taught and what each check covered."""
    return coverage_outline({"steps": steps}) or "(this is the first chapter)"


def step_problems(step: dict, index: int, planned: OutlineStep, functions: dict) -> list[str]:
    problems: list[str] = []
    try:
        StepAdapter.validate_python(step)
    except ValidationError as e:
        for err in e.errors()[:20]:
            problems.append(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}")
    if step.get("id") != planned.id or step.get("kind") != planned.kind:
        problems.append(f'the step must have id "{planned.id}" and kind "{planned.kind}" as planned.')
    problems.extend(find_expression_errors({"steps": [step], "functions": functions}))
    problems.extend(p.replace("steps.0", f"steps.{index}") for p in _label_problems({"steps": [step]}))
    if index == 0:
        problems.extend(_shape_problems({"steps": [step]}))
    return problems


CHUNK = 3  # chapters written per Gemini call


def chunk_task(title: str, notes: str, o: Outline, idxs: list[int], earlier: list[dict], functions: dict) -> str:
    plan = json.dumps([s.model_dump() for s in o.steps], ensure_ascii=False)
    chapters = "\n".join(
        f'- step {i + 1}: id "{o.steps[i].id}", kind "{o.steps[i].kind}", title "{o.steps[i].title}". Brief: {o.steps[i].brief}'
        for i in idxs
    )
    return (
        f"Topic: {title}\n\n<research_notes>\n{notes}\n</research_notes>\n\n"
        f"<outline>\n{plan}\n</outline>\n<palette>{json.dumps(o.palette)}</palette>\n"
        f"<helper_functions_so_far>{json.dumps(functions)}</helper_functions_so_far>\n\n"
        f"<earlier_chapters>\n{_earlier(earlier)}\n</earlier_chapters>\n\n"
        f"Now write these {len(idxs)} chapters, in order:\n{chapters}\n"
        "Each follows the format and clarity rules, uses palette names from the outline, and if it is an activity or quiz, "
        "tests only what the earlier chapters (including the ones above it in this list) taught. "
        'Reply with JSON only: {"steps": [ ...one step per chapter above, in order... ], "functions": { ...only NEW helper functions, or {} }}'
    )


def _parse_steps(text: str, expected: int) -> tuple[list[dict], dict]:
    data = _extract_json(text)
    steps, fns = data.get("steps"), data.get("functions") or {}
    if not isinstance(steps, list) or not isinstance(fns, dict):
        raise ValueError('reply must be {"steps": [...], "functions": {...}}')
    if len(steps) < expected:
        steps = steps + [None] * (expected - len(steps))
    return [st if isinstance(st, dict) else {} for st in steps[:expected]], fns


async def _check_chunk(earlier: list[dict], chunk: list[dict], chunk_ids: set[str]) -> dict[str, str]:
    """Quizzes and activities in this chunk may only test what came before. Returns problems by step id."""
    if not any(st.get("kind") != "video" for st in chunk):
        return {}
    lesson = {"steps": [*earlier, *chunk]}
    try:
        report = await get_provider().structured(COVERAGE_SYSTEM, coverage_outline(lesson), CoverageReport)
    except ProviderUnavailable:
        return {}  # rate limited: keep the chunk rather than stall the stream
    assert isinstance(report, CoverageReport)
    report.verdicts = [v for v in report.verdicts if v.step_id in chunk_ids]
    _, problems = apply_report(lesson, report)
    out: dict[str, str] = {}
    for p in problems:
        sid = p.split(":", 1)[0]
        out[sid] = out.get(sid, "") + p + " "
    return out


async def write_chunk(title: str, notes: str, o: Outline, idxs: list[int], earlier: list[dict], functions: dict) -> tuple[list[dict], dict]:
    """Write several chapters in one Gemini call. Each is validated on its own; only broken ones are sent back."""
    provider = get_provider()
    turns = [Turn("user", chunk_task(title, notes, o, idxs, earlier, functions))]
    done: dict[int, dict] = {}
    new_fns: dict = {}
    todo = list(idxs)
    for attempt in range(MAX_REPAIRS + 1):
        reply = await provider.write(_writer_system(), turns)
        problems: dict[int, list[str]] = {}
        try:
            if reply.truncated:
                raise ValueError("cut off at the length limit; make the chapters more compact")
            got, fns = _parse_steps(reply.text, len(todo))
            new_fns = {**new_fns, **fns}
            for k, i in enumerate(todo):
                p = step_problems(got[k], i, o.steps[i], {**functions, **new_fns})
                if p:
                    problems[i] = p
                else:
                    done[i] = got[k]
        except ValueError as e:
            problems = {i: [f"could not parse the JSON: {e}"] for i in todo}
        # Coverage: checks may only test what came before, judged in order.
        if not problems:
            ordered = [done[i] for i in idxs if i in done]
            flagged = await _check_chunk(earlier, ordered, {o.steps[i].id for i in idxs})
            for i in list(done):
                if o.steps[i].id in flagged:
                    problems[i] = [flagged[o.steps[i].id]]
                    del done[i]
        if not problems:
            return [done[i] for i in idxs], new_fns
        log.warning("chunk attempt %d for %r: %d chapter(s) need fixing", attempt + 1, title, len(problems))
        if attempt == MAX_REPAIRS:
            break
        todo = sorted(problems)
        listing = "\n".join(f'- step {i + 1} ("{o.steps[i].title}"): ' + "; ".join(problems[i]) for i in todo)
        turns += [Turn("assistant", reply.text), Turn("user", (
            "These chapters failed checks:\n" + listing + "\n\nReply with JSON only: "
            f'{{"steps": [...the corrected chapters, in this order: {", ".join(str(i + 1) for i in todo)}...], "functions": {{}}}}'
        ))]
    raise GenerationError("Couldn't write some chapters of this lesson. Please try again.")


def lesson_from_outline(o: Outline) -> dict:
    """The lesson record before any chapters exist; chapters are appended as they're written."""
    return {
        "title": o.title, "eyebrow": o.eyebrow, "summary": o.summary, "palette": o.palette, "functions": {},
        "sources": [s.model_dump() for s in o.sources], "note": o.note,
        "outline": [s.model_dump() for s in o.steps],
        "steps": [], "complete": False,
    }


def final_check(lesson: dict) -> list[str]:
    """Whole-lesson validation once every chapter is in (outline/complete are bookkeeping)."""
    body = {k: v for k, v in lesson.items() if k not in ("outline", "complete")}
    try:
        Lesson.model_validate(body)
        return []
    except ValidationError as e:
        return [f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()[:10]]


Save = Callable[[dict], Awaitable[None]]


def outline_from_lesson(lesson: dict) -> Outline:
    """Rebuild the plan from a half-written lesson, to carry on where it stopped."""
    return Outline(
        title=lesson["title"], eyebrow=lesson["eyebrow"], summary=lesson["summary"], palette=lesson.get("palette") or {},
        steps=[OutlineStep(**{"brief": "", **x}) for x in lesson["outline"]], sources=lesson.get("sources") or [],
        note=lesson.get("note"),
    )


# ---------- one call for the whole lesson ----------

# The single call's output limit. A full lesson (8-10 chapters of scene JSON) is roughly 12-20k
# tokens, so this leaves room without letting a runaway reply eat the whole window.
LESSON_MAX_TOKENS = 32_768

SHORTER = [
    "\n\nIMPORTANT: your last draft was cut off for length. Write a SHORTER lesson: 6 to 7 steps in total, at most 4 "
    "narration sentences per video, and simpler scenes (fewer elements).",
    "\n\nIMPORTANT: your last two drafts were cut off for length. Write a COMPACT lesson: 5 to 6 steps in total "
    "(intro, 2 chapters, 1 activity, quiz), 3 narration sentences per video, and very simple scenes.",
]


class _Planned:
    """A step's own id and kind, so a step can be checked without a prior outline."""

    def __init__(self, step: dict):
        self.id, self.kind = step.get("id"), step.get("kind")


def _bad_steps(steps: list, functions: dict) -> dict[int, list[str]]:
    """Problems per step index (0-based), each step checked on its own, plus whole-lesson rules mapped to a step."""
    problems: dict[int, list[str]] = {}
    for i, st in enumerate(steps):
        if not isinstance(st, dict):
            problems[i] = ["this step must be a JSON object"]
            continue
        p = step_problems(st, i, _Planned(st), functions)  # type: ignore[arg-type]
        if p:
            problems[i] = p
    if steps and isinstance(steps[-1], dict) and steps[-1].get("kind") != "quiz":
        problems.setdefault(len(steps) - 1, []).append("the last step must be the quiz")
    seen: dict[str, int] = {}
    for i, st in enumerate(steps):
        sid = st.get("id") if isinstance(st, dict) else None
        if sid in seen:
            problems.setdefault(i, []).append(f'step id "{sid}" is already used; ids must be unique')
        elif sid:
            seen[sid] = i
    return problems


def _full_prompt(title: str, query: str, notes: str, sources: list[dict[str, str]]) -> str:
    source_list = "\n".join(f"- {s['title']}: {s['url']}" for s in sources[:30]) or "(none captured)"
    return (
        f"Topic: {title}\nThe learner searched for: {query}\n\n<research_notes>\n{notes}\n</research_notes>\n\n"
        f"<source_urls>\n{source_list}\n</source_urls>\n\n"
        "Write the whole lesson as one JSON object: title, eyebrow, summary, palette, functions, steps, sources, note. "
        "Quizzes and activities may only test what the chapters before them taught."
    )


async def write_whole_lesson(title: str, query: str, notes: str, sources: list[dict[str, str]],
                             progress: Callable[[str], Awaitable[None]]) -> dict:
    """One Gemini call writes the lesson. A cut-off reply is retried as a shorter request; broken chapters
    are sent back alone for repair, not the whole lesson."""
    provider = get_provider()
    system = _writer_system()
    base = _full_prompt(title, query, notes, sources)
    turns = [Turn("user", base)]
    shorter = 0
    raw: dict | None = None
    reply = None
    while raw is None:
        reply = await provider.write(system, turns, max_tokens=LESSON_MAX_TOKENS)
        parsed = None
        if not reply.truncated:
            try:
                parsed = _extract_json(reply.text)
            except ValueError:
                parsed = None
        if parsed is None:
            if shorter >= len(SHORTER):
                raise GenerationError("The lesson was too long to write in one go. Please try again.")
            await progress("The draft was cut off; writing a shorter one…")
            turns = [Turn("user", base + SHORTER[shorter])]
            shorter += 1
            continue
        raw = parsed

    steps: list = list(raw.get("steps") or [])
    functions = raw.get("functions") or {}
    for attempt in range(MAX_REPAIRS + 1):
        problems = _bad_steps(steps, functions)
        if not problems:
            flagged = await _check_chunk([], [s for s in steps if isinstance(s, dict)], {s.get("id") for s in steps if isinstance(s, dict)})
            by_id = {s.get("id"): i for i, s in enumerate(steps) if isinstance(s, dict)}
            for sid, text in flagged.items():
                if sid in by_id:
                    problems[by_id[sid]] = [text]
        if not problems:
            break
        if attempt == MAX_REPAIRS:
            raise GenerationError("Some chapters of this lesson didn't pass checks. Please try again.")
        await progress(f"Fixing {len(problems)} chapter{'s' if len(problems) != 1 else ''}…")
        nums = sorted(i + 1 for i in problems)
        listing = "\n".join(f'- step {i + 1}: ' + "; ".join(problems[i]) for i in sorted(problems))
        turns = [*turns, Turn("assistant", reply.text if reply else ""), Turn("user", (
            f"These steps failed checks:\n{listing}\n\nReply with JSON only: "
            f'{{"steps": {{{", ".join(f"\"{n}\": {{...corrected step {n}...}}" for n in nums)}}}}}'
            " containing ONLY those steps (numbered as above)."
        ))]
        fix = await provider.write(system, turns, max_tokens=LESSON_MAX_TOKENS)
        reply = fix
        try:
            fixed = _extract_json(fix.text).get("steps") or {}
        except ValueError:
            continue
        if isinstance(fixed, dict):
            for key, st in fixed.items():
                if str(key).isdigit() and 0 < int(key) <= len(steps) and isinstance(st, dict):
                    steps[int(key) - 1] = st
    lesson = {k: raw.get(k) for k in ("title", "eyebrow", "summary", "palette", "functions", "sources", "note")}
    lesson["palette"] = lesson.get("palette") or {}
    lesson["functions"] = functions
    lesson["sources"] = lesson.get("sources") or [s for s in sources[:6]]
    lesson["steps"] = steps
    lesson["outline"] = [{"id": s["id"], "kind": s["kind"], "title": s.get("title", ""), "tag": s.get("tag", "")} for s in steps]
    lesson["complete"] = True
    return lesson


async def stream_lesson(title: str, query: str, notes: str, sources: list[dict[str, str]],
                        progress: Callable[[str], Awaitable[None]], save: Save, on_playable: Callable[[], Awaitable[None]],
                        resume: dict | None = None) -> dict:
    """New lessons: one Gemini call writes everything, then it's saved together. The player still loads
    only the current and next chapter. A half-written lesson (from before) finishes its missing chapters in one call."""
    if resume and resume.get("outline"):
        o, lesson = outline_from_lesson(resume), resume
        if len(lesson["steps"]) < len(o.steps):
            idxs = list(range(len(lesson["steps"]), len(o.steps)))
            await progress(f"Writing the remaining {len(idxs)} chapter{'s' if len(idxs) != 1 else ''}…")
            steps, new_fns = await write_chunk(title, notes, o, idxs, lesson["steps"], lesson["functions"])
            lesson = {**lesson, "functions": {**lesson["functions"], **new_fns}, "steps": [*lesson["steps"], *steps]}
        lesson = {**lesson, "complete": True}
    else:
        await progress("Writing the lesson…")
        lesson = await write_whole_lesson(title, query, notes, sources, progress)
    await save(lesson)
    problems = final_check(lesson)
    if problems:
        log.warning("lesson %r has whole-lesson problems: %s", title, problems[:3])
    return lesson
