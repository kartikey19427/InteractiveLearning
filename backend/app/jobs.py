"""Background lesson generation.

Jobs run as asyncio tasks inside the API process, limited by a semaphore. That's
enough for one server; move to a real queue (e.g. arq or Celery) when scaling out.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from sqlalchemy import select

from .config import get_settings
from .db import Session, Topic
from .generator import GenerationError, research, write_lesson
from .narration import NarrationError, QuotaExhausted, narrate_lesson, pick_voice, narration_is_current, narrator_target

log = logging.getLogger(__name__)

PENDING = ("queued", "researching", "writing", "checking")

_sem = asyncio.Semaphore(get_settings().max_concurrent_jobs)
# Text-to-speech has a tight per-minute limit, so narrate one lesson at a time.
_tts = asyncio.Semaphore(1)
_running: dict[int, asyncio.Task] = {}


async def _update(topic_id: int, **fields) -> None:
    async with Session() as s:
        topic = await s.get(Topic, topic_id)
        if topic is None:
            return
        for k, v in fields.items():
            setattr(topic, k, v)
        await s.commit()


def enqueue(topic_id: int) -> None:
    if topic_id in _running and not _running[topic_id].done():
        return
    task = asyncio.create_task(_run(topic_id))
    _running[topic_id] = task
    task.add_done_callback(lambda _: _running.pop(topic_id, None))


async def _run(topic_id: int) -> None:
    async with _sem:
        async with Session() as s:
            topic = await s.get(Topic, topic_id)
            if topic is None:
                return
            title, query = topic.title, topic.query

        async def progress(msg: str) -> None:
            await _update(topic_id, progress=msg)

        async def writing_progress(msg: str) -> None:
            # The writer only reports back when it is repairing a draft.
            await _update(topic_id, status="checking", progress=msg)

        try:
            await _update(topic_id, status="researching", progress="Searching for reliable sources…", error=None)
            notes, sources = await research(title, query, progress)
            await _update(topic_id, status="writing", research=notes, progress=f"Read {len(sources)} sources. Designing the lesson…")
            lesson = await write_lesson(title, query, notes, sources, writing_progress)
            await _update(topic_id, status="ready", lesson=lesson, progress=None, model=get_settings().model_name)
            log.info("lesson ready: %s", title)
            enqueue_narration(topic_id)
        except GenerationError as e:
            # Includes missing keys and provider outages, each with a readable message.
            await _update(topic_id, status="failed", error=str(e), progress=None)
        except Exception:
            log.exception("lesson generation failed for topic %s", topic_id)
            await _update(topic_id, status="failed", progress=None, error="Something went wrong while building this lesson.")


# Don't hammer the TTS quota: after a failure, wait before trying the same lesson and voice again.
_narration_failed: dict[tuple[int, str], float] = {}
# Chapters of a voice recorded so far, shared with the player while the rest are made.
_partial: dict[tuple[int, str], dict] = {}
_narrators: dict[tuple[int, str], asyncio.Task] = {}
_quota_until = 0.0


def recording_for(topic: Topic, voice: str | None) -> dict | None:
    """The saved recording of this lesson in `voice` (recordings are kept per voice)."""
    v = pick_voice(voice)
    rec = (topic.voices or {}).get(v)
    if rec:
        return rec
    # Recordings saved before voices were kept separately.
    n = topic.narration
    if n and n.get("provider") == "elevenlabs" and n.get("voice") == v:
        return n
    return None


def narrating(topic_id: int, voice: str | None = None) -> bool:
    task = _narrators.get((topic_id, pick_voice(voice)))
    return task is not None and not task.done()


def enqueue_narration(topic_id: int, voice: str | None = None) -> None:
    """Record a lesson in one voice: right after it's generated, or when someone opens it in that voice."""
    v = pick_voice(voice)
    if narrating(topic_id, v) or not get_settings().narrator or narration_blocked(topic_id, v):
        return
    key = (topic_id, v)
    task = asyncio.create_task(_narrate(topic_id, v))
    _narrators[key] = task
    task.add_done_callback(lambda _: _narrators.pop(key, None))


async def _narrate(topic_id: int, voice: str) -> None:
    key = (topic_id, voice)
    async with _tts:
        async with Session() as s:
            topic = await s.get(Topic, topic_id)
            if topic is None or topic.lesson is None:
                return
            if narration_is_current(recording_for(topic, voice) or topic.narration, topic.lesson, voice):
                return
            slug, lesson = topic.slug, topic.lesson
        global _quota_until

        async def on_clip(record: dict) -> None:
            _partial[key] = record

        try:
            narration = await narrate_lesson(slug, lesson, on_clip, voice)
            if narration.get("provider") == "elevenlabs":
                async with Session() as s:
                    topic = await s.get(Topic, topic_id)
                    if topic is not None:
                        topic.voices = {**(topic.voices or {}), voice: narration}
                        await s.commit()
            else:
                # Saved from the fallback voice: keep it as the stand-in, and try the
                # chosen voice again later, not on every visit.
                await _update(topic_id, narration=narration)
                _narration_failed[key] = time.time()
        except QuotaExhausted as e:
            _narration_failed[key] = time.time()
            if get_settings().narrator == "gemini":
                # Only Gemini is configured and its daily allowance is gone: pause everywhere.
                _quota_until = time.time() + 3 * 3600
            log.warning("narration out of allowance for %s: %s", slug, e)
        except (NarrationError, httpx.HTTPError) as e:
            _narration_failed[key] = time.time()
            # Lessons still play with the browser voice.
            log.warning("narration failed for %s: %s", slug, e)
        finally:
            _partial.pop(key, None)


def partial_narration(topic_id: int, voice: str | None = None) -> dict | None:
    return _partial.get((topic_id, pick_voice(voice)))


def narration_blocked(topic_id: int, voice: str | None = None) -> bool:
    """This voice recently failed (or ran out) for this lesson, so the fallback plays for now."""
    now = time.time()
    return now < _quota_until or now - _narration_failed.get((topic_id, pick_voice(voice)), 0) < 1800


async def resume_pending() -> None:
    """Restart jobs that were interrupted by a server restart."""
    async with Session() as s:
        ids = (await s.scalars(select(Topic.id).where(Topic.status.in_(PENDING)))).all()
    for topic_id in ids:
        enqueue(topic_id)
