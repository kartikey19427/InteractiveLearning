"""Which voice a chapter plays: the chosen ElevenLabs voice when it works, older voices only when it doesn't."""

import asyncio
from types import SimpleNamespace

import app.main as main

MAX = "Gfpl8Yo74Is0W6cPUWWT"
STEP = {"kind": "video", "id": "a", "narration": ["One.", "Two."]}


def topic(narration=None, voices=None):
    return SimpleNamespace(id=1, status="ready", lesson={"steps": [STEP]}, narration=narration, voices=voices)


def call(monkeypatch, t, narrating=False, enqueued=None):
    async def fake_topic(_s, _slug):
        return t
    monkeypatch.setattr(main, "_topic", fake_topic)
    monkeypatch.setattr(main, "narrator_target", lambda v=None: ("elevenlabs", MAX))
    monkeypatch.setattr(main.jobs, "enqueue_chapter", lambda *a: enqueued.append(a) if enqueued is not None else None)
    monkeypatch.setattr(main.jobs, "chapter_narrating", lambda *a: narrating)
    return asyncio.run(main.get_chapter_narration("slug", "a", MAX, None))


def test_saved_chapter_plays(monkeypatch):
    clip = {"url": "u", "bounds": [1, 2]}
    r = call(monkeypatch, topic(voices={MAX: {"provider": "elevenlabs", "voice": MAX, "clips": {"a": clip}}}))
    assert r["state"] == "ready" and r["clip"] == clip


def test_missing_chapter_is_recorded_on_demand_and_old_voice_not_played(monkeypatch):
    enqueued = []
    charon = {"provider": "gemini", "voice": "Charon", "clips": {"a": {"url": "old", "bounds": [1, 2]}}}
    r = call(monkeypatch, topic(narration=charon), narrating=True, enqueued=enqueued)
    assert enqueued == [(1, MAX, "a")]
    assert r == {"state": "preparing", "clip": None}


def test_old_voice_stands_in_only_after_the_chosen_voice_fails(monkeypatch):
    charon = {"provider": "gemini", "voice": "Charon", "clips": {"a": {"url": "old", "bounds": [1, 2]}}}
    r = call(monkeypatch, topic(narration=charon), narrating=False, enqueued=[])
    assert r["state"] == "fallback" and r["clip"]["url"] == "old"
