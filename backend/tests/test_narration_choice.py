"""Which voice a lesson plays: Max when it works, older voices only when it doesn't."""

from types import SimpleNamespace

import app.main as main

LESSON = {"steps": [{"kind": "video", "id": "a", "narration": ["One.", "Two."]}]}
MAX = ("elevenlabs", "max")


def topic(narration):
    return SimpleNamespace(id=1, status="ready", lesson=LESSON, narration=narration)


def setup(monkeypatch, narrating=False, partial=None):
    monkeypatch.setattr(main, "narrator_target", lambda: MAX)
    import app.narration as narration
    monkeypatch.setattr(narration, "narrator_target", lambda: MAX)
    monkeypatch.setattr(main.jobs, "narrating", lambda _id: narrating)
    monkeypatch.setattr(main.jobs, "partial_narration", lambda _id: partial)


def test_saved_max_recording_plays(monkeypatch):
    setup(monkeypatch)
    rec = {"provider": "elevenlabs", "voice": "max", "clips": {}}
    assert main._narration_view(topic(rec)) == {"narration": rec, "narration_state": "ready"}


def test_old_voice_is_not_played_while_max_is_being_recorded(monkeypatch):
    partial = {"provider": "elevenlabs", "voice": "max", "clips": {"a": {"url": "x", "bounds": [1, 2]}}, "complete": False}
    setup(monkeypatch, narrating=True, partial=partial)
    charon = {"provider": "gemini", "voice": "Charon", "clips": {"a": {"url": "old", "bounds": [1, 2]}}}
    view = main._narration_view(topic(charon))
    assert view["narration_state"] == "preparing"
    assert view["narration"] is partial  # never the old Charon audio


def test_old_voice_stands_in_only_after_max_fails(monkeypatch):
    setup(monkeypatch, narrating=False)
    charon = {"provider": "gemini", "voice": "Charon", "clips": {}}
    assert main._narration_view(topic(charon)) == {"narration": charon, "narration_state": "fallback"}
