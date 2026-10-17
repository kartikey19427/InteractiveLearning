"""Google Gemini over its REST API (generativelanguage.googleapis.com)."""

from __future__ import annotations

import asyncio
import json
import re
import logging

import httpx
from pydantic import BaseModel

from ..config import get_settings
from .base import GenerationError, MissingCredentials, ProviderUnavailable, Reply, Turn

log = logging.getLogger(__name__)

BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiProvider:
    name = "gemini"

    def __init__(self) -> None:
        settings = get_settings()
        if not settings.gemini_api_key:
            raise MissingCredentials(
                "The server has no Gemini API key yet, so new lessons can't be generated. "
                "Add GEMINI_API_KEY to backend/.env and restart the server."
            )
        self.key = settings.gemini_api_key
        self.model = settings.gemini_model

    async def _call(self, body: dict) -> dict:
        url = f"{BASE}/{self.model}:generateContent"
        headers = {"X-goog-api-key": self.key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=20)) as client:
            for attempt in range(4):
                try:
                    res = await client.post(url, headers=headers, json=body)
                except httpx.TransportError as e:
                    if attempt == 3:
                        raise ProviderUnavailable("Couldn't reach Gemini. Check the server's internet connection.") from e
                    await asyncio.sleep(2 ** attempt)
                    continue
                if res.status_code == 200:
                    return res.json()
                detail = _error_message(res)
                if res.status_code in (401, 403) or "API_KEY" in detail or "API key" in detail:
                    raise MissingCredentials(f"Gemini rejected the API key: {detail}")
                if res.status_code == 404:
                    raise GenerationError(f"Gemini model '{self.model}' was not found. Check GEMINI_MODEL in backend/.env.")
                if res.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                    log.warning("Gemini %s, retrying: %s", res.status_code, detail)
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                if res.status_code == 429:
                    raise ProviderUnavailable("Gemini's rate limit was reached. Try again in a minute.")
                raise GenerationError(f"Gemini returned an error ({res.status_code}): {detail}")
        raise ProviderUnavailable("Gemini didn't respond.")

    @staticmethod
    def _text(data: dict) -> tuple[str, str]:
        block = (data.get("promptFeedback") or {}).get("blockReason")
        if block:
            raise GenerationError(f"Gemini declined this request ({block}).")
        candidates = data.get("candidates") or []
        if not candidates:
            raise GenerationError("Gemini returned no answer.")
        cand = candidates[0]
        finish = cand.get("finishReason", "")
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"):
            raise GenerationError(f"Gemini declined to write this ({finish.lower()}).")
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        return text, finish

    async def structured(self, system: str, prompt: str, schema: type[BaseModel]) -> BaseModel:
        data = await self._call({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseJsonSchema": schema.model_json_schema(),
                "maxOutputTokens": 4096,
            },
        })
        text, _ = self._text(data)
        try:
            return schema.model_validate(json.loads(text))
        except (ValueError, TypeError) as e:
            raise GenerationError("Couldn't understand that search.") from e

    async def research(self, system: str, prompt: str) -> tuple[str, list[dict[str, str]]]:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "tools": [{"google_search": {}}],
            "generationConfig": {"maxOutputTokens": 32768},
        }
        try:
            data = await self._call(body)
        except ProviderUnavailable:
            # Search grounding has its own quota (none on some free-tier keys). Fall back to
            # the model's own knowledge rather than failing the lesson.
            log.warning("Google Search grounding unavailable; researching without live search")
            body.pop("tools")
            data = await self._call(body)
            text, _ = self._text(data)
            return text.strip(), _listed_sources(text)
        text, _ = self._text(data)
        sources: dict[str, str] = {}
        meta = (data["candidates"][0].get("groundingMetadata") or {})
        for chunk in meta.get("groundingChunks") or []:
            web = chunk.get("web") or {}
            if web.get("uri"):
                sources.setdefault(web["uri"], web.get("title") or web["uri"])
        return text.strip(), [{"title": t, "url": u} for u, t in sources.items()] or _listed_sources(text)

    async def complete(self, system: str, prompt: str) -> str:
        data = await self._call({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": 32768},
        })
        return self._text(data)[0].strip()

    async def write(self, system: str, turns: list[Turn], max_tokens: int | None = None) -> Reply:
        data = await self._call({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {"role": "model" if t.role == "assistant" else "user", "parts": [{"text": t.text}]} for t in turns
            ],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": max_tokens or 65536},
        })
        text, finish = self._text(data)
        return Reply(text=text, truncated=finish == "MAX_TOKENS")


def _listed_sources(text: str) -> list[dict[str, str]]:
    """Sources the notes list as "- Title: URL" (used when there is no grounding metadata)."""
    out: dict[str, str] = {}
    for title, url in re.findall(r"^\s*[-*]\s*(.+?):\s*(https?://\S+)\s*$", text, re.M):
        out.setdefault(url.rstrip(").,"), title.strip())
    return [{"title": t, "url": u} for u, t in out.items()]


def _error_message(res: httpx.Response) -> str:
    try:
        return res.json().get("error", {}).get("message", res.text)[:300]
    except ValueError:
        return res.text[:300]
