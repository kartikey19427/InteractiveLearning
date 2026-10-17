from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import get_settings

engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Topic(Base):
    """One lesson per canonical topic. The lesson JSON is the cache."""

    __tablename__ = "topics"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    # The search that first created this topic.
    query: Mapped[str] = mapped_column(Text)
    # queued -> researching -> writing -> checking -> ready | failed
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    progress: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    research: Mapped[str | None] = mapped_column(Text, nullable=True)
    lesson: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=utcnow)


class TopicAlias(Base):
    """Other ways people searched for a topic, so repeat searches skip the model."""

    __tablename__ = "topic_aliases"

    alias: Mapped[str] = mapped_column(String(200), primary_key=True)
    topic_id: Mapped[int] = mapped_column(ForeignKey("topics.id", ondelete="CASCADE"), index=True)


async def init_db() -> None:
    # Fine for a young project; switch to Alembic migrations once the schema settles.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session():
    async with Session() as session:
        yield session


__all__ = ["AsyncSession", "Session", "Topic", "TopicAlias", "get_session", "init_db", "utcnow"]
