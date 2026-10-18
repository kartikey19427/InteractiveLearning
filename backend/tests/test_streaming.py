"""Outline-first lessons: plan checks, per-chapter checks, and the outline the player sees."""

import copy
import json
from pathlib import Path

from app.main import lesson_meta
from app.streaming import Outline, OutlineStep, lesson_from_outline, outline_from_lesson, outline_problems, step_problems

EXAMPLE = json.loads((Path(__file__).parents[1] / "app/prompts/example_lesson.json").read_text())


def plan(kinds):
    steps = [OutlineStep(id="intro" if i == 0 else f"s{i}", kind=k, title=f"T{i}", tag="t", brief="b") for i, k in enumerate(kinds)]
    return Outline(title="X", eyebrow="e", summary="s", steps=steps, sources=[])


def test_good_plan_passes():
    assert outline_problems(plan(["video", "video", "simulation", "video", "quiz"])) == []


def test_plan_must_start_with_intro_and_end_with_quiz():
    p = plan(["video", "video", "simulation", "video", "video"])
    assert any("quiz" in x for x in outline_problems(p))


def test_activity_needs_a_teaching_chapter_before_it():
    p = plan(["video", "simulation", "video", "quiz"])
    assert any("after at least one teaching chapter" in x for x in outline_problems(p))


def test_each_chapter_is_checked_alone():
    o = plan([s["kind"] for s in EXAMPLE["steps"]])
    o.steps = [OutlineStep(id=s["id"], kind=s["kind"], title=s["title"], tag=s["tag"], brief="b") for s in EXAMPLE["steps"]]
    for i, st in enumerate(EXAMPLE["steps"]):
        assert step_problems(st, i, o.steps[i], EXAMPLE.get("functions") or {}) == [], st["id"]
    wrong = copy.deepcopy(EXAMPLE["steps"][1])
    assert step_problems(wrong, 1, o.steps[2], {})  # id/kind don't match the plan


def test_player_gets_an_outline_with_how_many_chapters_are_ready():
    o = plan(["video", "video", "video", "quiz"])
    lesson = lesson_from_outline(o)
    lesson["steps"] = [EXAMPLE["steps"][0]]
    meta = lesson_meta(lesson)
    assert [x["id"] for x in meta["outline"]] == ["intro", "s1", "s2", "s3"]
    assert meta["steps_ready"] == 1 and meta["complete"] is False
    assert outline_from_lesson(lesson).steps[1].id == "s1"  # resumable


def test_old_complete_lessons_still_work():
    meta = lesson_meta(EXAMPLE)
    assert meta["complete"] is True and meta["steps_ready"] == len(EXAMPLE["steps"])
