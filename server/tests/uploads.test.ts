import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer, request as rawRequest } from 'node:http';
import mongoose from 'mongoose';
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/app.js';
import { Conversation } from '../src/models/Conversation.js';
import { Message } from '../src/models/Message.js';
import { AppError } from '../src/utils/AppError.js';
import { env } from '../src/config/env.js';
import { cleanupStaleUploadFiles, uploadDirectory } from '../src/middleware/upload.js';
import { MAX_PDF_PAGES } from '../src/services/extract.service.js';
import { sanitizeFilename } from '../src/utils/sanitizeFilename.js';
import { setLlmClient, StubLlmClient, STUB_MINUTES, type LlmClient } from '../src/services/llm.service.js';
import {
  GeminiTranscriber,
  resetTranscriberClient,
  setTranscriberClient,
  type GeminiAudioGateway,
  type RemoteAudioFile,
  type TranscriberClient,
  type TranscriptionResult,
} from '../src/services/transcribe.service.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/meetbrief_test';
const CLIENT_ID = '66666666-6666-4666-8666-666666666666';
const MEETING_TEXT = 'The team reviewed the release schedule and agreed that Maya will send the final proposal next Thursday.';
const TRANSCRIPT = 'The design group reviewed the release timeline and agreed that Jordan will share the revised schedule next Friday.';

function makeMp3Fixture(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

function makeWavFixture(sampleData = Buffer.alloc(800, 128)): Buffer {
  const wav = Buffer.alloc(44 + sampleData.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + sampleData.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(sampleData.length, 40);
  sampleData.copy(wav, 44);
  return wav;
}

function makeAudioGateway(
  result: TranscriptionResult,
  overrides: Partial<GeminiAudioGateway> = {}
): GeminiAudioGateway {
  const remote: RemoteAudioFile = {
    name: 'files/test-audio',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/test-audio',
    mimeType: 'audio/mpeg',
    state: 'ACTIVE',
  };
  return {
    upload: vi.fn().mockResolvedValue(remote),
    get: vi.fn().mockResolvedValue(remote),
    generate: vi.fn().mockResolvedValue(result),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setMockTranscriber(result: TranscriptionResult): ReturnType<typeof vi.fn> {
  const transcribe = vi.fn().mockResolvedValue(result);
  const client: TranscriberClient = { transcribe };
  setTranscriberClient(client);
  return transcribe;
}

function makePdf(text?: string): Buffer {
  const literal = text?.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = literal
    ? `BT /F1 12 Tf 72 720 Td (${literal}) Tj ET`
    : 'BT /F1 12 Tf 72 720 Td ET';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

function makeMultiPagePdf(pageCount: number): Buffer {
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 3);
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageIds.map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents [] >>'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

function upload(buffer: Buffer, filename: string, contentType?: string) {
  const req = request(app).post('/api/conversations').set('x-client-id', CLIENT_ID);
  return req.attach('file', buffer, { filename, ...(contentType ? { contentType } : {}) });
}

async function expectNoTempFiles(): Promise<void> {
  expect(await readdir(uploadDirectory)).toEqual([]);
}

describe('Phase 5 - TXT and PDF uploads', () => {
  beforeAll(async () => {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    await Conversation.syncIndexes();
    await Message.syncIndexes();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Message.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await Message.deleteMany({});
    setLlmClient(new StubLlmClient());
    resetTranscriberClient();
  });

  afterEach(async () => {
    resetTranscriberClient();
    await expectNoTempFiles();
  });

  it('accepts a small TXT, normalizes BOM and line endings, and stores metadata with no transcript in the user message', async () => {
    const input = Buffer.from(`\uFEFF${MEETING_TEXT}\r\nFinal\0 note.`, 'utf8');
    const result = await upload(input, 'meeting.txt', 'text/plain');
    expect(result.status).toBe(201);
    const conversationId = result.body.data.conversation.id as string;
    const conversation = await Conversation.findById(conversationId);
    expect(conversation?.sourceType).toBe('txt');
    expect(conversation?.sourceText).toBe(`${MEETING_TEXT}\nFinal note.`);
    expect(conversation?.originalFilename).toBe('meeting.txt');
    const userMessage = await Message.findOne({ conversationId, role: 'user' });
    expect(userMessage?.content).toBe('Uploaded file: meeting.txt');
    expect(userMessage?.content).not.toContain(MEETING_TEXT);
    expect(userMessage?.attachments.map(item => ({ name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes })))
      .toEqual([{ name: 'meeting.txt', mimeType: 'text/plain', sizeBytes: input.length }]);
  });

  it('rejects an empty TXT with INVALID_FILE and saves nothing', async () => {
    const result = await upload(Buffer.alloc(0), 'empty.txt', 'text/plain');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects a whitespace-only TXT with INVALID_FILE and saves nothing', async () => {
    const result = await upload(Buffer.from(' \r\n\t  ', 'utf8'), 'blank.txt', 'text/plain');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects a non-UTF-8 TXT with INVALID_FILE and saves nothing', async () => {
    const result = await upload(Buffer.from([0xc3, 0x28, 0xff]), 'broken.txt', 'text/plain');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('extracts a selectable-text PDF and stores its source and attachment metadata', async () => {
    const pdfText = 'The team reviewed the release schedule and agreed to follow up next Thursday.';
    const pdf = makePdf(pdfText);
    const result = await upload(pdf, 'meeting.pdf', 'application/pdf');
    expect(result.status).toBe(201);
    const conversationId = result.body.data.conversation.id as string;
    const conversation = await Conversation.findById(conversationId);
    expect(conversation?.sourceType).toBe('pdf');
    expect(conversation?.sourceText).toBe(pdfText);
    expect(conversation?.originalFilename).toBe('meeting.pdf');
    const userMessage = await Message.findOne({ conversationId, role: 'user' });
    expect(userMessage?.content).toBe('Uploaded file: meeting.pdf');
    expect(userMessage?.attachments.map(item => ({ name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes })))
      .toEqual([{ name: 'meeting.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length }]);
  });

  it('rejects a blank PDF with NO_EXTRACTABLE_TEXT and saves nothing', async () => {
    const result = await upload(makePdf(), 'blank.pdf', 'application/pdf');
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('NO_EXTRACTABLE_TEXT');
    expect(result.body.error.message).toContain('scanned or image-only');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects a corrupt PDF as INVALID_FILE without saving anything or hanging', async () => {
    const result = await upload(Buffer.from('%PDF-1.4\nthis is not a PDF document', 'ascii'), 'corrupt.pdf', 'application/pdf')
      .timeout({ response: 3000 });
    expect(result.status).toBe(400);
    expect(['INVALID_FILE', 'NO_EXTRACTABLE_TEXT']).toContain(result.body.error.code);
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects PDFs above MAX_PDF_PAGES with PAYLOAD_TOO_LARGE and saves nothing', async () => {
    const pdf = makeMultiPagePdf(MAX_PDF_PAGES + 1);
    const result = await upload(pdf, 'too-many-pages.pdf', 'application/pdf');
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(result.body.error.message).toBe('This PDF has too many pages. Please upload a shorter document.');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects an executable renamed to PDF based on the PDF magic bytes', async () => {
    const result = await upload(Buffer.from('MZ executable fixture', 'ascii'), 'renamed.pdf', 'application/pdf');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('maps an oversized multipart upload to PAYLOAD_TOO_LARGE', async () => {
    const tooLarge = Buffer.alloc(env.MAX_DOC_MB * 1024 * 1024 + 1, 0x61);
    const result = await upload(tooLarge, 'large.txt', 'text/plain');
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(result.body.error.message).not.toMatch(/multer|unexpected|limit_file/i);
    expect(await Conversation.countDocuments()).toBe(0);
  });

  it.each(['notes.exe', 'recording.m4a'])('rejects unsupported file %s with UNSUPPORTED_FILE_TYPE', async filename => {
    const contentType = filename.endsWith('.m4a') ? 'audio/m4a' : 'application/octet-stream';
    const result = await upload(Buffer.from('unsupported fixture'), filename, contentType);
    expect(result.status).toBe(415);
    expect(result.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    if (filename.endsWith('.m4a')) expect(result.body.error.message).toContain('convert it to MP3 or WAV');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it.each([
    ['meeting.mp3', 'audio/mpeg', makeMp3Fixture],
    ['meeting.wav', 'audio/wav', makeWavFixture],
  ])('transcribes a valid %s and stores only its transcript and attachment metadata', async (filename, mimeType, fixture) => {
    const transcribe = setMockTranscriber({ text: TRANSCRIPT });
    const bytes = fixture();
    const result = await upload(bytes, filename, mimeType);
    expect(result.status).toBe(201);
    const id = result.body.data.conversation.id as string;
    const conversation = await Conversation.findById(id);
    expect(conversation?.sourceType).toBe('audio');
    expect(conversation?.sourceText).toBe(TRANSCRIPT);
    expect(conversation?.originalFilename).toBe(filename);
    const userMessage = await Message.findOne({ conversationId: id, role: 'user' });
    expect(userMessage?.content).toBe(`Uploaded file: ${filename}`);
    expect(userMessage?.content).not.toContain(TRANSCRIPT);
    expect(userMessage?.attachments.map(item => ({ name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes })))
      .toEqual([{ name: filename, mimeType, sizeBytes: bytes.length }]);
    expect(transcribe).toHaveBeenCalledWith(expect.any(String), filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
  });

  it('rejects an executable renamed to MP3 based on the audio magic bytes', async () => {
    const result = await upload(Buffer.from('MZ executable fixture', 'ascii'), 'renamed.mp3', 'audio/mpeg');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects an empty audio file and saves nothing', async () => {
    const result = await upload(Buffer.alloc(0), 'empty.mp3', 'audio/mpeg');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_FILE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('maps an oversized audio upload to PAYLOAD_TOO_LARGE before saving anything', async () => {
    const tooLarge = Buffer.alloc(env.MAX_AUDIO_MB * 1024 * 1024 + 1, 0);
    const result = await upload(tooLarge, 'large.wav', 'audio/wav');
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it.each([
    ['empty transcript', { text: '' }],
    ['short transcript', { text: 'A few words only.' }],
    ['refusal', { text: "I'm sorry, I cannot transcribe this audio." }],
    ['truncated transcript', { text: TRANSCRIPT, finishReason: 'MAX_TOKENS' }],
  ])('rejects an %s before creating a conversation and deletes its remote file', async (_label, transcription) => {
    const gateway = makeAudioGateway(transcription);
    setTranscriberClient(new GeminiTranscriber('gemini-2.5-flash', 1000, gateway));
    const result = await upload(makeMp3Fixture(), 'meeting.mp3', 'audio/mpeg');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('TRANSCRIPTION_FAILED');
    expect(result.body.error).not.toHaveProperty('conversationId');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
    expect(gateway.delete).toHaveBeenCalledWith('files/test-audio');
    expect(gateway.delete).toHaveBeenCalledTimes(1);
  });

  it('maps a transcription timeout to 504 LLM_TIMEOUT and deletes the remote file', async () => {
    const gateway = makeAudioGateway({ text: TRANSCRIPT }, {
      generate: vi.fn((_model: string, _file: RemoteAudioFile, signal: AbortSignal): Promise<TranscriptionResult> => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })),
    });
    setTranscriberClient(new GeminiTranscriber('gemini-2.5-flash', 20, gateway));
    const result = await upload(makeMp3Fixture(), 'timeout.mp3', 'audio/mpeg');
    expect(result.status).toBe(504);
    expect(result.body.error.code).toBe('LLM_TIMEOUT');
    expect(result.body.error).not.toHaveProperty('conversationId');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(gateway.delete).toHaveBeenCalledWith('files/test-audio');
  });

  it('retries one transcription 429 then returns RATE_LIMITED without saving and deletes the remote file', async () => {
    const rateLimit = Object.assign(new Error('quota exhausted'), { status: 429 });
    const gateway = makeAudioGateway({ text: TRANSCRIPT }, {
      generate: vi.fn().mockRejectedValue(rateLimit),
    });
    setTranscriberClient(new GeminiTranscriber('gemini-2.5-flash', 1000, gateway));
    const result = await upload(makeMp3Fixture(), 'limited.mp3', 'audio/mpeg');
    expect(result.status).toBe(429);
    expect(result.body.error.code).toBe('RATE_LIMITED');
    expect(result.body.error).not.toHaveProperty('conversationId');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(gateway.generate).toHaveBeenCalledTimes(2);
    expect(gateway.delete).toHaveBeenCalledWith('files/test-audio');
  });

  it('deletes remote files on success and generation failure, and ignores remote-delete failures', async () => {
    const successfulGateway = makeAudioGateway({ text: TRANSCRIPT }, {
      delete: vi.fn().mockRejectedValue(new Error('remote cleanup unavailable')),
    });
    await expect(new GeminiTranscriber('gemini-2.5-flash', 1000, successfulGateway).transcribe('fixture.mp3', 'audio/mpeg'))
      .resolves.toMatchObject({ text: TRANSCRIPT });
    expect(successfulGateway.delete).toHaveBeenCalledTimes(1);

    const unavailable = Object.assign(new Error('upstream unavailable'), { status: 503 });
    const failedGateway = makeAudioGateway({ text: TRANSCRIPT }, {
      generate: vi.fn().mockRejectedValue(unavailable),
    });
    await expect(new GeminiTranscriber('gemini-2.5-flash', 1000, failedGateway).transcribe('fixture.mp3', 'audio/mpeg'))
      .rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(failedGateway.generate).toHaveBeenCalledTimes(2);
    expect(failedGateway.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects a transcript above MAX_TEXT_CHARS with 413 and saves nothing', async () => {
    const gateway = makeAudioGateway({ text: 'A'.repeat(env.MAX_TEXT_CHARS + 1) });
    setTranscriberClient(new GeminiTranscriber('gemini-2.5-flash', 1000, gateway));
    const result = await upload(makeMp3Fixture(), 'long-transcript.mp3', 'audio/mpeg');
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(result.body.error).not.toHaveProperty('conversationId');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
    expect(gateway.delete).toHaveBeenCalledWith('files/test-audio');
  });

  it('keeps a good transcript after minutes failure and retries without transcribing again', async () => {
    const transcribe = setMockTranscriber({ text: TRANSCRIPT });
    const generateMinutes = vi.fn()
      .mockRejectedValueOnce(new AppError(502, 'LLM_UNAVAILABLE', 'AI temporarily unavailable'))
      .mockResolvedValueOnce(STUB_MINUTES);
    const llm: LlmClient = { generateMinutes, answerQuestion: vi.fn().mockResolvedValue('Answer') };
    setLlmClient(llm);
    const failed = await upload(makeWavFixture(), 'retry.wav', 'audio/wav');
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('LLM_UNAVAILABLE');
    expect(typeof failed.body.error.conversationId).toBe('string');
    const id = failed.body.error.conversationId as string;
    expect((await Conversation.findById(id))?.sourceText).toBe(TRANSCRIPT);
    const retried = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', CLIENT_ID);
    expect(retried.status).toBe(200);
    expect(retried.body.data.message.messageType).toBe('minutes');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(generateMinutes).toHaveBeenCalledTimes(2);
  });

  it('does not log an audio filename, transcript, or audio content during successful upload', async () => {
    const filename = 'private-audio-name.wav';
    const transcript = 'Private transcript marker followed by enough spoken words to create meeting notes.';
    const audioMarker = 'PRIVATE_AUDIO_BYTES_MARKER';
    const audioBytes = makeWavFixture(Buffer.from(audioMarker, 'ascii'));
    const transcribe = setMockTranscriber({ text: transcript });
    const logMethods = ['error', 'info', 'log', 'warn', 'debug'] as const;
    const logSpies = logMethods.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const result = await upload(audioBytes, filename, 'audio/wav');
      expect(result.status).toBe(201);
      expect(transcribe).toHaveBeenCalledTimes(1);
      for (const spy of logSpies) {
        const logged = spy.mock.calls.flat().map(value => String(value)).join('\n');
        expect(logged).not.toContain(filename);
        expect(logged).not.toContain(transcript);
        expect(logged).not.toContain(audioMarker);
      }
    } finally {
      logSpies.forEach(spy => spy.mockRestore());
    }
  });

  it('sanitizes path parts and unusual filename characters for display', async () => {
    const filename = '../ meeting notes #1.txt';
    const result = await upload(Buffer.from(MEETING_TEXT), filename, 'text/plain');
    expect(result.status).toBe(201);
    expect(result.body.data.conversation.originalFilename).toBe('meeting notes #1.txt');
    const userMessage = await Message.findOne({ role: 'user' });
    expect(userMessage?.attachments[0]?.name).toBe('meeting notes #1.txt');
  });

  it('strips control characters and length-limits sanitized display filenames', () => {
    expect(sanitizeFilename('../ odd\u0001 name.txt')).toBe('odd name.txt');
    expect(sanitizeFilename(`${'x'.repeat(140)}.txt`)).toHaveLength(120);
  });

  it('rejects multipart data without the file field as INVALID_INPUT', async () => {
    const result = await request(app)
      .post('/api/conversations')
      .set('x-client-id', CLIENT_ID)
      .field('text', MEETING_TEXT);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_INPUT');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('maps an unexpected upload field to INVALID_INPUT without leaking multer text', async () => {
    const result = await request(app)
      .post('/api/conversations')
      .set('x-client-id', CLIENT_ID)
      .attach('attachment', Buffer.from(MEETING_TEXT), 'meeting.txt');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_INPUT');
    expect(result.body.error.message).not.toMatch(/multer|attachment|unexpected field/i);
    expect(await Conversation.countDocuments()).toBe(0);
  });

  it('removes the first temp file when multer rejects a second file midway and saves nothing', async () => {
    const result = await request(app)
      .post('/api/conversations')
      .set('x-client-id', CLIENT_ID)
      .attach('file', Buffer.from(MEETING_TEXT), 'one.txt')
      .attach('file', Buffer.from(MEETING_TEXT), 'two.txt');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_INPUT');
    expect(await Conversation.countDocuments()).toBe(0);
  });

  it('rejects extracted text above MAX_TEXT_CHARS before saving anything', async () => {
    const largeText = 'A'.repeat(env.MAX_TEXT_CHARS + 1);
    const result = await upload(Buffer.from(largeText), 'too-long.txt', 'text/plain');
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('does not log a filename, file content, or extracted text during a successful upload', async () => {
    const secretText = 'Private text marker meeting content that must never appear in any log line.';
    const secretFilename = 'private-filename-marker.txt';
    const logMethods = ['error', 'info', 'log', 'warn', 'debug'] as const;
    const logSpies = logMethods.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const result = await upload(Buffer.from(secretText), secretFilename, 'text/plain');
      expect(result.status).toBe(201);
      for (const spy of logSpies) {
        const logged = spy.mock.calls.flat().map(value => String(value)).join('\n');
        expect(logged).not.toContain(secretFilename);
        expect(logged).not.toContain(secretText);
        expect(logged).not.toContain('Private text marker');
      }
    } finally {
      logSpies.forEach(spy => spy.mockRestore());
    }
  });

  it('sweeps only old regular files directly in the upload temp folder', async () => {
    const oldFile = path.join(uploadDirectory, 'old-cleanup-fixture.tmp');
    const freshFile = path.join(uploadDirectory, 'fresh-cleanup-fixture.tmp');
    const otherDirectory = path.resolve(uploadDirectory, '..', 'cleanup-test-other');
    const otherFile = path.join(otherDirectory, 'old-but-outside-temp.tmp');
    await mkdir(otherDirectory, { recursive: true });
    try {
      await writeFile(oldFile, 'old');
      await writeFile(freshFile, 'fresh');
      await writeFile(otherFile, 'outside');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(oldFile, twoHoursAgo, twoHoursAgo);
      await utimes(otherFile, twoHoursAgo, twoHoursAgo);

      await cleanupStaleUploadFiles();

      expect(await readdir(uploadDirectory)).toEqual(['fresh-cleanup-fixture.tmp']);
      expect(await readdir(otherDirectory)).toEqual(['old-but-outside-temp.tmp']);
    } finally {
      await rm(oldFile, { force: true });
      await rm(freshFile, { force: true });
      await rm(otherDirectory, { recursive: true, force: true });
    }
  });

  it('removes a partially received multipart temp file after the client aborts', async () => {
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
    const boundary = 'meetbrief-abort-test-boundary';
    const req = rawRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/api/conversations',
      headers: {
        'x-client-id': CLIENT_ID,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        connection: 'close',
      },
    });
    req.on('error', () => undefined);
    try {
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n`);
      req.write('partial upload content '.repeat(16_384));
      const deadline = Date.now() + 5000;
      let tempFiles: string[] = [];
      while (Date.now() < deadline) {
        tempFiles = await readdir(uploadDirectory);
        if (tempFiles.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(tempFiles).toHaveLength(1);
      req.destroy();
      const cleanupDeadline = Date.now() + 5000;
      while (Date.now() < cleanupDeadline) {
        if ((await readdir(uploadDirectory)).length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await readdir(uploadDirectory)).toEqual([]);
    } finally {
      req.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('stores source and file metadata on LLM failure, returns its conversationId, and retry succeeds from stored sourceText', async () => {
    const generateMinutes = vi.fn()
      .mockRejectedValueOnce(new AppError(502, 'LLM_UNAVAILABLE', 'AI unavailable'))
      .mockResolvedValueOnce(STUB_MINUTES);
    const llm: LlmClient = { generateMinutes, answerQuestion: vi.fn().mockResolvedValue('Answer') };
    setLlmClient(llm);
    const result = await upload(Buffer.from(MEETING_TEXT), 'retry.txt', 'text/plain');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('LLM_UNAVAILABLE');
    expect(typeof result.body.error.conversationId).toBe('string');
    const id = result.body.error.conversationId as string;
    const conversation = await Conversation.findById(id);
    expect(conversation?.sourceText).toBe(MEETING_TEXT);
    const userMessage = await Message.findOne({ conversationId: id, role: 'user' });
    expect(userMessage?.attachments.map(item => ({ name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes })))
      .toEqual([{ name: 'retry.txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(MEETING_TEXT) }]);
    const restored = await request(app).get(`/api/conversations/${id}/messages`).set('x-client-id', CLIENT_ID);
    expect(restored.body.data.messages.at(-1).messageType).toBe('error');
    const retried = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', CLIENT_ID);
    expect(retried.status).toBe(200);
    expect(retried.body.data.message.messageType).toBe('minutes');
    expect(generateMinutes).toHaveBeenNthCalledWith(1, MEETING_TEXT);
    expect(generateMinutes).toHaveBeenNthCalledWith(2, MEETING_TEXT);
  });
});
