"""Background lesson generation.

Jobs run as asyncio tasks inside the API process, limited by a semaphore. That's
enough for one server; move to a real queue (e.g. arq or Celery) when scaling out.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from .config import get_settings
from .db import Session, Topic
from .generator import GenerationError, research, write_lesson

log = logging.getLogger(__name__)

PENDING = ("queued", "researching", "writing", "checking")

_sem = asyncio.Semaphore(get_settings().max_concurrent_jobs)
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
        except GenerationError as e:
            # Includes missing keys and provider outages, each with a readable message.
            await _update(topic_id, status="failed", error=str(e), progress=None)
        except Exception:
            log.exception("lesson generation failed for topic %s", topic_id)
            await _update(topic_id, status="failed", progress=None, error="Something went wrong while building this lesson.")


async def resume_pending() -> None:
    """Restart jobs that were interrupted by a server restart."""
    async with Session() as s:
        ids = (await s.scalars(select(Topic.id).where(Topic.status.in_(PENDING)))).all()
    for topic_id in ids:
        enqueue(topic_id)
