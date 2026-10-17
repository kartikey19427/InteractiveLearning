"""Recorded narration for video chapters, generated once per lesson with Gemini TTS.

The whole lesson is recorded in ONE request (the free tier allows only about
10 TTS requests a day), with a long pause between chapters. The recording is
cut into one file per video chapter at the longest pauses, and sentence
boundaries inside each chapter come from the shorter pauses, so the player can
line the animation up with each sentence exactly.
"""

from __future__ import annotations

import array
import asyncio
import base64
import io
import logging
import wave
from pathlib import Path

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

MEDIA = Path(__file__).resolve().parents[1] / "media"
TTS_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
STYLE = ("Read this like a warm, clear science narrator for curious teenagers. "
         "Pause briefly between sentences, and pause for about two seconds between paragraphs:")


class NarrationError(Exception):
    pass


class QuotaExhausted(NarrationError):
    """The daily TTS allowance is used up; retrying today won't help."""


def _pcm(data: bytes, mime: str) -> tuple[bytes, int]:
    """Raw 16-bit mono PCM and its sample rate, from WAV or L16 data."""
    if data[:4] == b"RIFF":
        with wave.open(io.BytesIO(data)) as w:
            return w.readframes(w.getnframes()), w.getframerate()
    rate = int(mime.split("rate=")[1].split(";")[0]) if "rate=" in mime else 24000
    return data, rate


def _wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _levels(samples: array.array, rate: int) -> list[int]:
    frame = int(rate * 0.02)  # 20 ms frames
    return [max((abs(x) for x in samples[i : i + frame]), default=0) for i in range(0, len(samples), frame)]


def _silences(levels: list[int], min_frames: int = 8) -> list[tuple[int, int]]:
    """Quiet runs (start, end) in frames, ignoring leading and trailing silence."""
    quiet = max(levels or [1]) * 0.04
    runs, start = [], None
    for i, v in enumerate(levels):
        if v < quiet:
            start = i if start is None else start
        elif start is not None:
            if start > 0 and i - start >= min_frames:
                runs.append((start, i))
            start = None
    return runs


def _longest(runs: list[tuple[int, int]], k: int) -> list[tuple[int, int]]:
    return sorted(sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:k])


def _pick_cuts(runs: list[tuple[int, int]], weights: list[int], total_frames: int) -> list[int] | None:
    """Choose one pause per boundary, in order, near where text length says it should be.

    Pauses inside a sentence (commas, colons) are common, so the longest pauses
    alone mislead. Each boundary's expected spot is re-estimated from the cut
    before it; a pause wins by being close to that spot and long.
    """
    cuts: list[int] = []
    prev, rest = 0, sum(weights)
    for w in weights[:-1]:
        expected = prev + (total_frames - prev) * w / max(rest, 1)
        options = [r for r in runs if (r[0] + r[1]) / 2 > prev + 10]
        if not options:
            return None
        best = min(options, key=lambda r: abs((r[0] + r[1]) / 2 - expected) * 0.02 - 0.03 * min(r[1] - r[0], 40))
        cut = (best[0] + best[1]) // 2
        cuts.append(cut)
        runs = [r for r in runs if r[0] > best[1]]
        prev, rest = cut, rest - w
    return cuts


def _plausible(bounds: list[float], weights: list[int], duration: float) -> bool:
    total = sum(weights) or 1
    starts = [0.0, *bounds[:-1]]
    for (a, b), w in zip(zip(starts, bounds), weights):
        expected = duration * w / total
        if not 0.4 <= (b - a) / max(expected, 0.1) <= 2.5:
            return False
    return True


def sentence_bounds(pcm: bytes, rate: int, sentences: list[str]) -> list[float]:
    """End time (s) of each sentence, from the pauses between them (proportional to length as a fallback)."""
    samples = array.array("h", pcm)
    duration = len(samples) / rate
    if len(sentences) <= 1:
        return [duration]
    levels = _levels(samples, rate)
    runs = _silences(levels)
    weights = [len(x) for x in sentences]
    # Sentence ends are usually the longest pauses. Trust that unless it gives
    # sentence lengths wildly out of line with the text, then fall back to
    # picking pauses near where each sentence should end.
    if len(runs) >= len(sentences) - 1:
        bounds = [((a + b) / 2) * 0.02 for a, b in _longest(runs, len(sentences) - 1)] + [duration]
        if _plausible(bounds, weights, duration):
            return bounds
    cuts = _pick_cuts(runs, weights, len(levels))
    if cuts is not None:
        return [c * 0.02 for c in cuts] + [duration]
    total = sum(len(x) for x in sentences) or 1
    acc, out = 0, []
    for x in sentences:
        acc += len(x)
        out.append(duration * acc / total)
    return out


def split_chapters(pcm: bytes, rate: int, chapters: list[list[str]]) -> list[bytes]:
    """Cut one recording into chapters at the k-1 longest pauses (fallback: by text length)."""
    samples = array.array("h", pcm)
    k = len(chapters)
    if k == 1:
        return [pcm]
    levels = _levels(samples, rate)
    frame = int(rate * 0.02)
    # Chapter breaks are the long (~2 s) pauses the narrator was asked for.
    runs = _silences(levels, min_frames=30)
    if len(runs) >= k - 1:
        cuts = [((a + b) // 2) * frame for a, b in _longest(runs, k - 1)]
    else:
        lengths = [sum(len(s) for s in c) for c in chapters]
        total, acc, cuts = sum(lengths) or 1, 0, []
        for n in lengths[:-1]:
            acc += n
            cuts.append(int(len(samples) * acc / total))
    edges = [0, *cuts, len(samples)]
    return [samples[a:b].tobytes() for a, b in zip(edges, edges[1:])]


def _trim(pcm: bytes, rate: int) -> bytes:
    """Drop silence at both ends, keeping a short lead-in."""
    samples = array.array("h", pcm)
    levels = _levels(samples, rate)
    quiet = max(levels or [1]) * 0.04
    loud = [i for i, v in enumerate(levels) if v >= quiet]
    if not loud:
        return pcm
    frame = int(rate * 0.02)
    a = max(0, (loud[0] - 5) * frame)
    b = min(len(samples), (loud[-1] + 10) * frame)
    return samples[a:b].tobytes()


async def _speak(client: httpx.AsyncClient, text: str) -> tuple[bytes, int]:
    settings = get_settings()
    body = {
        "contents": [{"parts": [{"text": f"{STYLE} {text}"}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": settings.tts_voice}}},
        },
    }
    for attempt in range(6):
        res = await client.post(TTS_URL.format(model=settings.tts_model), json=body)
        if res.status_code == 200:
            part = res.json()["candidates"][0]["content"]["parts"][0]["inlineData"]
            return _pcm(base64.b64decode(part["data"]), part.get("mimeType", ""))
        if res.status_code == 429 and "PerDay" in res.text:
            raise QuotaExhausted("the daily text-to-speech allowance is used up")
        if res.status_code in (429, 500, 503) and attempt < 5:
            # TTS allows only a few requests a minute; wait it out.
            await asyncio.sleep(35)
            continue
        raise NarrationError(f"TTS failed ({res.status_code}): {res.text[:200]}")
    raise NarrationError("TTS kept hitting the rate limit")


async def narrate_lesson(slug: str, lesson: dict) -> dict:
    """Generate audio for every video step. Returns the narration record stored on the topic."""
    settings = get_settings()
    if not settings.gemini_api_key:
        raise NarrationError("no Gemini API key")
    out_dir = MEDIA / "narration" / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    clips: dict[str, dict] = {}
    videos = [st for st in lesson.get("steps", []) if st.get("kind") == "video"]
    if not videos:
        return {"voice": settings.tts_voice, "model": settings.tts_model, "clips": {}}
    script = "\n\n".join(" ".join(st["narration"]) for st in videos)
    async with httpx.AsyncClient(timeout=600, headers={"X-goog-api-key": settings.gemini_api_key}) as client:
        pcm, rate = await _speak(client, script)
    clips: dict[str, dict] = {}
    for st, part in zip(videos, split_chapters(pcm, rate, [st["narration"] for st in videos])):
        part = _trim(part, rate)
        bounds = sentence_bounds(part, rate, st["narration"])
        name = f"{st['id']}.wav"
        (out_dir / name).write_bytes(_wav(part, rate))
        clips[st["id"]] = {"url": f"/api/media/narration/{slug}/{name}", "bounds": [round(b, 3) for b in bounds]}
        log.info("narrated %s/%s (%.1fs)", slug, st["id"], bounds[-1])
    return {"voice": settings.tts_voice, "model": settings.tts_model, "clips": clips}
