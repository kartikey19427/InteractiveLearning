"""The free options never call ElevenLabs: browser makes no calls, Charon uses Gemini only."""

import asyncio
from types import SimpleNamespace

import app.main as main
from app import narration

STEP = {"kind": "video", "id": "a", "narration": ["One.", "Two."]}


def settings(monkeypatch, eleven=True, gemini=True):
    fake = SimpleNamespace(elevenlabs_api_key="k" if eleven else None, gemini_api_key="g" if gemini else None,
                           elevenlabs_voice_id="Gfpl8Yo74Is0W6cPUWWT", elevenlabs_model="m", tts_voice="Charon",
                           tts_model="t", narrator=("elevenlabs" if eleven else "gemini") if (eleven or gemini) else None)
    monkeypatch.setattr(narration, "get_settings", lambda: fake)
    monkeypatch.setattr(main, "get_settings", lambda: fake)


def test_browser_voice_has_no_recording_target(monkeypatch):
    settings(monkeypatch)
    assert narration.narrator_target("browser") is None


def test_charon_records_with_gemini_even_when_elevenlabs_is_set(monkeypatch):
    settings(monkeypatch)
    assert narration.narrator_target("charon") == ("gemini", "Charon")


def test_charon_never_calls_elevenlabs(monkeypatch):
    settings(monkeypatch)
    calls = []

    async def eleven(*a, **k):
        calls.append("elevenlabs")
        raise AssertionError("ElevenLabs must not be called for Charon")

    async def gemini(slug, videos, out_dir):
        calls.append("gemini")
        return {"provider": "gemini", "voice": "Charon", "model": "t",
                "clips": {"a": {"url": "x", "bounds": [1, 2]}}}

    monkeypatch.setattr(narration, "_narrate_eleven", eleven)
    monkeypatch.setattr(narration, "_narrate_gemini", gemini)
    monkeypatch.setattr(narration, "MEDIA", narration.Path("/tmp/voice-test-media"))
    rec = asyncio.run(narration.narrate_chapter("slug", STEP, "charon"))
    assert calls == ["gemini"] and rec["provider"] == "gemini"


def test_browser_and_charon_are_listed_with_badges(monkeypatch):
    settings(monkeypatch)
    out = asyncio.run(main.list_voices())
    by_id = {v["id"]: v for v in out["voices"]}
    assert by_id["browser"]["badge"] == "Free, no credits"
    assert by_id["charon"]["badge"] == "Free tier, limited daily"
    assert out["default"] == "Gfpl8Yo74Is0W6cPUWWT"  # Max stays the default
