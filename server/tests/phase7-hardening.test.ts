import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { access, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { env, envSchema, formatEnvironmentIssues } from '../src/config/env.js';
import { GEMINI_API_KEY_REQUIRED_MESSAGE, requireGeminiApiKey } from '../src/config/geminiApiKey.js';
import { RATE_LIMITS } from '../src/config/rateLimits.js';
import { responseTimeout } from '../src/middleware/responseTimeout.js';
import { resetRateLimitStores } from '../src/middleware/rateLimit.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { uploadDirectory } from '../src/middleware/upload.js';
import * as llmService from '../src/services/llm.service.js';

afterEach(() => {
  app.locals.rateLimitsEnabled = false;
  resetRateLimitStores();
  vi.unstubAllEnvs();
});

describe('Phase 7 HTTP hardening', () => {
  it('defaults detailed Gemini error logging to false', () => {
    const parsed = envSchema.parse({ MONGODB_URI: 'mongodb://localhost/test', GEMINI_MODEL: 'test-model' });
    expect(parsed.GEMINI_LOG_ERROR_DETAILS).toBe('false');
  });

  it('requires a non-empty Gemini key outside tests and formats a value-free startup diagnostic', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const base = { MONGODB_URI: 'mongodb://localhost/test', GEMINI_MODEL: 'test-model' };
    for (const apiKey of [undefined, '']) {
      const parsed = envSchema.safeParse({ ...base, ...(apiKey === undefined ? {} : { GEMINI_API_KEY: apiKey }) });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const keyIssue = parsed.error.issues.find((issue) => issue.path.join('.') === 'GEMINI_API_KEY');
        expect(keyIssue?.message).toBe(GEMINI_API_KEY_REQUIRED_MESSAGE);
      }
    }
    expect(() => requireGeminiApiKey(undefined)).toThrow(GEMINI_API_KEY_REQUIRED_MESSAGE);
    expect(() => requireGeminiApiKey('   ')).toThrow(GEMINI_API_KEY_REQUIRED_MESSAGE);

    const keyCanary = 'KEY_VALUE_MUST_NEVER_APPEAR_IN_CONFIG_DIAGNOSTIC';
    const otherFailure = envSchema.safeParse({ GEMINI_API_KEY: keyCanary, MONGODB_URI: '', GEMINI_MODEL: 'test-model' });
    expect(otherFailure.success).toBe(false);
    if (!otherFailure.success) {
      const diagnostic = formatEnvironmentIssues(otherFailure.error.issues).join('\n');
      expect(diagnostic).toContain('MONGODB_URI');
      expect(diagnostic).not.toContain(keyCanary);
    }
  });

  it('allows keyless tests and keeps an explicitly set mock LLM client active', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const parsed = envSchema.parse({ MONGODB_URI: 'mongodb://localhost/test', GEMINI_MODEL: 'test-model' });
    expect(parsed.GEMINI_API_KEY).toBeUndefined();

    const previous = llmService.getLlmClient();
    const mockClient: llmService.LlmClient = {
      generateMinutes: vi.fn().mockResolvedValue(llmService.STUB_MINUTES),
      answerQuestion: vi.fn().mockResolvedValue('mock answer'),
    };
    llmService.setLlmClient(mockClient);
    expect(llmService.getLlmClient()).toBe(mockClient);
    llmService.setLlmClient(previous);
  });

  it('keeps rate limiting disabled in tests unless explicitly enabled', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    app.locals.rateLimitsEnabled = false;
    const results = await Promise.all(Array.from({ length: RATE_LIMITS.gemini.limit + 1 }, () =>
      request(app).post('/api/conversations/bad-id/retry').set('x-client-id', '11111111-1111-4111-8111-111111111111')));
    expect(results.every(result => result.status === 400)).toBe(true);
    expect(results.some(result => result.status === 429)).toBe(false);
  });

  it('sets no-store on all API responses, disables x-powered-by, and restricts CORS to CLIENT_ORIGIN', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', env.CLIENT_ORIGIN);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.headers['x-powered-by']).toBeUndefined();
    expect(allowed.headers['access-control-allow-origin']).toBe(env.CLIENT_ORIGIN);
    const rejected = await request(app).get('/api/health').set('Origin', 'https://attacker.example');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    expect(rejected.headers['cache-control']).toBe('no-store');
  });

  it('enforces the Gemini limiter after the configured threshold when explicitly enabled in tests', async () => {
    app.locals.rateLimitsEnabled = true;
    const results = await Promise.all(Array.from({ length: RATE_LIMITS.gemini.limit + 1 }, () =>
      request(app).post('/api/conversations/bad-id/retry').set('x-client-id', '11111111-1111-4111-8111-111111111111')));
    const blocked = results.filter(result => result.status === 429);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked[0].body.error.message).toBe('You are sending requests too quickly. Please wait a minute and try again.');
  }, 20_000);

  it('enforces the general API limiter after the configured threshold when explicitly enabled in tests', async () => {
    app.locals.rateLimitsEnabled = true;
    const results = await Promise.all(Array.from({ length: RATE_LIMITS.general.limit + 1 }, () => request(app).get('/api/health')));
    const blocked = results.filter(result => result.status === 429);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].body.error.code).toBe('TOO_MANY_REQUESTS');
  }, 30_000);

  it('returns one 504 on timeout and removes an upload temp file', async () => {
    const filePath = path.join(uploadDirectory, `timeout-${randomUUID()}.tmp`);
    await writeFile(filePath, 'temporary fixture');
    try {
      const testApp = express();
      testApp.post('/slow', responseTimeout(10), (req, res) => {
        Object.assign(req, { file: { path: filePath } });
        setTimeout(() => { if (!res.headersSent && !res.writableEnded) res.end('late'); }, 25);
      });
      const result = await request(testApp).post('/slow');
      expect(result.status).toBe(504);
      expect(result.body.error.code).toBe('LLM_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(result.text).not.toContain('late');
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await unlink(filePath).catch(() => undefined); }
  });

  it('silently ignores aborted requests and logs real errors as conversation ids and codes only', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const abortedReq = { aborted: true, params: { id: 'known-conversation-id' } } as unknown as Request;
    const responseMock = { destroyed: false, headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    errorHandler(new Error('request aborted with private content'), abortedReq, responseMock, vi.fn());
    expect(log).not.toHaveBeenCalled();
    expect(responseMock.json).not.toHaveBeenCalled();

    const realReq = { aborted: false, params: { id: 'known-conversation-id' } } as unknown as Request;
    errorHandler(new Error('private internal detail'), realReq, responseMock, vi.fn());
    expect(log).toHaveBeenCalledWith('ServerError conversationId=known-conversation-id code=INTERNAL_SERVER_ERROR');
    expect(String(log.mock.calls[0][0])).not.toContain('private');
    log.mockRestore();
  });
});
