"""One Gemini call writes the whole lesson; cut-offs retry shorter; only broken chapters are repaired."""

import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import app.streaming as streaming
from app.providers import GenerationError

EXAMPLE = json.loads((Path(__file__).parents[1] / "app/prompts/example_lesson.json").read_text())


class FakeProvider:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def write(self, system, turns, max_tokens=None):
        self.calls.append({"turns": [t.text for t in turns], "max_tokens": max_tokens})
        return self.replies.pop(0)


def reply(obj=None, truncated=False, text=None):
    return SimpleNamespace(text=text if text is not None else json.dumps(obj), truncated=truncated)


def run(monkeypatch, provider):
    async def no_check(*a, **k):
        return {}

    async def progress(_):
        pass

    monkeypatch.setattr(streaming, "get_provider", lambda: provider)
    monkeypatch.setattr(streaming, "_check_chunk", no_check)
    return asyncio.run(streaming.write_whole_lesson("T", "q", "notes", [], progress))


def test_whole_lesson_is_one_call_with_a_deliberate_limit(monkeypatch):
    p = FakeProvider([reply(EXAMPLE)])
    lesson = run(monkeypatch, p)
    assert len(p.calls) == 1 and p.calls[0]["max_tokens"] == streaming.LESSON_MAX_TOKENS == 32_768
    assert lesson["complete"] is True and [o["id"] for o in lesson["outline"]] == [s["id"] for s in EXAMPLE["steps"]]


def test_cut_off_reply_is_retried_shorter_not_failed(monkeypatch):
    p = FakeProvider([reply(truncated=True, text="{"), reply(EXAMPLE)])
    run(monkeypatch, p)
    assert len(p.calls) == 2 and "SHORTER" in p.calls[1]["turns"][0]  # a fresh, shorter request


def test_gives_up_with_a_clear_error_after_repeated_cut_offs(monkeypatch):
    p = FakeProvider([reply(truncated=True, text="{")] * 3)
    with pytest.raises(GenerationError):
        run(monkeypatch, p)


def test_only_the_broken_chapter_is_repaired(monkeypatch):
    bad = copy.deepcopy(EXAMPLE)
    bad["steps"][1]["kind"] = "nonsense"  # chapter 2 is broken
    fixed = {"steps": {"2": EXAMPLE["steps"][1]}}
    p = FakeProvider([reply(bad), reply(fixed)])
    lesson = run(monkeypatch, p)
    assert len(p.calls) == 2
    assert "step 2" in p.calls[1]["turns"][-1] and "step 3" not in p.calls[1]["turns"][-1]
    assert lesson["steps"][1] == EXAMPLE["steps"][1] and lesson["steps"][0] == EXAMPLE["steps"][0]
