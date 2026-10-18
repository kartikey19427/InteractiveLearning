<p align="center"><img src="public/brand/askademy-light.svg" alt="Askademy" height="48" /></p>

# Askademy
An AI-Powered Interactive Learning Platform

Search any topic and get an interactive lesson: narrated animated chapters, hands-on activities (sliders, drag-and-match, step-by-step processes) and a quiz. New topics are researched on the web and written by an AI model (Google Gemini by default, or Claude), then saved in Postgres so the next search for the same topic opens instantly.

## AI Builder Cup 2026

- **Category:** Education.
- **Live demo:** _add the Cloud Run URL_
- **Video (under 3 min):** _add the YouTube / Vimeo / Drive link_

**Problem.** Most explanations online are a wall of text or a passive video. Learners understand faster when they can poke at an idea, but hand-built interactive lessons take an expert days per topic, so they exist for only a few popular subjects.

**What it does.** Anyone types any topic and gets a narrated, animated lesson with hands-on activities and a quiz in about a minute. Every lesson is saved, so the next learner who asks gets it instantly.

**How Gemini is used.** Gemini is the whole pipeline, not a chat box on the side:

1. **Understanding the ask:** Gemini (structured output) names the canonical topic, so different phrasings share one lesson.
2. **Research:** Gemini with Google Search grounding gathers notes and cites its sources in the lesson.
3. **Authoring:** one Gemini call writes the full lesson as JSON in a typed format (scenes, animations, activities, quiz). It is validated against a schema and a safe expression checker and sent back to Gemini for repair if anything fails, so generated content is never executed as code.
4. **Narration:** each chapter is recorded once, on demand, in the learner's chosen voice (Max via ElevenLabs by default, Gemini's voice as the fallback, then the browser's own); the player syncs every animation to the sentence timings.

**Built on Google Cloud.** The frontend and backend run on Cloud Run (one service, root `Dockerfile`); Gemini is the LLM for understanding, research grounding, lesson authoring and speech fallback; Supabase PostgreSQL stores lessons and narration. Planned for scale: Cloud Storage for audio, Cloud Tasks for generation jobs.

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

## Deploy the frontend and API together on Cloud Run

The root `Dockerfile` builds the Vite frontend and runs it with FastAPI in one Cloud Run service. The browser and API share one URL, so production requests to `/api/...` need no separate frontend proxy or CORS setup.

Cloud Run's local filesystem is temporary. Create a persistent PostgreSQL database (we use Supabase PostgreSQL), then set `DATABASE_URL` in the Cloud Run service to its connection URL. Set `GEMINI_API_KEY` as a secret (or environment variable for a personal demo); `TAVILY_API_KEY` is optional. Do not put secrets in the Dockerfile or commit them to Git.

From the repository root, deploy with the Google Cloud CLI:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud run deploy interactive-learning --source . --region asia-south1 --allow-unauthenticated --max 1 --memory 1Gi
```

When prompted, enable the required APIs and allow public access. In the Cloud Run service's **Edit and deploy new revision → Variables & Secrets**, add `DATABASE_URL` and `GEMINI_API_KEY`, then deploy the revision. Open the service URL shown by Cloud Run.

The free Cloud Run allowance is usage-limited. Database hosting and AI provider usage are separate and may have their own limits or charges. This app starts lesson-generation and narration jobs inside the web process, and generated audio is stored on the instance filesystem; those jobs and audio files are not durable across instance shutdowns. Use this setup for a demo, and move background jobs/audio to durable services for a dependable public deployment.

Cloud Run's default request-based CPU allocation also throttles these background jobs after the HTTP response returns. This can make generation much slower than localhost. Instance-based billing (`--no-cpu-throttling`) keeps CPU available while an instance exists, but increases billable time and does not prevent scale-to-zero or instance shutdown. For reliable generation, use a durable task worker or keep generation within an active request. Keep the database near the Cloud Run region to reduce database latency.
