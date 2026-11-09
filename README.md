# MeetBrief AI

MeetBrief turns a meeting transcript or supported upload into structured minutes and grounded follow-up answers. It uses React/Vite, Express, TypeScript, MongoDB, and Gemini.

## Requirements and setup

- Node.js 26 or newer and npm.
- A MongoDB instance for local app use.
- A Gemini API key for real model calls. Never commit or display it.

Install each app's dependencies with `npm install` from `server/` and `client/`. Copy `server/.env.example` to `server/.env` and fill in values locally.

## Environment variables

`MONGODB_URI`, `GEMINI_MODEL`, and `GEMINI_API_KEY` are required for normal runtime. The stub LLM is available only when `NODE_ENV=test`; tests may also inject a mock with `setLlmClient`. Set `CLIENT_ORIGIN` to the client origin.

| Variable | Purpose / default |
|---|---|
| `PORT` | API port, default `5000` |
| `MONGODB_URI` | MongoDB connection string; required |
| `GEMINI_API_KEY` | Required for normal runtime; stub/mock clients are test-only |
| `GEMINI_MODEL` | Gemini model name; required |
| `GEMINI_LOG_ERROR_DETAILS` | `false` by default; keep false in shared/demo environments |
| `GEMINI_TIMEOUT_MS` | Gemini minutes/follow-up timeout, default `60000` |
| `GEMINI_TRANSCRIBE_TIMEOUT_MS` | Audio workflow timeout, default `300000` |
| `CLIENT_ORIGIN` | Allowed browser origin, default `http://localhost:5173` |
| `MAX_TEXT_CHARS` | Text input cap, default `200000`; longer input is rejected, not chunked |
| `MAX_AUDIO_MB` | Audio upload cap, default `25` |
| `MAX_DOC_MB` | Document upload cap, default `10` |

## Run locally

In separate terminals, run `npm run dev` from `server/` and `npm run dev` from `client/`. The server connects to MongoDB; the Vite dev server proxies API requests.

## Scripts

From `server/`: `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`, `npm run smoke:llm`, `npm run eval -- --help`.

From `client/`: `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`, `npm run preview`.

The smoke command calls Gemini and should be used only when deliberately spending quota. The evaluation runner supports `--only`, `--runs`, `--questions`, `--delay-ms`, `--force`, `--yes`, and `--dry-run`; see `eval/RESULTS_FORMAT.md`. Dry-run prints the plan and pacing estimate without loading API configuration. Review and correct all DRAFT expected files before running a real evaluation. The runner saves under ignored `eval/results/`, resumes by model, and stops on quota/rate-limit/overload/timeout.

## Limitations

- The browser's anonymous client ID is an ownership hint, not authentication.
- Uploaded files are temporary local files; the app is not a durable file store.
- Free-tier quotas are small and may change. Google may use free-tier submitted data to improve products, so use synthetic/sample data only. Rate limits and overload (including HTTP 503) can interrupt a request.
- Audio support is MP3 and WAV only. There is no OCR; PDFs need selectable text and are limited to 300 pages.
- Text above `MAX_TEXT_CHARS` is not chunked and is rejected.
- PDF extraction runs synchronously and can briefly block the server while a large document is processed.
