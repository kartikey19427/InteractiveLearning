# InteractiveLearning
An AI-Powered Interactive Learning Platform

Search any topic and get an interactive lesson: narrated animated chapters, hands-on activities (sliders, drag-and-match, step-by-step processes) and a quiz. New topics are researched on the web and written by an AI model (Google Gemini by default, or Claude), then saved in Postgres so the next search for the same topic opens instantly.

## How it works

1. **Search** (`POST /api/search`): the query is normalized and checked against saved aliases. On a miss, the model names the canonical topic (so "how do mushrooms make babies" and "mushroom life cycle" share one lesson) and the database is checked again.
2. **Generate** (background job, only for new topics): The topic is researched with [Tavily](https://tavily.com) web search, and the model turns the results into notes (without a Tavily key it falls back to Google Search grounding on Gemini, then to the model's own knowledge). The model then writes the lesson as JSON. The JSON is validated (`backend/app/lesson_schema.py` + an expression syntax check) and sent back for repair if anything fails.
3. **Narrate**: new lessons (and older ones the first time they're opened) are recorded once with a Gemini voice (Charon by default, `TTS_VOICE`), in a single request, then split into chapters and sentences at the pauses so the animation follows the audio exactly. With `ELEVENLABS_API_KEY` set, ElevenLabs records them instead (Max by default, `ELEVENLABS_VOICE_ID`), one chapter per request, with sentence timings taken from its per-character timestamps. If ElevenLabs fails (for example a 402 on the free plan), the Gemini voice is used instead. Lessons without a recording use the browser's voice.
4. **Play** (`/topic/:slug`): the React player renders any lesson file. Lessons are data only: scenes are built from a fixed toolkit of elements (shapes, labels, branching networks, particles, cycle diagrams) animated with a small safe expression language, so nothing generated is ever executed as code.

The lesson format is documented in `backend/app/prompts/lesson_format.md` (the same text the model gets) and typed in `src/lesson/types.ts`.

## Layout

```
src/                  React app (Vite + TypeScript)
  pages/              search page, topic page
  player/             lesson player, stage, activities
  lesson/             format types, expression language, scene renderer
backend/              FastAPI app
  app/main.py         API routes
  app/generator.py    name topic, research, write lesson
  app/providers/      Gemini (default) and Claude clients
  app/search.py       Tavily web search for research
  app/narration.py    recorded narration (ElevenLabs or Gemini TTS), saved under backend/media
  app/jobs.py         background generation
  app/prompts/        lesson format spec + example lesson
docker-compose.yml    Postgres
```

## Running locally

You need Node 20+, [uv](https://docs.astral.sh/uv/), and Docker.

```bash
# 1. Database
docker compose up -d

# 2. Backend (http://localhost:8000)
cd backend
cp .env.example .env        # then fill in GEMINI_API_KEY and TAVILY_API_KEY
uv run uvicorn app.main:app --reload --port 8000

# Optional: load a sample lesson that works without an API key
uv run python -m app.seed_example     # then open /topic/water-cycle

# 3. Frontend (http://localhost:5173), in another terminal
npm install
npm run dev
```

Without an API key, saved lessons still open, but new topics show a clear "no API key" message instead of generating.

To use Claude instead, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `backend/.env`. `GEMINI_MODEL` picks the Gemini model (default `gemini-flash-latest`).
