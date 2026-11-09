import { readFile } from 'node:fs/promises';
import { createPartFromUri, createUserContent, FileState, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';
import { formatGeminiFailureLog, mapGeminiError } from './gemini.llm.service.js';

export interface TranscriptionResult {
  text: string;
  finishReason?: string;
  blocked?: boolean;
}

export interface TranscriberClient {
  transcribe(filePath: string, mimeType: string): Promise<TranscriptionResult>;
}

export interface RemoteAudioFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

export interface GeminiAudioGateway {
  upload(filePath: string, mimeType: string, signal: AbortSignal): Promise<RemoteAudioFile>;
  get(name: string, signal: AbortSignal): Promise<RemoteAudioFile>;
  generate(
    model: string,
    file: RemoteAudioFile,
    signal: AbortSignal
  ): Promise<TranscriptionResult>;
  delete(name: string): Promise<void>;
}

const MAX_OUTPUT_TOKENS = 65_536;
const FILE_POLL_INTERVAL_MS = 1_000;
const TRANSCRIPTION_PROMPT = `Produce a verbatim transcript only, in the language spoken. Do not summarize, add commentary, or invent words. Mark unclear audio as [inaudible]. If distinct voices are clear, you may label them Speaker 1, Speaker 2, and so on, but never guess real names.`;

export class GoogleGeminiAudioGateway implements GeminiAudioGateway {
  constructor(private readonly ai: GoogleGenAI) {}

  async upload(filePath: string, mimeType: string, signal: AbortSignal): Promise<RemoteAudioFile> {
    return this.ai.files.upload({ file: filePath, config: { mimeType, abortSignal: signal } });
  }

  async get(name: string, signal: AbortSignal): Promise<RemoteAudioFile> {
    return this.ai.files.get({ name, config: { abortSignal: signal } });
  }

  async generate(model: string, file: RemoteAudioFile, signal: AbortSignal): Promise<TranscriptionResult> {
    if (!file.uri || !file.mimeType) throw new Error('Uploaded audio file is missing its URI or MIME type');
    const response: GenerateContentResponse = await this.ai.models.generateContent({
      model,
      contents: createUserContent([
        TRANSCRIPTION_PROMPT,
        createPartFromUri(file.uri, file.mimeType),
      ]),
      config: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        abortSignal: signal,
      },
    });
    const candidate = response.candidates?.[0];
    return {
      text: response.text ?? '',
      finishReason: candidate?.finishReason,
      blocked: Boolean(response.promptFeedback?.blockReason) || candidate?.finishReason === 'SAFETY',
    };
  }

  async delete(name: string): Promise<void> {
    await this.ai.files.delete({ name });
  }
}

function requestStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
}

function isRetryableGeminiError(error: unknown): boolean {
  const status = requestStatus(error);
  if (status === 429 || status === 503) return true;
  if (error instanceof Error) return /resource_exhausted|\b429\b|\b503\b|service unavailable/i.test(error.message);
  return false;
}

function retryDelayMs(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  const match = /retry.after.*?(\d+)s/i.exec(message);
  return match ? Number.parseInt(match[1] ?? '0', 10) * 1000 : 0;
}

function abortError(): Error {
  const error = new Error('Audio transcription timed out');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function withOneTransientRetry<T>(
  run: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRetryableGeminiError(error)) throw error;
    const delay = retryDelayMs(error);
    if (delay > 0) await wait(delay, signal);
    if (signal.aborted) throw abortError();
    return run();
  }
}

export class GeminiTranscriber implements TranscriberClient {
  private readonly gateway: GeminiAudioGateway;

  constructor(
    private readonly model: string,
    private readonly timeoutMs: number,
    gateway?: GeminiAudioGateway
  ) {
    this.gateway = gateway ?? new GoogleGeminiAudioGateway(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' }));
  }

  async transcribe(filePath: string, mimeType: string): Promise<TranscriptionResult> {
    const started = Date.now();
    const controller = new AbortController();
    let remoteFile: RemoteAudioFile | undefined;
    let deletion: Promise<void> | undefined;
    let timedOut = false;
    const deleteRemoteFile = (): Promise<void> => {
      if (!remoteFile?.name) return Promise.resolve();
      deletion ??= this.gateway.delete(remoteFile.name).catch(() => undefined);
      return deletion;
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(abortError());
      }, this.timeoutMs);
    });

    const operation = (async (): Promise<TranscriptionResult> => {
      const uploaded = await withOneTransientRetry(
        () => this.gateway.upload(filePath, mimeType, controller.signal),
        controller.signal
      );
      remoteFile = uploaded;
      if (timedOut) {
        await deleteRemoteFile();
        throw abortError();
      }
      if (!uploaded.name || !uploaded.uri || !uploaded.mimeType) {
        throw new Error('Gemini Files API returned incomplete audio file metadata');
      }

      let readyFile = uploaded;
      while (readyFile.state !== FileState.ACTIVE && readyFile.state !== 'ACTIVE') {
        if (readyFile.state === FileState.FAILED || readyFile.state === 'FAILED') {
          throw AppError.transcriptionFailed('The audio file could not be processed. Try another recording.');
        }
        await wait(FILE_POLL_INTERVAL_MS, controller.signal);
        readyFile = await withOneTransientRetry(
          () => this.gateway.get(uploaded.name!, controller.signal),
          controller.signal
        );
        if (controller.signal.aborted) throw abortError();
      }

      if (controller.signal.aborted) throw abortError();
      return withOneTransientRetry(
        () => this.gateway.generate(this.model, readyFile, controller.signal),
        controller.signal
      );
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (!(error instanceof AppError)) {
        const className = error instanceof Error ? error.name : 'UnknownError';
        console.error(formatGeminiFailureLog({
          className,
          httpStatus: requestStatus(error),
          googleStatus: undefined,
          message: 'audio transcription request failed',
          elapsedMs: Date.now() - started,
          model: this.model,
        }));
      }
      throw mapGeminiError(error);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await deleteRemoteFile();
    }
  }
}

class UnconfiguredTranscriber implements TranscriberClient {
  async transcribe(): Promise<TranscriptionResult> {
    throw new AppError(502, 'LLM_CONFIG_ERROR', 'The AI service is not configured correctly.');
  }
}

let activeTranscriber: TranscriberClient = env.GEMINI_API_KEY
  ? new GeminiTranscriber(env.GEMINI_MODEL, env.GEMINI_TRANSCRIBE_TIMEOUT_MS)
  : new UnconfiguredTranscriber();

export function getTranscriberClient(): TranscriberClient {
  return activeTranscriber;
}

export function setTranscriberClient(client: TranscriberClient): void {
  activeTranscriber = client;
}

export function resetTranscriberClient(): void {
  activeTranscriber = env.GEMINI_API_KEY
    ? new GeminiTranscriber(env.GEMINI_MODEL, env.GEMINI_TRANSCRIBE_TIMEOUT_MS)
    : new UnconfiguredTranscriber();
}

export interface TranscribedUpload {
  text: string;
  sourceType: 'audio';
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function transcribeUploadedAudio(file: Express.Multer.File): Promise<TranscribedUpload> {
  const extension = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
  if (extension !== '.mp3' && extension !== '.wav') {
    throw AppError.unsupportedFileType(
      'This audio format is not supported yet. Please convert it to MP3 or WAV.'
    );
  }
  if (file.size > env.MAX_AUDIO_MB * 1024 * 1024) {
    throw AppError.payloadTooLarge('PAYLOAD_TOO_LARGE', 'The uploaded audio exceeds the maximum file size.');
  }

  const mimeType = file.mimetype.toLowerCase();
  const acceptedMimeTypes = extension === '.mp3'
    ? new Set(['audio/mpeg', 'audio/mp3', 'application/octet-stream', ''])
    : new Set(['audio/wav', 'audio/x-wav', 'application/octet-stream', '']);
  if (!acceptedMimeTypes.has(mimeType)) {
    throw AppError.invalidFile('The audio content does not match its file type.');
  }

  const bytes = await readFile(file.path);
  const isMp3 = extension === '.mp3' && (
    bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
    (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  );
  const isWav = extension === '.wav' && bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (!bytes.length || (!isMp3 && !isWav)) {
    throw AppError.invalidFile('The uploaded audio file is empty or invalid.');
  }

  const canonicalMime = extension === '.mp3' ? 'audio/mpeg' : 'audio/wav';
  let result: TranscriptionResult;
  try {
    result = await getTranscriberClient().transcribe(file.path, canonicalMime);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mapGeminiError(error);
  }

  const trimmed = result.text.trim();
  if (result.finishReason === 'MAX_TOKENS') {
    throw AppError.transcriptionFailed('This recording is too long to transcribe in one go. Please upload a shorter recording.');
  }
  if (result.blocked || isRefusal(trimmed) || trimmed.length < 30) {
    throw AppError.transcriptionFailed();
  }

  return {
    text: trimmed,
    sourceType: 'audio',
    originalFilename: sanitizeFilename(file.originalname),
    mimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

function isRefusal(text: string): boolean {
  return /^(?:i(?:'m| am) (?:sorry|unable)|i cannot|i can't|as an ai\b|i am not able)/i.test(text);
}
