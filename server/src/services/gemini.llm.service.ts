/**
 * Real Gemini LLM client implementing the LlmClient interface.
 *
 * Docs used:
 * - https://ai.google.dev/gemini-api/docs/generate-content/structured-output
 *   JSON Schema via responseJsonSchema + responseMimeType: application/json
 * - https://ai.google.dev/gemini-api/docs/structured-output
 * - https://ai.google.dev/gemini-api/docs/rate-limits — 429 / RESOURCE_EXHAUSTED
 * - SDK declarations: @google/genai v2.32.0, dist/genai.d.ts
 *   - GoogleGenAIOptions.apiKey (line 7653) — must be passed explicitly
 *   - GenerateContentConfig.abortSignal (line 6288)
 *   - GenerateContentConfig.responseMimeType (line 6354)
 *   - GenerateContentConfig.responseJsonSchema (line 6381) — preferred JSON Schema field
 *   - GenerateContentConfig.responseSchema (line 6365) — OpenAPI Schema; skipped
 *   - ApiError.status: HTTP number (line 553)
 */
import { GoogleGenAI } from '@google/genai';
import { MinutesSchema, type Minutes } from '../schemas/minutes.schema.js';
import { AppError } from '../utils/AppError.js';
import { MINUTES_SYSTEM_INSTRUCTION, buildMinutesUserMessage } from '../prompts/minutes.js';
import type { LlmClient } from './llm.service.js';

const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;

/**
 * JSON Schema (not OpenAPI Schema) for Gemini structured output.
 * Passed as GenerateContentConfig.responseJsonSchema; types must be lowercase.
 */
const MINUTES_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise title for the meeting.' },
    summary: { type: 'string', description: 'A brief summary of the meeting.' },
    decisions: {
      type: 'array',
      description: 'Only explicitly agreed decisions — no suggestions.',
      items: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['decision'],
      },
    },
    actionItems: {
      type: 'array',
      description: 'Tasks to be done. Use "Unassigned" and "Not specified" for missing fields.',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          assignee: { type: 'string' },
          deadline: { type: 'string' },
        },
        required: ['task', 'assignee', 'deadline'],
      },
    },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    pendingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['open_question', 'unassigned_task', 'needs_discussion'],
          },
        },
        required: ['issue', 'kind'],
      },
    },
    limitations: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['title', 'summary', 'decisions', 'actionItems', 'suggestions', 'pendingIssues', 'limitations'],
};

function errorClassName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' && err.name) {
    return err.name;
  }
  if (err instanceof Error) return err.name || 'Error';
  return 'UnknownError';
}

function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return undefined;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function extractGoogleStatus(err: unknown, message: string): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const nested = (err as { error?: { status?: unknown } }).error;
    if (nested && typeof nested.status === 'string' && nested.status) {
      return nested.status;
    }
  }
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null) {
      const status = (parsed as { error?: { status?: unknown } }).error?.status;
      if (typeof status === 'string' && status) return status;
    }
  } catch {
    // message is not JSON
  }
  const match = /got status:\s*([A-Z_]+)/.exec(message);
  return match?.[1];
}

function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]+/g, '[redacted]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, '$1[redacted]');
}

/** Single-line Gemini failure log. Never includes the API key, request body, prompt, or meeting text. */
export function formatGeminiFailureLog(details: {
  className: string;
  httpStatus: number | undefined;
  googleStatus: string | undefined;
  message: string;
  elapsedMs: number;
  model: string;
}): string {
  const message = redactSecrets(details.message).slice(0, 300);
  return [
    'GeminiFailure',
    `class=${details.className}`,
    `httpStatus=${details.httpStatus ?? 'n/a'}`,
    `googleStatus=${details.googleStatus ?? 'n/a'}`,
    `message=${message}`,
    `elapsedMs=${details.elapsedMs}`,
    `model=${details.model}`,
  ].join(' ');
}

export function logGeminiFailure(err: unknown, elapsedMs: number, model: string): string {
  const message = extractErrorMessage(err);
  const line = formatGeminiFailureLog({
    className: errorClassName(err),
    httpStatus: extractHttpStatus(err),
    googleStatus: extractGoogleStatus(err, message),
    message,
    elapsedMs,
    model,
  });
  console.error(line);
  return line;
}

function isAbortError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as { name?: unknown };
    return candidate.name === 'AbortError';
  }
  return false;
}

function isRateLimitError(err: unknown): boolean {
  if (extractHttpStatus(err) === 429) return true;
  const message = extractErrorMessage(err).toLowerCase();
  return (
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota')
  );
}

function extractRetryAfterMs(err: unknown): number {
  const msg = extractErrorMessage(err);
  const match = /retry.after.*?(\d+)s/i.exec(msg);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }
  return 0;
}

function isNetworkError(err: unknown): boolean {
  if (extractHttpStatus(err) !== undefined) return false;
  if (isAbortError(err)) return false;
  if (typeof err === 'object' && err !== null) {
    const candidate = err as { code?: unknown; cause?: { code?: unknown } };
    const code = candidate.code ?? candidate.cause?.code;
    if (typeof code === 'string') {
      return ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    }
  }
  if (err instanceof TypeError) return true;
  if (err instanceof Error && /fetch|network|socket|econnreset|enotfound/i.test(err.message)) {
    return true;
  }
  return extractHttpStatus(err) === undefined;
}

export function mapGeminiError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (isAbortError(err)) {
    return new AppError(504, 'LLM_TIMEOUT', 'The AI service took too long to respond.');
  }

  const httpStatus = extractHttpStatus(err);

  if (httpStatus === 429 || isRateLimitError(err)) {
    return new AppError(429, 'RATE_LIMITED', 'The AI service is busy. Please try again in a minute.');
  }

  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
    return new AppError(502, 'LLM_CONFIG_ERROR', 'The AI service is not configured correctly.');
  }

  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return new AppError(502, 'LLM_CONFIG_ERROR', 'The AI service is not configured correctly.');
  }

  if ((httpStatus !== undefined && httpStatus >= 500) || isNetworkError(err)) {
    return new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.');
  }

  return new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.');
}

function parseAndValidate(raw: string): { minutes: Minutes } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `JSON.parse failed: ${raw.slice(0, 200)}` };
  }
  const result = MinutesSchema.safeParse(parsed);
  if (!result.success) {
    return { error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { minutes: result.data };
}

export class GeminiLlmClient implements LlmClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, timeoutMs: number = DEFAULT_GEMINI_TIMEOUT_MS) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Call Gemini to generate structured minutes from a meeting transcript.
   * - Uses low temperature (0.2), JSON Schema controlled generation (responseJsonSchema).
   * - AbortController timeout of timeoutMs (GEMINI_TIMEOUT_MS, default 60000).
   * - Validates with zod; on failure retries ONCE with the validation error appended.
   * - 400/401/403/404 → LLM_CONFIG_ERROR (502)
   * - 429 → RATE_LIMITED (at most one retry after suggested delay, then surfaced)
   * - 5xx/network → LLM_UNAVAILABLE (502)
   * - AbortError timeout → LLM_TIMEOUT (504)
   * - Empty/safety-blocked candidate → LLM_EMPTY
   * - Persisted bad JSON after repair → LLM_BAD_OUTPUT
   */
  async generateMinutes(text: string): Promise<Minutes> {
    const userMessage = buildMinutesUserMessage(text);

    let rawJson: string;
    try {
      rawJson = await this.callGeminiTimed(userMessage);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isRateLimitError(err)) {
        const delayMs = extractRetryAfterMs(err);
        if (delayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, delayMs));
        }
        try {
          rawJson = await this.callGeminiTimed(userMessage);
        } catch (retryErr) {
          throw this.fail(retryErr);
        }
      } else {
        throw this.fail(err);
      }
    }

    const firstResult = parseAndValidate(rawJson);
    if ('minutes' in firstResult) {
      return firstResult.minutes;
    }

    const repairMessage = `${userMessage}\n\nYour previous response failed validation with these errors:\n${firstResult.error}\n\nPlease return a corrected JSON object that passes all constraints.`;

    let repairJson: string;
    try {
      repairJson = await this.callGeminiTimed(repairMessage);
    } catch (repairErr) {
      throw this.fail(repairErr);
    }

    const repairResult = parseAndValidate(repairJson);
    if ('minutes' in repairResult) {
      return repairResult.minutes;
    }

    throw new AppError(
      502,
      'LLM_BAD_OUTPUT',
      'The AI generated an invalid response after two attempts. Please try again.'
    );
  }

  private fail(err: unknown): AppError {
    if (err instanceof AppError) return err;
    return mapGeminiError(err);
  }

  /**
   * Runs _callGemini, logs exactly one diagnostic line on API/network/timeout failure,
   * then rethrows the original error (or AppError for empty/safety responses).
   */
  private async callGeminiTimed(userContent: string): Promise<string> {
    const started = Date.now();
    try {
      return await this._callGemini(userContent);
    } catch (err) {
      if (!(err instanceof AppError)) {
        logGeminiFailure(err, Date.now() - started, this.model);
      }
      throw err;
    }
  }

  /**
   * Single call to Gemini generateContent with AbortController timeout.
   * Throws ApiError on API errors, DOMException/AbortError on timeout.
   */
  private async _callGemini(userContent: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: userContent,
        config: {
          systemInstruction: MINUTES_SYSTEM_INSTRUCTION,
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseJsonSchema: MINUTES_RESPONSE_JSON_SCHEMA,
          abortSignal: controller.signal,
        },
      });

      const text = response.text;
      if (!text || text.trim() === '') {
        const candidate = response.candidates?.[0];
        const reason = candidate?.finishReason ?? 'UNKNOWN';
        if (reason === 'SAFETY' || reason === 'OTHER') {
          throw new AppError(502, 'LLM_EMPTY', `The AI response was blocked (${reason}). Please revise the meeting text.`);
        }
        throw new AppError(502, 'LLM_EMPTY', 'The AI returned an empty response. Please try again.');
      }

      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
