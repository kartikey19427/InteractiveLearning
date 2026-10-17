from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import jobs
from .config import get_settings
from .db import AsyncSession, Topic, TopicAlias, get_session, init_db
from .generator import GenerationError, MissingCredentials, ProviderUnavailable, name_topic
from .narration import MEDIA, narration_is_current, narrator_target
from .slugs import query_key, slugify

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    await jobs.resume_pending()
    yield


app = FastAPI(title="Interactive Learning API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


MEDIA.mkdir(parents=True, exist_ok=True)
app.mount("/api/media", StaticFiles(directory=MEDIA), name="media")


class SearchIn(BaseModel):
    query: str = Field(min_length=2, max_length=200)


class SearchOut(BaseModel):
    slug: str
    status: str
    cached: bool


class TopicSummary(BaseModel):
    slug: str
    title: str
    status: str
    updated_at: datetime


class TopicDetail(TopicSummary):
    query: str
    progress: str | None
    error: str | None
    lesson: dict | None
    narration: dict | None
    # True while recorded narration is being made; the page keeps polling until it lands.
    narrating: bool = False
    # ready: play `narration`. preparing: the preferred voice is being recorded; play its
    # chapters as they appear in `narration`. fallback/none: play `narration` if any
    # (an older voice), else the browser voice.
    narration_state: str = "none"


def _summary(t: Topic) -> TopicSummary:
    return TopicSummary(slug=t.slug, title=t.title, status=t.status, updated_at=t.updated_at)


def _detail(t: Topic) -> TopicDetail:
    return TopicDetail(
        slug=t.slug, title=t.title, status=t.status, updated_at=t.updated_at,
        query=t.query, progress=t.progress, error=t.error,
        lesson=t.lesson if t.status == "ready" else None,
        narrating=jobs.narrating(t.id),
        **_narration_view(t),
    )


def _narration_view(t: Topic) -> dict:
    """Which recording the player should use: the preferred voice, its chapters so far, or a fallback."""
    if t.status != "ready" or not t.lesson:
        return {"narration": None, "narration_state": "none"}
    if narrator_target() is None:
        return {"narration": t.narration, "narration_state": "none"}
    if narration_is_current(t.narration, t.lesson):
        return {"narration": t.narration, "narration_state": "ready"}
    if jobs.narrating(t.id):
        return {"narration": jobs.partial_narration(t.id), "narration_state": "preparing"}
    # The preferred voice failed recently: an older recording, if any, stands in.
    return {"narration": t.narration, "narration_state": "fallback"}


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
    if topic.status == "ready" and not narration_is_current(topic.narration, topic.lesson or {}):
        # Opening a lesson records it with the preferred voice (once, never in bulk). The player
        # waits for it chapter by chapter and only uses an older voice if recording fails.
        jobs.enqueue_narration(topic.id)
    return _detail(topic)


@app.post("/api/topics/{slug}/retry", response_model=TopicDetail)
async def retry_topic(slug: str, session: AsyncSession = Depends(get_session)):
    topic = await session.scalar(select(Topic).where(Topic.slug == slug))
    if topic is None:
        raise HTTPException(404, "No lesson for this topic yet.")
    if topic.status == "failed":
        topic.status, topic.error, topic.progress = "queued", None, "Waiting to start…"
        await session.commit()
        jobs.enqueue(topic.id)
    return _detail(topic)
