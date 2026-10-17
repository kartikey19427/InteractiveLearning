"""Recordings are kept per voice; unknown voices fall back to the default (Max)."""

from types import SimpleNamespace

from app import jobs
from app.narration import VOICES, pick_voice

MAX = "Gfpl8Yo74Is0W6cPUWWT"
ALICE = "Xb7hH8MSUJpSbSDYk0k2"


def test_menu_has_five_voices_with_max_first():
    assert len(VOICES) == 5 and VOICES[0]["id"] == MAX


def test_unknown_voice_uses_the_default():
    assert pick_voice("not-a-voice") == pick_voice(None)
    assert pick_voice(ALICE) == ALICE


def test_each_voice_has_its_own_recording():
    alice = {"provider": "elevenlabs", "voice": ALICE, "clips": {}}
    max_old = {"provider": "elevenlabs", "voice": MAX, "clips": {}}
    t = SimpleNamespace(voices={ALICE: alice}, narration=max_old)
    assert jobs.recording_for(t, ALICE) is alice
    assert jobs.recording_for(t, MAX) is max_old  # saved before voices were kept apart
    assert jobs.recording_for(SimpleNamespace(voices={}, narration=None), ALICE) is None
