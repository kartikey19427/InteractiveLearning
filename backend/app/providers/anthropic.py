"""Claude via the Anthropic SDK."""

from __future__ import annotations

import os
from pathlib import Path

import anthropic
from pydantic import BaseModel

from ..config import get_settings
from .base import GenerationError, MissingCredentials, ProviderUnavailable, Reply, Turn

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _check_refusal(message) -> None:
    if message.stop_reason == "refusal":
        raise GenerationError("Claude declined to write a lesson on this topic.")


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        settings = get_settings()
        has_profile = (Path.home() / ".config" / "anthropic").exists()
        if not (settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
                or os.environ.get("ANTHROPIC_AUTH_TOKEN") or has_profile):
            raise MissingCredentials(
                "The server has no Anthropic API key yet, so new lessons can't be generated. "
                "Add ANTHROPIC_API_KEY to backend/.env and restart the server."
            )
        self.client = (anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
                       if settings.anthropic_api_key else anthropic.AsyncAnthropic())
        self.model = settings.claude_model

    async def _guard(self, coro):
        try:
            return await coro
        except anthropic.AuthenticationError as e:
            raise MissingCredentials("The server's Anthropic API key is invalid.") from e
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
            raise ProviderUnavailable("The AI service is busy or unreachable. Try again in a minute.") from e
        except anthropic.APIStatusError as e:
            raise GenerationError(f"The AI service returned an error: {e.message}") from e

    async def structured(self, system: str, prompt: str, schema: type[BaseModel]) -> BaseModel:
        response = await self._guard(self.client.beta.messages.parse(
            model=self.model,
            max_tokens=4000,
            output_config={"effort": "low"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
        ))
        _check_refusal(response)
        if response.parsed_output is None:
            raise GenerationError("Couldn't understand that search.")
        return response.parsed_output

    async def _stream(self, **kwargs):
        async with self.client.beta.messages.stream(
            model=self.model, thinking={"type": "adaptive"}, output_config={"effort": "high"},
            betas=[FALLBACK_BETA], fallbacks="default", **kwargs,
        ) as stream:
            return await stream.get_final_message()

    async def research(self, system: str, prompt: str) -> tuple[str, list[dict[str, str]]]:
        messages: list = [{"role": "user", "content": prompt}]
        found: dict[str, str] = {}
        message = None
        for _ in range(6):  # pause_turn continuations
            message = await self._guard(self._stream(
                max_tokens=32000,
                system=system,
                tools=[
                    {"type": "web_search_20260209", "name": "web_search", "max_uses": 8},
                    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5},
                ],
                messages=messages,
            ))
            _check_refusal(message)
            for block in message.content:
                if block.type == "web_search_tool_result" and isinstance(block.content, list):
                    for r in block.content:
                        if getattr(r, "url", None):
                            found.setdefault(r.url, getattr(r, "title", None) or r.url)
            if message.stop_reason != "pause_turn":
                break
            messages.append({"role": "assistant", "content": message.content})
        notes = "\n".join(b.text for b in (message.content if message else []) if b.type == "text").strip()
        return notes, [{"title": t, "url": u} for u, t in found.items()]

    async def complete(self, system: str, prompt: str) -> str:
        message = await self._guard(self._stream(
            max_tokens=32000, system=system, messages=[{"role": "user", "content": prompt}],
        ))
        _check_refusal(message)
        return "".join(b.text for b in message.content if b.type == "text").strip()

    async def write(self, system: str, turns: list[Turn], max_tokens: int | None = None) -> Reply:
        message = await self._guard(self._stream(
            max_tokens=max_tokens or 64000,
            # Stable across every lesson, so cache it.
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": t.role, "content": t.text} for t in turns],
        ))
        _check_refusal(message)
        text = "".join(b.text for b in message.content if b.type == "text")
        return Reply(text=text, truncated=message.stop_reason == "max_tokens")
