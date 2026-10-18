"""Recorded narration for video chapters, generated once per lesson.

With an ElevenLabs key, each chapter is recorded separately and ElevenLabs
returns the time of every character, so sentence boundaries are exact.
Otherwise Gemini TTS is used, as below.

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
ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
ELEVEN_RATE = 24000
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


# Voices offered in the app's Voice menu: ElevenLabs voices suited to lessons.
# The first is the default; ELEVENLABS_VOICE_ID in .env can change which one that is.
VOICES = [
    {"id": "Gfpl8Yo74Is0W6cPUWWT", "name": "Max", "description": "American, made for e-learning and documentaries"},
    {"id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice", "description": "British, clear and engaging educator"},
    {"id": "onwK4e9ZLuTAKqWW03F9", "name": "Daniel", "description": "British, steady broadcaster"},
    {"id": "XrExE9yKIg1WjnnlVkGX", "name": "Matilda", "description": "American, knowledgeable and professional"},
    {"id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "description": "British, warm storyteller"},
]


# Free options: they never call ElevenLabs. "browser" uses the learner's own voice
# and makes no API calls at all; "charon" is Gemini's voice (free tier, daily limit).
FREE_VOICES = [
    {"id": "browser", "name": "Browser voice", "description": "Free, no credits. Uses this browser's own voice.", "badge": "Free, no credits"},
    {"id": "charon", "name": "Charon", "description": "Gemini's narrator. Free tier, limited daily.", "badge": "Free tier, limited daily"},
]
FREE_IDS = {v["id"] for v in FREE_VOICES}


def is_free(voice: str | None) -> bool:
    return voice in FREE_IDS


def pick_voice(voice: str | None) -> str:
    """A voice from the menu, or the default when none (or an unknown one) is asked for."""
    if voice in FREE_IDS or (voice and any(v["id"] == voice for v in VOICES)):
        return voice
    return get_settings().elevenlabs_voice_id


def narrator_target(voice: str | None = None) -> tuple[str, str] | None:
    """The (provider, voice) new recordings are made with, or None when no narrator is configured."""
    settings = get_settings()
    if voice == "browser":
        return None  # the browser's own voice: nothing is recorded
    if voice == "charon":
        return ("gemini", settings.tts_voice) if settings.gemini_api_key else None
    if settings.elevenlabs_api_key:
        return "elevenlabs", pick_voice(voice)
    if settings.gemini_api_key:
        return "gemini", settings.tts_voice
    return None


def _record_key(narration: dict) -> tuple[str, str]:
    # Recordings made before providers were recorded were all Gemini.
    return narration.get("provider", "gemini"), narration.get("voice", "")


def narration_is_current(narration: dict | None, lesson: dict, voice: str | None = None) -> bool:
    """Whether a lesson's saved recording matches the narrator in use, so nothing needs making.

    Lessons with no spoken steps never need a recording. Lessons with a recording
    from another voice (or a Gemini fallback while ElevenLabs is set) are re-recorded
    when someone opens them, never in bulk.
    """
    if not any(st.get("kind") == "video" for st in lesson.get("steps", [])):
        return True
    target = narrator_target(voice)
    if target is None or narration is None:
        return target is None
    return _record_key(narration) == target


def aligned_bounds(alignment: dict, sentences: list[str], duration: float) -> list[float] | None:
    """End time (s) of each sentence from ElevenLabs' per-character timings, or None if they don't line up."""
    ends = alignment.get("character_end_times_seconds") or []
    if len(ends) != len(" ".join(sentences)):
        return None
    out, pos = [], 0
    for x in sentences[:-1]:
        pos += len(x)
        # A sentence ends halfway through the pause before the next one starts.
        out.append((ends[pos - 1] + ends[pos]) / 2)
        pos += 1
    out.append(duration)
    return out if out == sorted(out) else None


async def _speak_eleven(client: httpx.AsyncClient, text: str, voice: str | None = None) -> tuple[bytes, dict]:
    settings = get_settings()
    url = ELEVEN_URL.format(voice=pick_voice(voice))
    body = {"text": text, "model_id": settings.elevenlabs_model}
    for attempt in range(4):
        res = await client.post(url, params={"output_format": f"pcm_{ELEVEN_RATE}"}, json=body)
        if res.status_code == 200:
            data = res.json()
            return base64.b64decode(data["audio_base64"]), data.get("alignment") or {}
        if "quota_exceeded" in res.text:
            raise QuotaExhausted("the ElevenLabs character allowance is used up")
        if res.status_code in (429, 500, 503) and attempt < 3:
            await asyncio.sleep(5 * (attempt + 1))
            continue
        raise NarrationError(f"ElevenLabs failed ({res.status_code}): {res.text[:200]}")
    raise NarrationError("ElevenLabs kept hitting the rate limit")


# One chapter's narration is short; if ElevenLabs takes longer than this to
# answer, treat it as not working and fall back.
ELEVEN_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


async def _narrate_eleven(slug: str, videos: list[dict], out_dir: Path, on_clip=None, voice: str | None = None) -> dict:
    """Record each chapter in turn; `on_clip(record)` gets the partial record after each one."""
    settings = get_settings()
    voice = pick_voice(voice)
    clips: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=ELEVEN_TIMEOUT, headers={"xi-api-key": settings.elevenlabs_api_key}) as client:
        for st in videos:
            pcm, alignment = await _speak_eleven(client, " ".join(st["narration"]), voice)
            duration = len(pcm) / 2 / ELEVEN_RATE
            bounds = aligned_bounds(alignment, st["narration"], duration) or sentence_bounds(pcm, ELEVEN_RATE, st["narration"])
            name = f"{st['id']}-elevenlabs-{voice}.wav"
            (out_dir / name).write_bytes(_wav(pcm, ELEVEN_RATE))
            clips[st["id"]] = {"url": f"/api/media/narration/{slug}/{name}", "bounds": [round(b, 3) for b in bounds]}
            log.info("narrated %s/%s with ElevenLabs (%.1fs)", slug, st["id"], duration)
            if on_clip:
                await on_clip({"provider": "elevenlabs", "voice": voice,
                               "model": settings.elevenlabs_model, "clips": dict(clips), "complete": False})
    return {"provider": "elevenlabs", "voice": voice, "model": settings.elevenlabs_model,
            "clips": clips, "complete": True}


async def narrate_lesson(slug: str, lesson: dict, on_clip=None, voice: str | None = None) -> dict:
    """Generate audio for every video step. Returns the narration record stored on the topic.

    Tries ElevenLabs first when its key is set, then Gemini (Charon) when its key is set.
    If neither works, the error goes up and the lesson plays with the browser voice.
    """
    settings = get_settings()
    if not settings.narrator:
        raise NarrationError("no text-to-speech API key")
    out_dir = MEDIA / "narration" / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    videos = [st for st in lesson.get("steps", []) if st.get("kind") == "video"]
    if not videos:
        return {"provider": "none", "voice": settings.tts_voice, "model": settings.tts_model, "clips": {}}
    if settings.elevenlabs_api_key:
        try:
            return await _narrate_eleven(slug, videos, out_dir, on_clip, voice)
        except (NarrationError, httpx.HTTPError) as e:
            # Bad key, unavailable voice, no credits, network trouble or a timeout:
            # fall back to the Gemini voice.
            log.warning("ElevenLabs narration failed for %s, using Gemini instead: %s", slug, e)
            if not settings.gemini_api_key:
                raise
    return await _narrate_gemini(slug, videos, out_dir)


async def _narrate_gemini(slug: str, videos: list[dict], out_dir: Path) -> dict:
    settings = get_settings()
    script = "\n\n".join(" ".join(st["narration"]) for st in videos)
    async with httpx.AsyncClient(timeout=600, headers={"X-goog-api-key": settings.gemini_api_key}) as client:
        pcm, rate = await _speak(client, script)
    clips: dict[str, dict] = {}
    for st, part in zip(videos, split_chapters(pcm, rate, [st["narration"] for st in videos])):
        part = _trim(part, rate)
        bounds = sentence_bounds(part, rate, st["narration"])
        name = f"{st['id']}-gemini-{settings.tts_voice}.wav"
        (out_dir / name).write_bytes(_wav(part, rate))
        clips[st["id"]] = {"url": f"/api/media/narration/{slug}/{name}", "bounds": [round(b, 3) for b in bounds]}
        log.info("narrated %s/%s (%.1fs)", slug, st["id"], bounds[-1])
    return {"provider": "gemini", "voice": settings.tts_voice, "model": settings.tts_model, "clips": clips}


async def narrate_chapter(slug: str, step: dict, voice: str | None = None) -> dict:
    """Record one chapter (on demand, when it's about to play). ElevenLabs first, then Gemini.

    Returns {"provider", "voice", "model", "clip"}; errors go up when neither works,
    and the chapter plays with the browser voice.
    """
    settings = get_settings()
    if not settings.narrator:
        raise NarrationError("no text-to-speech API key")
    out_dir = MEDIA / "narration" / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    if voice == "charon":
        # Charon is chosen on purpose: Gemini only, and no ElevenLabs call at all.
        if not settings.gemini_api_key:
            raise NarrationError("no Gemini key")
        rec = await _narrate_gemini(slug, [step], out_dir)
        return {**{k: rec[k] for k in ("provider", "voice", "model")}, "clip": rec["clips"][step["id"]]}
    if settings.elevenlabs_api_key:
        try:
            rec = await _narrate_eleven(slug, [step], out_dir, None, voice)
            return {**{k: rec[k] for k in ("provider", "voice", "model")}, "clip": rec["clips"][step["id"]]}
        except (NarrationError, httpx.HTTPError) as e:
            log.warning("ElevenLabs failed for %s/%s, using Gemini instead: %s", slug, step.get("id"), e)
            if not settings.gemini_api_key:
                raise
    rec = await _narrate_gemini(slug, [step], out_dir)
    return {**{k: rec[k] for k in ("provider", "voice", "model")}, "clip": rec["clips"][step["id"]]}
