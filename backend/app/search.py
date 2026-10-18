"""Web search for the research step, via the Tavily API (tavily.com).

Tavily returns page excerpts we hand to the model, so research is grounded in
real pages regardless of which model provider writes the lesson.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

URL = "https://api.tavily.com/search"
# Forums and video sites make poor lesson sources.
EXCLUDE = ["reddit.com", "quora.com", "youtube.com", "tiktok.com", "facebook.com", "instagram.com", "pinterest.com", "x.com"]


class SearchUnavailable(Exception):
    pass


def enabled() -> bool:
    return bool(get_settings().tavily_api_key)


async def _search(client: httpx.AsyncClient, query: str) -> list[dict]:
    key = get_settings().tavily_api_key
    if not key:
        raise SearchUnavailable("No available Tavily key")
    res = await client.post(URL, json={
        "query": query,
        "search_depth": "advanced",
        "max_results": 6,
        "include_answer": False,
        "exclude_domains": EXCLUDE,
    }, headers={"Authorization": f"Bearer {key}"})
    if res.status_code in (401, 403):
        raise SearchUnavailable("Tavily rejected the API key")
    if res.status_code == 429 or res.status_code == 432:
        raise SearchUnavailable("Tavily usage limit reached")
    if res.status_code != 200:
        raise SearchUnavailable(f"Tavily returned {res.status_code}: {res.text[:200]}")
    return res.json().get("results") or []


async def search_topic(title: str, query: str) -> list[dict[str, str]]:
    """A few searches covering what the lesson needs. Returns [{title, url, content}]."""
    queries = [
        f"{title} explained",
        f"{title} stages mechanism how it works",
        f"{title} key numbers ranges conditions",
        f"{title} common misconceptions",
    ]
    if query.lower().strip() != title.lower().strip():
        queries.insert(0, query)
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            batches = await asyncio.gather(*(_search(client, q) for q in queries))
        except httpx.TransportError as e:
            raise SearchUnavailable("Couldn't reach Tavily") from e
    seen: dict[str, dict[str, str]] = {}
    for batch in batches:
        for r in batch:
            url, content = r.get("url"), (r.get("content") or "").strip()
            if url and content and url not in seen:
                seen[url] = {"title": r.get("title") or url, "url": url, "content": content[:2500]}
    return list(seen.values())[:20]
