"""Rotate fake credentials in files; never access cloud secrets or paid APIs."""

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app import config, jobs, main, narration, search
from app.db import engine
from app.providers.gemini import GeminiProvider


@pytest.fixture
def secrets_env(monkeypatch, tmp_path):
    for name in config.REFRESHABLE_KEYS:
        monkeypatch.setenv(name.upper(), "environment-fallback")
        monkeypatch.setenv(f"{name.upper()}_FILE", "")
    monkeypatch.setenv("SECRET_REFRESH_SECONDS", "60")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://learning:learning@localhost:5432/learning")
    config.get_settings.cache_clear()
    clock = [100.0]
    monkeypatch.setattr(config, "monotonic", lambda: clock[0])

    def mount(name, value="old-key"):
        path = tmp_path / name
        path.write_text(value, encoding="utf-8")
        monkeypatch.setenv(f"{name.upper()}_FILE", str(path))
        config.get_settings.cache_clear()
        return path

    yield clock, mount
    config.get_settings.cache_clear()


@pytest.mark.parametrize("name", config.REFRESHABLE_KEYS)
def test_file_rotation_overrides_environment_without_restarting(secrets_env, name):
    clock, mount = secrets_env
    path = mount(name, "old-key\n")
    old = config.get_settings()
    assert getattr(old, name) == "old-key"
    path.write_text("new-key\n", encoding="utf-8")
    clock[0] += 59
    assert getattr(config.get_settings(), name) == "old-key"
    clock[0] += 1
    assert getattr(config.get_settings(), name) == "new-key"
    assert getattr(old, name) == "old-key"  # in-flight settings are immutable snapshots
    assert config.get_settings().database_url == old.database_url
    from app.db import engine as same_engine
    assert same_engine is engine  # no database-pool replacement


def test_environment_only_setup_keeps_working(secrets_env):
    assert config.get_settings().gemini_api_key == "environment-fallback"


@pytest.mark.parametrize("failure", ["missing", "empty", "invalid-utf8"])
def test_failed_mount_does_not_revive_previous_or_environment_key(secrets_env, failure, caplog):
    clock, mount = secrets_env
    path = mount("admin_api_key", "private-previous-key")
    assert config.get_settings().admin_api_key == "private-previous-key"
    if failure == "missing":
        path.unlink()
    else:
        path.write_bytes(b"\xff" if failure == "invalid-utf8" else b" \n")
    clock[0] += 60
    assert config.get_settings().admin_api_key is None
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.require_admin("private-previous-key"))
    assert exc.value.status_code == 503
    assert "private-previous-key" not in caplog.text
    path.write_text("recovered-key", encoding="utf-8")
    clock[0] += 60
    assert config.get_settings().admin_api_key == "recovered-key"


def test_admin_rotation_rejects_old_key_and_accepts_new_key(secrets_env):
    clock, mount = secrets_env
    path = mount("admin_api_key")
    asyncio.run(main.require_admin("old-key"))
    path.write_text("new-key", encoding="utf-8")
    clock[0] += 60
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.require_admin("old-key"))
    assert exc.value.status_code == 401
    asyncio.run(main.require_admin("new-key"))


def test_rotated_narration_key_clears_previous_key_quota_backoff(secrets_env, monkeypatch):
    clock, mount = secrets_env
    path = mount("elevenlabs_api_key")
    monkeypatch.setattr(jobs, "_narration_credentials", None)
    monkeypatch.setattr(jobs, "_narration_failed", {})
    monkeypatch.setattr(jobs, "_chapter_failed", {})
    monkeypatch.setattr(jobs, "_quota_until", 0.0)
    jobs._refresh_narration_backoffs()
    jobs._quota_until = float("inf")
    jobs._narration_failed[(42, "charon")] = float("inf")
    jobs._chapter_failed[(42, "charon", "intro")] = float("inf")
    assert jobs.chapter_blocked(42, "charon", "intro")
    path.write_text("new-key", encoding="utf-8")
    clock[0] += 60
    assert not jobs.chapter_blocked(42, "charon", "intro")
    assert not jobs.narration_blocked(42, "charon")


def test_existing_gemini_provider_uses_rotated_key(secrets_env, monkeypatch):
    clock, mount = secrets_env
    path = mount("gemini_api_key")
    provider = GeminiProvider()
    headers = []

    def handle(request):
        headers.append(request.headers["X-goog-api-key"])
        return httpx.Response(200, json={})

    client_class = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_class(transport=httpx.MockTransport(handle), **kwargs))

    async def run():
        await provider._call({})
        path.write_text("new-key", encoding="utf-8")
        clock[0] += 60
        await provider._call({})

    asyncio.run(run())
    assert headers == ["old-key", "new-key"]


@pytest.mark.parametrize("name,header,run_request", [
    ("gemini_api_key", "X-goog-api-key", lambda c: narration._speak(c, "Hello.")),
    ("elevenlabs_api_key", "xi-api-key", lambda c: narration._speak_eleven(c, "Hello.")),
    ("tavily_api_key", "Authorization", lambda c: search._search(c, "plants")),
])
def test_reused_http_client_refreshes_credential(secrets_env, monkeypatch, name, header, run_request):
    clock, mount = secrets_env
    path = mount(name)
    headers = []

    def handle(request):
        headers.append(request.headers[header])
        return httpx.Response(200, json={
            "audio_base64": "AAAA", "alignment": {}, "results": [],
            "candidates": [{"content": {"parts": [{"inlineData": {"data": "AAAA", "mimeType": "audio/L16;rate=24000"}}]}}],
        })

    monkeypatch.setattr(narration, "_pcm", lambda *_: (b"\x00\x00", 24000))

    async def run():
        # Even a client with a stale default header must receive a fresh per-request value.
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle), headers={header: "stale-client-key"}) as client:
            await run_request(client)
            path.write_text("new-key", encoding="utf-8")
            clock[0] += 60
            await run_request(client)

    asyncio.run(run())
    prefix = "Bearer " if name == "tavily_api_key" else ""
    assert headers == [prefix + "old-key", prefix + "new-key"]
