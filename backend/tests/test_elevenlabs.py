"""ElevenLabs narration: sentence timing from its per-character timestamps."""

import asyncio
import base64
import json

import httpx
import pytest

from app import narration
from app.narration import QuotaExhausted, aligned_bounds


def alignment(text: str, seconds_per_char: float = 0.05) -> dict:
    return {
        "characters": list(text),
        "character_start_times_seconds": [i * seconds_per_char for i in range(len(text))],
        "character_end_times_seconds": [(i + 1) * seconds_per_char for i in range(len(text))],
    }


def test_sentence_ends_come_from_the_character_timings():
    sentences = ["Plants need light.", "They make sugar."]
    bounds = aligned_bounds(alignment(" ".join(sentences)), sentences, duration=2.0)
    # "Plants need light." is 18 characters: it ends at 0.9 s, the space after it at 0.95 s.
    assert bounds == [pytest.approx(0.925), 2.0]


def test_mismatched_timings_are_rejected():
    assert aligned_bounds(alignment("something else"), ["One.", "Two."], duration=1.0) is None
    assert aligned_bounds({}, ["One.", "Two."], duration=1.0) is None


def test_speak_returns_audio_and_alignment(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["output_format"] == "pcm_24000"
        assert json.loads(request.content)["text"] == "Hi."
        return httpx.Response(200, json={"audio_base64": base64.b64encode(b"\0\0" * 10).decode(), "alignment": alignment("Hi.")})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await narration._speak_eleven(client, "Hi.")

    pcm, align = asyncio.run(run())
    assert len(pcm) == 20 and align["characters"] == ["H", "i", "."]


def test_used_up_allowance_pauses_narration():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": {"status": "quota_exceeded", "message": "quota exceeded"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await narration._speak_eleven(client, "Hi.")

    with pytest.raises(QuotaExhausted):
        asyncio.run(run())


def test_a_failed_elevenlabs_run_falls_back_to_gemini(monkeypatch, tmp_path):
    calls = []

    async def eleven(slug, videos, out_dir, on_clip=None):
        raise narration.NarrationError("voice not available")

    async def gemini(slug, videos, out_dir):
        calls.append(slug)
        return {"provider": "gemini", "clips": {}}

    monkeypatch.setattr(narration, "_narrate_eleven", eleven)
    monkeypatch.setattr(narration, "_narrate_gemini", gemini)
    monkeypatch.setattr(narration, "MEDIA", tmp_path)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    from app.config import get_settings
    get_settings.cache_clear()
    lesson = {"steps": [{"kind": "video", "id": "v1", "narration": ["Hi."]}]}
    record = asyncio.run(narration.narrate_lesson("demo", lesson))
    get_settings.cache_clear()
    assert calls == ["demo"] and record["provider"] == "gemini"


def test_without_a_fallback_the_elevenlabs_error_goes_up(monkeypatch, tmp_path):
    async def eleven(slug, videos, out_dir, on_clip=None):
        raise narration.NarrationError("voice not available")

    monkeypatch.setattr(narration, "_narrate_eleven", eleven)
    monkeypatch.setattr(narration, "MEDIA", tmp_path)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    from app.config import get_settings
    get_settings.cache_clear()
    lesson = {"steps": [{"kind": "video", "id": "v1", "narration": ["Hi."]}]}
    try:
        with pytest.raises(narration.NarrationError):
            asyncio.run(narration.narrate_lesson("demo", lesson))
    finally:
        get_settings.cache_clear()


def test_a_paid_plan_error_is_a_narration_error(monkeypatch):
    # A Voice Library voice on the free plan returns 402; that must count as a failure so the Gemini fallback runs.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"detail": {"status": "paid_plan_required", "message": "requires a paid plan"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await narration._speak_eleven(client, "Hi.")

    with pytest.raises(narration.NarrationError) as e:
        asyncio.run(run())
    assert not isinstance(e.value, QuotaExhausted)


def _set_narrators(monkeypatch, eleven: str, gemini: str):
    from app.config import get_settings
    monkeypatch.setenv("ELEVENLABS_API_KEY", eleven)
    monkeypatch.setenv("GEMINI_API_KEY", gemini)
    get_settings.cache_clear()


SPEECH_LESSON = {"steps": [{"kind": "video", "id": "v1", "narration": ["Hi."]}]}
MAX_ID = "Gfpl8Yo74Is0W6cPUWWT"


def test_an_old_charon_recording_stays_while_only_gemini_is_set(monkeypatch):
    _set_narrators(monkeypatch, eleven="", gemini="test")
    assert narration.narration_is_current({"voice": "Charon", "clips": {}}, SPEECH_LESSON)


def test_an_old_charon_recording_is_redone_once_elevenlabs_is_set(monkeypatch):
    _set_narrators(monkeypatch, eleven="test", gemini="test")
    assert not narration.narration_is_current({"voice": "Charon", "clips": {}}, SPEECH_LESSON)
    assert not narration.narration_is_current(None, SPEECH_LESSON)
    assert narration.narration_is_current({"provider": "elevenlabs", "voice": MAX_ID, "clips": {}}, SPEECH_LESSON)
    # A Gemini fallback recording is not the preferred voice, so opening the lesson tries Max again.
    assert not narration.narration_is_current({"provider": "gemini", "voice": "Charon", "clips": {}}, SPEECH_LESSON)


def test_lessons_without_speech_never_need_a_recording(monkeypatch):
    _set_narrators(monkeypatch, eleven="test", gemini="test")
    quiz_only = {"steps": [{"kind": "quiz", "id": "q1"}]}
    assert narration.narration_is_current(None, quiz_only)
