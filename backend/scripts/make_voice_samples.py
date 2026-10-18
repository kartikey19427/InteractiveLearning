"""Generate narration samples in several Gemini voices for the /voices comparison page.

    uv run python scripts/make_voice_samples.py
"""

import base64
import io
import json
import sys
import time
import wave
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import Settings  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "public" / "voices"
LINE = (
    "Sunlight warms the surface of the ocean. The fastest water molecules escape into the air "
    "as an invisible gas called water vapor, and as that warm, moist air rises, it cools."
)
STYLE = "Read this like a warm, clear science narrator for curious teenagers:"
MODELS = {"gemini-3.8-flash-tts": "Gemini 3.8 Flash TTS", "gemini-3.8-flash-lite-tts": "Gemini 3.8 Flash Lite TTS"}
VOICES = [
    ("gemini-3.8-flash-tts", "Kore", "Firm, clear"),
    ("gemini-3.8-flash-tts", "Charon", "Informative, calm"),
    ("gemini-3.8-flash-tts", "Puck", "Upbeat"),
    ("gemini-3.8-flash-tts", "Aoede", "Breezy, relaxed"),
    ("gemini-3.8-flash-tts", "Zephyr", "Bright"),
    ("gemini-3.8-flash-tts", "Leda", "Youthful"),
    ("gemini-3.8-flash-tts", "Orus", "Firm, deeper"),
    ("gemini-3.8-flash-tts", "Fenrir", "Excitable"),
    ("gemini-3.8-flash-lite-tts", "Kore", "Firm, clear (cheaper model)"),
]


def to_wav(data: bytes, mime: str) -> bytes:
    if data[:4] == b"RIFF":
        return data
    rate = 24000
    if "rate=" in mime:
        rate = int(mime.split("rate=")[1].split(";")[0])
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data)
    return buf.getvalue()


def main() -> None:
    key = Settings().gemini_api_key
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    with httpx.Client(timeout=180, headers={"X-goog-api-key": key}) as client:
        for model, voice, desc in VOICES:
            name = f"{model}-{voice.lower()}.wav"
            entry = {"file": f"/voices/{name}", "provider": MODELS[model], "voice": voice, "description": desc}
            if (OUT / name).exists():
                manifest.append(entry)
                continue
            body = {
                "contents": [{"parts": [{"text": f"{STYLE} {LINE}"}]}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
                },
            }
            for _ in range(4):
                r = client.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", json=body)
                if r.status_code != 429:
                    break
                print(f"{voice}: rate limited, waiting…")
                time.sleep(40)
            if r.status_code != 200:
                print(f"{model}/{voice}: {r.status_code} {r.text[:200]}")
                continue
            part = r.json()["candidates"][0]["content"]["parts"][0]["inlineData"]
            (OUT / name).write_bytes(to_wav(base64.b64decode(part["data"]), part.get("mimeType", "")))
            manifest.append(entry)
            print("saved", name)
    (OUT / "manifest.json").write_text(json.dumps({"line": LINE, "samples": manifest}, indent=2))


if __name__ == "__main__":
    main()
