from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://learning:learning@localhost:5432/learning"
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
def get_settings() -> Settings:
    return Settings()
