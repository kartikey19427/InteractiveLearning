"""Load the bundled example lesson so the player can be tried without an API key.

    uv run python -m app.seed_example
"""

import asyncio
import json
from pathlib import Path

from sqlalchemy import select

from .db import Session, Topic, TopicAlias, init_db
from .slugs import query_key

EXAMPLE = Path(__file__).parent / "prompts" / "example_lesson.json"


async def main() -> None:
    await init_db()
    lesson = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    async with Session() as s:
        topic = await s.scalar(select(Topic).where(Topic.slug == "water-cycle"))
        if topic is None:
            topic = Topic(slug="water-cycle", title="Water Cycle", query="where does rain come from")
            s.add(topic)
            await s.flush()
            s.add(TopicAlias(alias=query_key("water cycle"), topic_id=topic.id))
        topic.status, topic.lesson, topic.error, topic.progress = "ready", lesson, None, None
        await s.commit()
    print("Seeded /topic/water-cycle")


if __name__ == "__main__":
    asyncio.run(main())
