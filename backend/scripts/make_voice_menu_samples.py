"""Record the Voice menu's demo clips once, as static files in public/voice-samples/.

    uv run python scripts/make_voice_menu_samples.py

Each voice reads the same short learning sentence. The files are committed, so
the app never calls ElevenLabs to play a sample. Existing files are skipped.
"""

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import Settings  # noqa: E402
from app.narration import VOICES  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "public" / "voice-samples"
LINE = "Every raindrop has made a long journey. Let's follow water from the ocean into the sky, and back again."


def main() -> None:
    s = Settings()
    if not s.elevenlabs_api_key:
        sys.exit("Set ELEVENLABS_API_KEY in backend/.env first.")
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=60, headers={"xi-api-key": s.elevenlabs_api_key}) as client:
        for v in VOICES:
            path = OUT / f"{v['id']}.mp3"
            if path.exists():
                print("have", path.name)
                continue
            res = client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{v['id']}",
                params={"output_format": "mp3_44100_64"},
                json={"text": LINE, "model_id": s.elevenlabs_model},
            )
            if res.status_code != 200:
                print(v["name"], res.status_code, res.text[:200])
                continue
            path.write_bytes(res.content)
            print("saved", v["name"], path.name, len(res.content), "bytes")


if __name__ == "__main__":
    main()
