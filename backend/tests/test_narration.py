"""Sentence timing for recorded narration: the cut points the player syncs to."""

import array
import math

from app.narration import _trim, sentence_bounds, split_chapters

RATE = 24000


def tone(seconds: float, freq: float = 220) -> list[int]:
    n = int(seconds * RATE)
    return [int(8000 * math.sin(2 * math.pi * freq * i / RATE)) for i in range(n)]


def silence(seconds: float) -> list[int]:
    return [0] * int(seconds * RATE)


def pcm(*parts: list[int]) -> bytes:
    return array.array("h", [x for p in parts for x in p]).tobytes()


def test_sentence_ends_are_the_pauses_between_sentences():
    # Three sentences; the second has a short comma pause inside it.
    audio = pcm(tone(2.0), silence(0.9), tone(1.0), silence(0.35), tone(1.0), silence(0.9), tone(2.5))
    sentences = ["First sentence here.", "Second, with a comma pause.", "The third sentence is a bit longer."]
    bounds = sentence_bounds(audio, RATE, sentences)
    assert len(bounds) == 3
    assert abs(bounds[0] - 2.45) < 0.25
    assert abs(bounds[1] - (2.9 + 2.35 + 0.45)) < 0.25
    assert abs(bounds[2] - len(audio) / 2 / RATE) < 0.01


def test_bounds_are_increasing_even_without_clear_pauses():
    audio = pcm(tone(6.0))
    bounds = sentence_bounds(audio, RATE, ["One.", "Two two.", "Three three three."])
    assert bounds == sorted(bounds) and len(set(bounds)) == 3


def test_chapters_split_at_the_long_pauses():
    one, two = tone(3.0), tone(2.0)
    audio = pcm(one, silence(2.0), two)
    parts = split_chapters(audio, RATE, [["A."], ["B."]])
    lengths = [len(_trim(p, RATE)) / 2 / RATE for p in parts]
    assert abs(lengths[0] - 3.0) < 0.35
    assert abs(lengths[1] - 2.0) < 0.35
