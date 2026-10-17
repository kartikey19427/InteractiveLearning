"""Rules for new lessons: a short intro first, and checks that only test earlier chapters."""

import copy
import json
from pathlib import Path

from app.coverage import CoverageReport, Verdict, apply_report, outline
from app.generator import _problems

EXAMPLE = json.loads((Path(__file__).parents[1] / "app/prompts/example_lesson.json").read_text())


def test_example_lesson_follows_the_rules():
    assert _problems(EXAMPLE) == []


def test_lesson_without_intro_is_sent_back():
    lesson = copy.deepcopy(EXAMPLE)
    lesson["steps"].pop(0)
    assert any("intro" in p for p in _problems(lesson))


def test_long_intro_is_sent_back():
    lesson = copy.deepcopy(EXAMPLE)
    lesson["steps"][0]["scene"]["duration"] = 60
    assert any("25 seconds" in p for p in _problems(lesson))


def test_uncovered_quiz_questions_are_dropped_when_enough_remain():
    lesson = copy.deepcopy(EXAMPLE)
    quiz = next(s for s in lesson["steps"] if s["kind"] == "quiz")
    quiz["questions"].append(dict(quiz["questions"][0], question="Something never taught?"))
    n = len(quiz["questions"])
    report = CoverageReport(verdicts=[Verdict(step_id="quiz", item=f"q{n}", covered=False, missing="never taught")])
    fixed, problems = apply_report(lesson, report)
    assert problems == []
    assert len(next(s for s in fixed["steps"] if s["kind"] == "quiz")["questions"]) == n - 1


def test_uncovered_activity_goes_back_to_the_writer():
    report = CoverageReport(verdicts=[Verdict(step_id="dry", item="activity", covered=False, missing="wind chill")])
    _, problems = apply_report(copy.deepcopy(EXAMPLE), report)
    assert problems and "dry" in problems[0]


def test_reviewer_sees_chapters_in_order():
    text = outline(EXAMPLE)
    assert text.index("VIDEO intro") < text.index("ACTIVITY dry") < text.index("QUIZ quiz")
