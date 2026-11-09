/**
 * smoke:llm — sends a built-in 15-line sample meeting to the real Gemini API
 * and prints the formatted minutes.
 *
 * Run yourself: npm run smoke:llm
 * Requires server/.env with GEMINI_API_KEY and GEMINI_MODEL set.
 * Do NOT read, log or commit server/.env. This script reads from process.env only.
 */
import dotenv from 'dotenv';
import { GeminiLlmClient, logGeminiFailure } from '../services/gemini.llm.service.js';
import { formatMinutesToMarkdown } from '../services/minutesFormatter.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

dotenv.config();

const SAMPLE_MEETING = `
Team Sync — Product & Engineering, 2 November 2026

Attendees: Alice (PM), Bob (Backend), Carol (Frontend), Dave (QA)

Alice opened the meeting and summarised last week's progress.

Alice: The database schema review is complete. We agreed to adopt Mongoose with strict validation.
Bob: I'll finish the Conversation and Message models by Friday.
Carol: The React placeholder page is done. I'll hook it up to the real API once the Phase 1 endpoints land.
Dave: We should add integration tests before merging to main. Maybe we should also add a linter.
Alice: Adding a linter is a good suggestion but not a blocker; let's revisit after Phase 2.
Bob: There's an open question: which Gemini model should we use for audio transcription?
Alice: We haven't decided yet — we need to verify the free-tier limits first.
Dave: No deadlines were mentioned for the linter work.
Alice: Agreed — next steps are Bob finishes models, Carol connects the frontend, and Dave writes the first integration test by next Wednesday.
Alice: Meeting closed.
`.trim();

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return 60_000;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL;
  const timeoutMs = parseTimeoutMs(process.env.GEMINI_TIMEOUT_MS);

  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in server/.env');
    process.exit(1);
  }

  const client = new GeminiLlmClient(apiKey, model, timeoutMs);
  const minutes = await client.generateMinutes(SAMPLE_MEETING);
  console.log(formatMinutesToMarkdown(minutes));
}

main().catch((err: unknown) => {
  if (!(err instanceof AppError)) {
    logGeminiFailure(err, 0, env.GEMINI_MODEL);
  }
  process.exit(1);
});

