import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  GeminiTranscriber,
  GoogleGeminiAudioGateway,
  type GeminiAudioGateway,
  type RemoteAudioFile,
  type TranscriptionResult,
} from '../src/services/transcribe.service.js';
import { env } from '../src/config/env.js';

function makeGateway(overrides: Partial<GeminiAudioGateway> = {}): GeminiAudioGateway {
  const remote: RemoteAudioFile = {
    name: 'files/unit-test-audio',
    uri: 'https://example.invalid/audio',
    mimeType: 'audio/mpeg',
    state: 'PROCESSING',
  };
  return {
    upload: vi.fn().mockResolvedValue(remote),
    get: vi.fn().mockResolvedValue({ ...remote, state: 'ACTIVE' }),
    generate: vi.fn().mockResolvedValue({ text: 'A long enough transcript to complete this unit test.' }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Gemini audio transcription configuration and Files API polling', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['gemini-3.5-flash', 'gemini-3.5-flash-lite'])(
    'passes the shared Gemini 3.5 transcription config to generateContent for %s',
    async model => {
    const generateContent = vi.fn().mockResolvedValue({
      text: 'A long enough transcript to complete this unit test.',
      candidates: [{ finishReason: 'STOP' }],
    });
    const fakeSdk = {
      files: { upload: vi.fn(), get: vi.fn(), delete: vi.fn() },
      models: { generateContent },
    } as unknown as GoogleGenAI;
    const gateway = new GoogleGeminiAudioGateway(fakeSdk);
    const signal = new AbortController().signal;

    await gateway.generate(model, {
      uri: 'https://example.invalid/audio',
      mimeType: 'audio/mpeg',
    }, signal);

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]?.[0]).toMatchObject({
      model,
      config: {
        maxOutputTokens: 65_536,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        abortSignal: signal,
      },
    });
    expect(generateContent.mock.calls[0]?.[0].config).not.toHaveProperty('thinkingBudget');
    }
  );

  it('polls Files API until the third readiness check returns ACTIVE', async () => {
    vi.useFakeTimers();
    const active: RemoteAudioFile = {
      name: 'files/unit-test-audio',
      uri: 'https://example.invalid/audio',
      mimeType: 'audio/mpeg',
      state: 'ACTIVE',
    };
    const gateway = makeGateway({
      get: vi.fn()
        .mockResolvedValueOnce({ ...active, state: 'PROCESSING' })
        .mockResolvedValueOnce({ ...active, state: 'PROCESSING' })
        .mockResolvedValueOnce(active),
    });
    const transcription = new GeminiTranscriber(env.GEMINI_MODEL, 10_000, gateway).transcribe('fixture.mp3', 'audio/mpeg');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(transcription).resolves.toMatchObject({ text: expect.any(String) });
    expect(gateway.get).toHaveBeenCalledTimes(3);
    expect(gateway.generate).toHaveBeenCalledTimes(1);
    expect(gateway.delete).toHaveBeenCalledTimes(1);
  });

  it('stops polling at the transcription timeout and maps the timeout to LLM_TIMEOUT', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway({
      get: vi.fn().mockImplementation(async () => ({
        name: 'files/unit-test-audio',
        uri: 'https://example.invalid/audio',
        mimeType: 'audio/mpeg',
        state: 'PROCESSING',
      })),
    });
    const transcription = new GeminiTranscriber(env.GEMINI_MODEL, 3_000, gateway).transcribe('fixture.mp3', 'audio/mpeg');
    const rejection = expect(transcription).rejects.toMatchObject({ code: 'LLM_TIMEOUT', statusCode: 504 });

    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(gateway.get).toHaveBeenCalledTimes(2);
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(gateway.delete).toHaveBeenCalledTimes(1);
  });

  it('does not continue transcription when a Files API poll resolves after the timeout', async () => {
    vi.useFakeTimers();
    let resolveGet!: (file: RemoteAudioFile) => void;
    const gateway = makeGateway({
      get: vi.fn(() => new Promise<RemoteAudioFile>(resolve => { resolveGet = resolve; })),
    });
    const transcription = new GeminiTranscriber(env.GEMINI_MODEL, 1_500, gateway).transcribe('fixture.mp3', 'audio/mpeg');
    const rejection = expect(transcription).rejects.toMatchObject({ code: 'LLM_TIMEOUT', statusCode: 504 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    resolveGet({
      name: 'files/unit-test-audio',
      uri: 'https://example.invalid/audio',
      mimeType: 'audio/mpeg',
      state: 'ACTIVE',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(gateway.generate).not.toHaveBeenCalled();
    expect(gateway.delete).toHaveBeenCalledTimes(1);
  });

  it('maps a Files API FAILED state to TRANSCRIPTION_FAILED and deletes the remote file', async () => {
    const gateway = makeGateway({
      upload: vi.fn().mockResolvedValue({
        name: 'files/unit-test-audio',
        uri: 'https://example.invalid/audio',
        mimeType: 'audio/mpeg',
        state: 'FAILED',
      }),
    });

    await expect(new GeminiTranscriber(env.GEMINI_MODEL, 10_000, gateway).transcribe('fixture.mp3', 'audio/mpeg'))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.delete).toHaveBeenCalledTimes(1);
  });
});
