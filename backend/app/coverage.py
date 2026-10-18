"""Checks a lesson's quizzes and activities only test what earlier chapters taught.

One model call reads the chapters in order and marks each quiz question and
activity as covered or not. Uncovered quiz questions are dropped when enough
remain; anything else becomes a problem sent back to the writer.
"""

from __future__ import annotations

import asyncio
import json
import logging

from pydantic import BaseModel, Field

from .providers import get_provider

log = logging.getLogger(__name__)

MIN_QUESTIONS = 3


class Verdict(BaseModel):
    step_id: str
    item: str = Field(description='"activity" for an activity, or "q1", "q2"... for quiz questions (1-based).')
    covered: bool
    missing: str = Field(default="", description="If not covered: what it needs that no earlier chapter teaches.")


class CoverageReport(BaseModel):
    verdicts: list[Verdict]


SYSTEM = (
    "You review an interactive lesson. Chapters are listed in order. For every activity and every quiz "
    "question, decide whether a learner who only watched the EARLIER video chapters (and did the earlier "
    "activities) has been taught what they need to answer or complete it. General knowledge a 14-18 year "
    "old already has is fine; specific facts, terms, numbers or rules must have been taught earlier. "
    "Return one verdict per activity and per quiz question."
)


def _activity_text(step: dict) -> str:
    keep = {k: step.get(k) for k in ("title", "intro", "question", "caption", "prompt")}
    kind = step.get("kind")
    if kind == "simulation":
        keep["predict"] = step.get("predict")
        keep["checks"] = [c.get("label") for c in step.get("checks") or []]
        keep["goal"] = (step.get("goal") or {}).get("note")
    elif kind == "match":
        keep["tokens"] = [t.get("label") for t in step.get("tokens") or []]
        keep["rules"] = [r.get("text") for r in step.get("rules") or []]
    elif kind == "process":
        keep["steps"] = [{"label": s.get("label"), "done": s.get("done")} for s in step.get("steps") or []]
    return json.dumps(keep, ensure_ascii=False)


def outline(lesson: dict) -> str:
    """The lesson as the reviewer sees it: what each chapter teaches, and what each check asks."""
    parts = []
    for i, st in enumerate(lesson.get("steps") or []):
        kind = st.get("kind")
        if kind == "video":
            terms = "; ".join(f"{t.get('term')}: {t.get('definition')}" for t in st.get("terms") or [])
            parts.append(f"[{i + 1}] VIDEO {st.get('id')} \"{st.get('title')}\"\nNarration: {' '.join(st.get('narration') or [])}\nTerms: {terms}")
        elif kind == "quiz":
            qs = "\n".join(
                f"q{n + 1}: {q.get('question')} Options: {q.get('options')} Answer: {(q.get('options') or [''])[q.get('answer', 0)] if q.get('options') else ''}"
                for n, q in enumerate(st.get("questions") or [])
            )
            parts.append(f"[{i + 1}] QUIZ {st.get('id')}\n{qs}")
        else:
            parts.append(f"[{i + 1}] ACTIVITY {st.get('id')} ({kind})\n{_activity_text(st)}")
    return "\n\n".join(parts)


def apply_report(lesson: dict, report: CoverageReport) -> tuple[dict, list[str]]:
    """Drop uncovered quiz questions where enough remain; return the rest as problems for the writer."""
    problems: list[str] = []
    steps = {st.get("id"): st for st in lesson.get("steps") or []}
    drop: dict[str, set[int]] = {}
    for v in report.verdicts:
        if v.covered or v.step_id not in steps:
            continue
        st = steps[v.step_id]
        if st.get("kind") == "quiz" and v.item.lower().startswith("q") and v.item[1:].isdigit():
            drop.setdefault(v.step_id, set()).add(int(v.item[1:]) - 1)
        else:
            problems.append(f"{v.step_id}: tests something no earlier chapter teaches ({v.missing}). "
                            "Change it to use only earlier chapters, or teach it in the chapter before.")
    for step_id, idx in drop.items():
        st = steps[step_id]
        qs = st.get("questions") or []
        keep = [q for n, q in enumerate(qs) if n not in idx]
        if len(keep) >= MIN_QUESTIONS:
            st["questions"] = keep
            log.info("dropped %d uncovered quiz question(s) from %s", len(qs) - len(keep), step_id)
        else:
            problems.append(f"{step_id}: quiz questions {sorted(n + 1 for n in idx)} test things no earlier chapter teaches. "
                            "Replace them with questions about what the chapters taught.")
    return lesson, problems


async def check_coverage(lesson: dict) -> tuple[dict, list[str]]:
    from .providers import ProviderUnavailable

    try:
        report = await get_provider().structured(SYSTEM, outline(lesson), CoverageReport)
    except ProviderUnavailable:
        # Usually a per-minute rate limit right after writing the lesson: wait and try once more.
        await asyncio.sleep(30)
        report = await get_provider().structured(SYSTEM, outline(lesson), CoverageReport)
    assert isinstance(report, CoverageReport)
    return apply_report(lesson, report)
