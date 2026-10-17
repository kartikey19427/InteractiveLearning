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


async def _check_step(earlier: list[dict], step: dict) -> tuple[dict, list[str]]:
    """Only test what was taught: review this activity or quiz against the chapters before it."""
    if step.get("kind") == "video":
        return step, []
    lesson = {"steps": [*earlier, step]}
    try:
        report = await get_provider().structured(COVERAGE_SYSTEM, coverage_outline(lesson), CoverageReport)
    except ProviderUnavailable:
        return step, []  # rate limited: keep the chapter rather than stall the stream
    assert isinstance(report, CoverageReport)
    report.verdicts = [v for v in report.verdicts if v.step_id == step.get("id")]
    lesson, problems = apply_report(lesson, report)
    return lesson["steps"][-1], problems


async def write_step(title: str, notes: str, o: Outline, index: int, earlier: list[dict], functions: dict) -> tuple[dict, dict]:
    """Write chapter `index`. Returns the step and any new helper functions it defines."""
    provider = get_provider()
    planned = o.steps[index]
    plan = json.dumps([s.model_dump() for s in o.steps], ensure_ascii=False)
    task = (
        f"Topic: {title}\n\n<research_notes>\n{notes}\n</research_notes>\n\n"
        f"<outline>\n{plan}\n</outline>\n<palette>{json.dumps(o.palette)}</palette>\n"
        f"<helper_functions_so_far>{json.dumps(functions)}</helper_functions_so_far>\n\n"
        f"<earlier_chapters>\n{_earlier(earlier)}\n</earlier_chapters>\n\n"
        f'Now write ONLY step {index + 1} of {len(o.steps)}: id "{planned.id}", kind "{planned.kind}", title "{planned.title}". '
        f"Brief: {planned.brief}\n"
        "It must follow the format and clarity rules, use palette names from the outline, and if it is an activity or "
        "quiz, test only what the earlier chapters taught. Reply with JSON only: "
        '{"step": { ...the step... }, "functions": { ...only NEW helper functions it needs, or {} }}'
    )
    turns = [Turn("user", task)]
    for attempt in range(MAX_REPAIRS + 1):
        reply = await provider.write(_writer_system(), turns)
        try:
            if reply.truncated:
                raise ValueError("cut off at the length limit; make this chapter more compact")
            data = _extract_json(reply.text)
            step, new_fns = data.get("step") or {}, data.get("functions") or {}
            if not isinstance(step, dict) or not isinstance(new_fns, dict):
                raise ValueError('reply must be {"step": {...}, "functions": {...}}')
            problems = step_problems(step, index, planned, {**functions, **new_fns})
            if not problems:
                step, problems = await _check_step(earlier, step)
        except ValueError as e:
            step, new_fns, problems = None, {}, [f"could not parse the JSON: {e}"]
        if not problems and step is not None:
            return step, new_fns
        log.warning("step %s attempt %d for %r: %s", planned.id, attempt + 1, title, problems[:3])
        turns += [Turn("assistant", reply.text), Turn("user", "That step failed checks:\n- " + "\n- ".join(problems)
                                                     + '\n\nReply with the corrected {"step": ..., "functions": ...} JSON only.')]
    raise GenerationError(f"Couldn't write the chapter \"{planned.title}\". Please try again.")


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


async def stream_lesson(title: str, query: str, notes: str, sources: list[dict[str, str]],
                        progress: Callable[[str], Awaitable[None]], save: Save, on_playable: Callable[[], Awaitable[None]],
                        resume: dict | None = None) -> dict:
    """Write the lesson outline-first, chapter by chapter, saving after each. `resume` carries on a partial one."""
    if resume and resume.get("outline"):
        o, lesson = outline_from_lesson(resume), resume
    else:
        await progress("Planning the chapters…")
        o = await write_outline(title, query, notes, sources)
        lesson = lesson_from_outline(o)
        await save(lesson)
    for i in range(len(lesson["steps"]), len(o.steps)):
        await progress(f"Writing chapter {i + 1} of {len(o.steps)}: {o.steps[i].title}")
        for wait in (60, 90, 120, None):
            try:
                step, new_fns = await write_step(title, notes, o, i, lesson["steps"], lesson["functions"])
                break
            except ProviderUnavailable:
                # Usually the per-minute limit from writing chapters back to back: pause, then carry on.
                if wait is None:
                    raise
                await progress(f"Waiting a moment for the AI service before chapter {i + 1}…")
                await asyncio.sleep(wait)
        lesson = {**lesson, "functions": {**lesson["functions"], **new_fns}, "steps": [*lesson["steps"], step]}
        await save(lesson)
        if i == 0:
            await on_playable()  # the intro is ready: the learner can start
    lesson = {**lesson, "complete": True}
    problems = final_check(lesson)
    if problems:
        log.warning("streamed lesson %r has whole-lesson problems: %s", title, problems[:3])
    return lesson
