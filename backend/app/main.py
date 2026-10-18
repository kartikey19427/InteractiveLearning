from __future__ import annotations

import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import jobs
from .config import get_settings
from .db import AsyncSession, Topic, TopicAlias, get_session, init_db
from .generator import GenerationError, MissingCredentials, ProviderUnavailable, name_topic
from .narration import FREE_VOICES, MEDIA, VOICES, narrator_target, pick_voice
from .slugs import query_key, slugify

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    await jobs.resume_pending()
    yield


app = FastAPI(title="Askademy API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


MEDIA.mkdir(parents=True, exist_ok=True)
app.mount("/api/media", StaticFiles(directory=MEDIA), name="media")

# The production container places the Vite build here. API routes are declared
# below and take precedence; this fallback lets React Router handle page URLs.
WEB_DIST = Path(os.getenv("WEB_DIST", str(Path(__file__).resolve().parents[2] / "dist")))


class SearchIn(BaseModel):
    query: str = Field(min_length=2, max_length=200)


class SearchOut(BaseModel):
    slug: str
    status: str
    cached: bool


class TopicSummary(BaseModel):
    id: int
    slug: str
    title: str
    status: str
    updated_at: datetime


class TopicDetail(TopicSummary):
    query: str
    progress: str | None
    error: str | None
    # The lesson without chapter bodies: title, palette, sources and an outline of
    # chapters (with which ones are written). Chapters are fetched one at a time
    # from /steps/{i}, like a video stream; narration from /narration/{step_id}.
    lesson: dict | None


PLAYABLE = ("ready", "streaming", "stalled")


def lesson_meta(lesson: dict | None) -> dict | None:
    if not lesson:
        return None
    steps = lesson.get("steps") or []
    outline = lesson.get("outline") or [
        {"id": st.get("id"), "kind": st.get("kind"), "title": st.get("title"), "tag": st.get("tag")} for st in steps
    ]
    return {
        **{k: lesson.get(k) for k in ("title", "eyebrow", "summary", "palette", "functions", "sources", "note")},
        "outline": [{k: o.get(k) for k in ("id", "kind", "title", "tag")} for o in outline],
        "steps_ready": len(steps),
        "complete": lesson.get("complete", True) if lesson.get("outline") else True,
    }


def _summary(t: Topic) -> TopicSummary:
    return TopicSummary(id=t.id, slug=t.slug, title=t.title, status=t.status, updated_at=t.updated_at)


def _detail(t: Topic) -> TopicDetail:
    return TopicDetail(
        id=t.id, slug=t.slug, title=t.title, status=t.status, updated_at=t.updated_at,
        query=t.query, progress=t.progress, error=t.error,
        lesson=lesson_meta(t.lesson) if t.status in PLAYABLE else None,
    )


async def _add_alias(session: AsyncSession, alias: str, topic_id: int) -> None:
    if alias and not await session.get(TopicAlias, alias):
        session.add(TopicAlias(alias=alias, topic_id=topic_id))


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/search", response_model=SearchOut)
async def search(body: SearchIn, session: AsyncSession = Depends(get_session)):
    query = " ".join(body.query.split())
    key = query_key(query)

    # 1. Seen this exact search before?
    alias = await session.get(TopicAlias, key)
    if alias:
        topic = await session.get(Topic, alias.topic_id)
        if topic:
            return SearchOut(slug=topic.slug, status=topic.status, cached=topic.status == "ready")

    # 2. Ask Claude for the canonical topic so different phrasings share a lesson.
    try:
        named = await name_topic(query)
        if not named.learnable:
            raise HTTPException(422, "That doesn't look like a topic to learn about. Try describing a concept, process or event.")
        title, slug = named.title, named.slug
    except (MissingCredentials, ProviderUnavailable) as e:
        # Without the model (no key, outage) fall back to the literal search.
        log.warning("topic naming failed, using the raw query: %s", e)
        title, slug = query[:1].upper() + query[1:], slugify(key)
    except GenerationError as e:
        raise HTTPException(422, str(e)) from e
    if not slug:
        raise HTTPException(422, "Try a few more words.")

    # 3. Existing lesson under that name?
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    if topic:
        await _add_alias(session, key, topic.id)
        await session.commit()
        return SearchOut(slug=topic.slug, status=topic.status, cached=topic.status == "ready")

    # 4. New topic: save it and start generating.
    topic = Topic(slug=slug, title=title, query=query, status="queued", progress="Waiting to start…")
    session.add(topic)
    try:
        await session.flush()
        await _add_alias(session, key, topic.id)
        await session.commit()
    except IntegrityError:
        # Someone else created it at the same moment.
        await session.rollback()
        topic = await session.scalar(select(Topic).where(Topic.slug == slug))
        if topic is None:
            raise
        return SearchOut(slug=topic.slug, status=topic.status, cached=topic.status == "ready")

    jobs.enqueue(topic.id)
    return SearchOut(slug=topic.slug, status=topic.status, cached=False)


@app.get("/api/topics", response_model=list[TopicSummary])
async def list_topics(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Topic).order_by(Topic.updated_at.desc()).limit(60))
    return [_summary(t) for t in rows]


@app.get("/api/topics/{slug}", response_model=TopicDetail)
async def get_topic(slug: str, session: AsyncSession = Depends(get_session)):
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    if topic is None:
        raise HTTPException(404, "No lesson for this topic yet.")
    return _detail(topic)


async def _topic(session: AsyncSession, slug: str) -> Topic:
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    if topic is None or not topic.lesson:
        raise HTTPException(404, "No lesson for this topic yet.")
    return topic


_admin_header = APIKeyHeader(name="X-Admin-Key", auto_error=False)


async def require_admin(key: str | None = Depends(_admin_header)) -> None:
    expected = get_settings().admin_api_key
    if not expected:
        raise HTTPException(503, "Lesson deletion is not configured. Set ADMIN_API_KEY.")
    if not key or not secrets.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(401, "Invalid or missing admin key.")


async def _delete_topic(topic: Topic | None, session: AsyncSession) -> dict:
    if topic is None:
        raise HTTPException(404, "No lesson for this topic yet.")
    result = {"deleted": True, "id": topic.id, "slug": topic.slug}
    await jobs.cancel_topic(topic.id)
    # PostgreSQL also removes its search aliases via ON DELETE CASCADE.
    await session.delete(topic)
    await session.commit()
    return result


@app.delete("/api/topics/id/{topic_id}", dependencies=[Depends(require_admin)])
async def delete_topic_by_id(topic_id: int, session: AsyncSession = Depends(get_session)):
    """Permanently delete one lesson and its aliases using its numeric ID."""
    return await _delete_topic(await session.get(Topic, topic_id), session)


@app.delete("/api/topics/{slug}", dependencies=[Depends(require_admin)])
async def delete_topic_by_slug(slug: str, session: AsyncSession = Depends(get_session)):
    """Permanently delete one lesson and its aliases using the slug in its page URL."""
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    return await _delete_topic(topic, session)


PAIR = 2  # chapters are sent to the player in pairs: both must be written before either is sent


@app.get("/api/topics/{slug}/steps/{index}")
async def get_step(slug: str, index: int, session: AsyncSession = Depends(get_session)):
    """The pair of chapters containing `index`, once both are written (or the lesson is finished).

    The player never waits on a single chapter: it gets the pair as soon as it's complete, so the
    next pair is ready by the time the learner finishes the one before.
    """
    topic = await _topic(session, slug)
    steps = topic.lesson.get("steps") or []
    total = len(topic.lesson.get("outline") or steps)
    if not 0 <= index < total:
        raise HTTPException(404, "No such chapter.")
    lo = (index // PAIR) * PAIR
    hi = min(lo + PAIR, total)
    complete = bool(topic.lesson.get("complete", True)) and topic.status == "ready"
    written = min(hi, len(steps))
    if written >= hi or (complete and index < len(steps)):
        return {
            "ready": True,
            "chunk": [{"index": i, "step": steps[i]} for i in range(lo, written)],
            "functions": topic.lesson.get("functions") or {},
        }
    return {"ready": False, "stalled": topic.status in ("stalled", "failed") and index >= len(steps), "error": topic.error}


@app.get("/api/topics/{slug}/narration/{step_id}")
async def get_chapter_narration(slug: str, step_id: str, voice: str | None = None, session: AsyncSession = Depends(get_session)):
    """One chapter's recorded narration in `voice`, recording it now (once) if it isn't saved.

    state: ready (play `clip`), preparing (being recorded: wait), fallback (the chosen
    voice isn't working: play `clip` if it's an older voice's, else the browser voice),
    none (no voice service set up: browser voice).
    """
    topic = await _topic(session, slug)
    v = pick_voice(voice)
    if v == "browser" or narrator_target(v) is None:
        return {"state": "none", "clip": None}
    clip = jobs.chapter_clip(topic, v, step_id)
    if clip:
        return {"state": "ready", "clip": clip, "provider": narrator_target(v)[0], "voice": v}
    if v == "charon" and jobs.chapter_blocked(topic.id, v, step_id):
        # Charon failed for this chapter: straight to the browser voice, never ElevenLabs.
        return {"state": "fallback", "clip": None}
    step = next((st for st in topic.lesson.get("steps") or [] if st.get("id") == step_id), None)
    if step is not None and step.get("kind") == "video":
        jobs.enqueue_chapter(topic.id, v, step_id)
        if jobs.chapter_narrating(topic.id, v, step_id):
            return {"state": "preparing", "clip": None}
    elif step is None:
        return {"state": "preparing", "clip": None}  # not written yet
    if v == "charon":
        return {"state": "fallback", "clip": None}
    fb = topic.narration or {}
    return {"state": "fallback", "clip": (fb.get("clips") or {}).get(step_id), "provider": fb.get("provider"), "voice": fb.get("voice")}


@app.get("/api/voices")
async def list_voices():
    """Narration voices for the voice pickers. Samples are static files recorded once
    (public/voice-samples/, made by scripts/make_voice_menu_samples.py), so playing
    one never calls ElevenLabs."""
    if not get_settings().elevenlabs_api_key:
        return {"default": None, "voices": []}
    return {
        "default": pick_voice(None),
        "voices": [{**v, "badge": None, "sample_url": f"/voice-samples/{v['id']}.mp3"} for v in VOICES]
        + [{**v, "sample_url": ("/voice-samples/charon.wav" if v["id"] == "charon" else None)} for v in FREE_VOICES],
    }


@app.post("/api/topics/{slug}/retry", response_model=TopicDetail)
async def retry_topic(slug: str, session: AsyncSession = Depends(get_session)):
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    if topic is None:
        raise HTTPException(404, "No lesson for this topic yet.")
    if topic.status in ("failed", "stalled"):
        topic.status, topic.error, topic.progress = "queued", None, "Waiting to start…"
        await session.commit()
        jobs.enqueue(topic.id)
    return _detail(topic)


if WEB_DIST.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        root = WEB_DIST.resolve()
        requested = (root / path).resolve()
        if path and requested.is_relative_to(root) and requested.is_file():
            return FileResponse(requested)
        return FileResponse(WEB_DIST / "index.html")
