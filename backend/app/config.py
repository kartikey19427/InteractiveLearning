from functools import lru_cache
import logging
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


log = logging.getLogger(__name__)
REFRESHABLE_KEYS = ("gemini_api_key", "elevenlabs_api_key", "tavily_api_key", "admin_api_key")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://learning:learning@localhost:5432/learning"
    # Required only for destructive maintenance endpoints.
    admin_api_key: str | None = None
    # Mounted secret files override environment keys and are reread on demand.
    gemini_api_key_file: str | None = None
    elevenlabs_api_key_file: str | None = None
    tavily_api_key_file: str | None = None
    admin_api_key_file: str | None = None
    secret_refresh_seconds: float = Field(default=60, ge=1, le=3600)
    # Which model provider writes lessons.
    llm_provider: Literal["gemini", "anthropic"] = "gemini"

    gemini_api_key: str | None = None
    gemini_model: str = "gemini-flash-latest"
    # Recorded narration (Gemini text-to-speech).
    tts_model: str = "gemini-3.8-flash-tts"
    tts_voice: str = "Charon"
    # Recorded narration with ElevenLabs, used instead of Gemini when its key is set.
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str = "Gfpl8Yo74Is0W6cPUWWT"  # Max - Elearning and Documentary
    elevenlabs_model: str = "eleven_multilingual_v2"

    # Web search for research (tavily.com). Without it, the provider's own search is used.
    tavily_api_key: str | None = None

    # Read by the Anthropic SDK from the environment when unset here.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5-5"

    # How many lessons may generate at the same time.
    max_concurrent_jobs: int = 2
    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def narrator(self) -> Literal["elevenlabs", "gemini"] | None:
        """Who records narration, or None when no key is set (lessons use the browser voice)."""
        if self.elevenlabs_api_key:
            return "elevenlabs"
        return "gemini" if self.gemini_api_key else None

    @property
    def model_name(self) -> str:
        return self.gemini_model if self.llm_provider == "gemini" else self.claude_model


@lru_cache
def _base_settings() -> Settings:
    return Settings()


class SecretFiles:
    """Cache reads briefly; always reopen the path so Cloud Run can resolve latest."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, str | None]] = {}
        self._lock = Lock()

    def read(self, path: str, interval: float) -> str | None:
        with self._lock:
            now = monotonic()
            cached = self._cache.get(path)
            if cached is not None and now < cached[0]:
                return cached[1]
            try:
                value = Path(path).read_text(encoding="utf-8").strip() or None
            except (OSError, UnicodeError):
                # Do not leak credentials or silently revive an old environment key.
                log.warning("Could not read a mounted API secret; credential unavailable until the next refresh")
                value = None
            self._cache[path] = (monotonic() + interval, value)
            return value

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


_secret_files = SecretFiles()


def get_settings() -> Settings:
    base = _base_settings()
    overrides = {
        name: _secret_files.read(path, base.secret_refresh_seconds)
        for name in REFRESHABLE_KEYS
        if (path := getattr(base, f"{name}_file"))
    }
    return base.model_copy(update=overrides) if overrides else base


def _clear_settings_cache() -> None:
    _base_settings.cache_clear()
    _secret_files.clear()


# Preserve the cache reset used by local scripts and existing tests.
get_settings.cache_clear = _clear_settings_cache
