"""The small interface the lesson generator needs from a model provider."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel


class GenerationError(Exception):
    """A failure worth showing to the learner as-is."""


class MissingCredentials(GenerationError):
    pass


class ProviderUnavailable(GenerationError):
    """Rate limits, outages, network trouble: worth retrying later."""


@dataclass
class Turn:
    role: Literal["user", "assistant"]
    text: str


@dataclass
class Reply:
    text: str
    truncated: bool


class Provider(Protocol):
    name: str

    async def structured(self, system: str, prompt: str, schema: type[BaseModel]) -> BaseModel:
        """Short call returning an instance of `schema`."""
        ...

    async def research(self, system: str, prompt: str) -> tuple[str, list[dict[str, str]]]:
        """Web-grounded research. Returns notes and [{title, url}] sources."""
        ...

    async def complete(self, system: str, prompt: str) -> str:
        """Plain text answer with no tools (used to write notes from search results)."""
        ...

    async def write(self, system: str, turns: list[Turn], max_tokens: int | None = None) -> Reply:
        """Long-form generation over a conversation (used for lesson JSON and repairs)."""
        ...
