"""Delete API authorization and targeting, without touching a real lesson database."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app import jobs, main
from app.db import Topic


def request(monkeypatch, path, *, key=None, configured="test-admin-key", topic=None):
    session = SimpleNamespace(
        get=AsyncMock(return_value=topic), scalar=AsyncMock(return_value=topic),
        delete=AsyncMock(), commit=AsyncMock(),
    )
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(admin_api_key=configured))
    cancel = AsyncMock()
    monkeypatch.setattr(jobs, "cancel_topic", cancel)

    async def session_override():
        yield session

    async def run():
        main.app.dependency_overrides[main.get_session] = session_override
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
                return await client.delete(path, headers={"X-Admin-Key": key} if key is not None else {})
        finally:
            main.app.dependency_overrides.pop(main.get_session, None)

    return asyncio.run(run()), session, cancel


@pytest.mark.parametrize("key,configured,status", [(None, "test-admin-key", 401), ("wrong", "test-admin-key", 401), ("test-admin-key", None, 503)])
def test_delete_requires_configured_admin_key(monkeypatch, key, configured, status):
    response, session, cancel = request(monkeypatch, "/api/topics/id/42", key=key, configured=configured)
    assert response.status_code == status
    session.get.assert_not_awaited()
    session.delete.assert_not_awaited()
    cancel.assert_not_awaited()


@pytest.mark.parametrize("path", ["/api/topics/id/42", "/api/topics/photosynthesis-process"])
def test_delete_targets_requested_lesson(monkeypatch, path):
    topic = Topic(id=42, slug="photosynthesis-process")
    response, session, cancel = request(monkeypatch, path, key="test-admin-key", topic=topic)
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "id": 42, "slug": "photosynthesis-process"}
    cancel.assert_awaited_once_with(42)
    session.delete.assert_awaited_once_with(topic)
    session.commit.assert_awaited_once()
    if "/id/" in path:
        session.get.assert_awaited_once_with(Topic, 42)
    else:
        statement = session.scalar.await_args.args[0]
        assert statement.compile().params == {"slug_1": "photosynthesis-process"}


def test_missing_lesson_returns_404_without_deleting(monkeypatch):
    response, session, cancel = request(monkeypatch, "/api/topics/id/42", key="test-admin-key")
    assert response.status_code == 404
    session.delete.assert_not_awaited()
    session.commit.assert_not_awaited()
    cancel.assert_not_awaited()


def test_list_and_detail_expose_numeric_id():
    topic = Topic(id=42, slug="photosynthesis-process", title="Photosynthesis", query="photosynthesis", status="ready", updated_at=datetime.now(timezone.utc))
    assert main._summary(topic).id == 42
    assert main._detail(topic).id == 42


def test_cancel_stops_only_requested_lesson_jobs_and_caches(monkeypatch):
    async def run():
        tasks = [asyncio.create_task(asyncio.Event().wait()) for _ in range(4)]
        monkeypatch.setattr(jobs, "_running", {42: tasks[0], 99: tasks[3]})
        monkeypatch.setattr(jobs, "_narrators", {(42, "a"): tasks[1]})
        monkeypatch.setattr(jobs, "_chapter_tasks", {(42, "a", "intro"): tasks[2]})
        for name in ("_narration_failed", "_partial", "_chapter_failed"):
            monkeypatch.setattr(jobs, name, {(42, "a"): {}, (99, "a"): {}})
        try:
            await jobs.cancel_topic(42)
            assert all(t.cancelled() for t in tasks[:3])
            assert not tasks[3].done()
            assert 99 in jobs._running
            for name in ("_narration_failed", "_partial", "_chapter_failed"):
                assert list(getattr(jobs, name)) == [(99, "a")]
        finally:
            tasks[3].cancel()
            await asyncio.gather(tasks[3], return_exceptions=True)

    asyncio.run(run())
