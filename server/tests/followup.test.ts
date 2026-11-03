import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Conversation } from '../src/models/Conversation.js';
import { Message } from '../src/models/Message.js';
import * as llmService from '../src/services/llm.service.js';
import { GeminiLlmClient } from '../src/services/gemini.llm.service.js';
import { AppError } from '../src/utils/AppError.js';
import type { FollowupTurn } from '../src/prompts/followup.js';
import type { MessageItem } from '../src/types/api.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/meetbrief_test';
const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const SOURCE =
  'Stakeholders agreed to prioritize database stability and weekly testing. No budget figure was discussed at any point.';
const NOT_IN_SOURCE = 'The source does not contain that information.';
const DATABASE_ANSWER = 'Stated explicitly: stakeholders agreed to prioritize database stability.';

type AnswerFn = (sourceText: string, history: FollowupTurn[], question: string) => Promise<string>;

function answerFromSource(sourceText: string, _history: FollowupTurn[], question: string): Promise<string> {
  const q = question.toLowerCase();
  if (q.includes('budget') || q.includes('who owns') || !sourceText.includes('database stability')) {
    return Promise.resolve(NOT_IN_SOURCE);
  }
  if (q.includes('database') && (q.includes('agreed') || q.includes('priority') || q.includes('stability'))) {
    return Promise.resolve(DATABASE_ANSWER);
  }
  return Promise.resolve(NOT_IN_SOURCE);
}

function useMock(answerQuestion: AnswerFn = answerFromSource): {
  generateMinutes: ReturnType<typeof vi.fn>;
  answerQuestion: ReturnType<typeof vi.fn>;
} {
  const client: llmService.LlmClient = {
    generateMinutes: vi.fn().mockResolvedValue(llmService.STUB_MINUTES),
    answerQuestion: vi.fn(answerQuestion),
  };
  llmService.setLlmClient(client);
  return {
    generateMinutes: client.generateMinutes as ReturnType<typeof vi.fn>,
    answerQuestion: client.answerQuestion as ReturnType<typeof vi.fn>,
  };
}

async function createChat(): Promise<string> {
  const res = await request(app).post('/api/conversations').set('x-client-id', OWNER).send({ text: SOURCE });
  expect(res.status).toBe(201);
  return res.body.data.conversation.id as string;
}

describe('Phase 3 - follow-up messages and retry (mocked LLM)', () => {
  beforeAll(async () => {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 4000 });
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
    useMock();
  });

  it('answers from the full source, says when the source has no answer, and still answers after reopen', async () => {
    const mock = useMock();
    const id = await createChat();

    const reopened = await request(app).get(`/api/conversations/${id}/messages`).set('x-client-id', OWNER);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.messages).toHaveLength(2);

    const answerable = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: '  What was agreed about the database?  ' });

    expect(answerable.status).toBe(201);
    expect(answerable.body.data.messages).toHaveLength(2);
    const [userMsg, assistantMsg] = answerable.body.data.messages as MessageItem[];
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toBe('What was agreed about the database?');
    expect(userMsg.seq).toBe(3);
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.messageType).toBe('text');
    expect(assistantMsg.seq).toBe(4);
    expect(assistantMsg.content).toBe(DATABASE_ANSWER);

    const [sourceText, history, question] = mock.answerQuestion.mock.calls[0] as [
      string,
      FollowupTurn[],
      string,
    ];
    expect(sourceText).toBe(SOURCE);
    expect(sourceText).not.toBe(llmService.STUB_MINUTES.summary);
    expect(sourceText).toContain('database stability');
    expect(question).toBe('What was agreed about the database?');
    expect(history.every((turn) => turn.content !== llmService.STUB_MINUTES.summary || sourceText !== turn.content)).toBe(
      true
    );
    expect(history.some((turn) => turn.content === SOURCE)).toBe(true);

    const unanswerable = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'What was the budget?' });

    expect(unanswerable.status).toBe(201);
    expect(unanswerable.body.data.messages[1].content).toBe(NOT_IN_SOURCE);
    expect(unanswerable.body.data.messages[0].seq).toBe(5);
    expect(unanswerable.body.data.messages[1].seq).toBe(6);

    const restored = await request(app).get(`/api/conversations/${id}/messages`).set('x-client-id', OWNER);
    expect(restored.status).toBe(200);
    const seqs = (restored.body.data.messages as MessageItem[]).map((msg) => msg.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);

    const afterReopen = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'Who owns the database work?' });
    expect(afterReopen.status).toBe(201);
    expect(afterReopen.body.data.messages[1].content).toBe(NOT_IN_SOURCE);
    expect(mock.answerQuestion.mock.calls.at(-1)?.[0]).toBe(SOURCE);
  });

  it('caps history at 10 and excludes error messages', async () => {
    const mock = useMock();
    const id = await createChat();
    const conversation = await Conversation.findById(id);
    expect(conversation).toBeTruthy();

    const seeded: Array<{ seq: number; role: 'user' | 'assistant'; content: string; messageType: 'text' | 'error' }> = [
      { seq: 3, role: 'user', content: 'older-user', messageType: 'text' },
      { seq: 4, role: 'assistant', content: 'older-assistant', messageType: 'text' },
      { seq: 5, role: 'assistant', content: 'ERROR_CANARY_DO_NOT_SEND', messageType: 'error' },
      { seq: 6, role: 'user', content: 'kept-user-6', messageType: 'text' },
      { seq: 7, role: 'assistant', content: 'kept-assistant-7', messageType: 'text' },
      { seq: 8, role: 'user', content: 'kept-user-8', messageType: 'text' },
      { seq: 9, role: 'assistant', content: 'kept-assistant-9', messageType: 'text' },
      { seq: 10, role: 'user', content: 'kept-user-10', messageType: 'text' },
      { seq: 11, role: 'assistant', content: 'kept-assistant-11', messageType: 'text' },
      { seq: 12, role: 'user', content: 'kept-user-12', messageType: 'text' },
      { seq: 13, role: 'assistant', content: 'kept-assistant-13', messageType: 'text' },
    ];

    await Message.insertMany(
      seeded.map((msg) => ({
        conversationId: conversation!._id,
        seq: msg.seq,
        role: msg.role,
        content: msg.content,
        messageType: msg.messageType,
        attachments: [],
      }))
    );
    await Conversation.updateOne({ _id: conversation!._id }, { $set: { messageCount: 13 } });

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'What was agreed about the database?' });

    expect(res.status).toBe(201);
    expect(res.body.data.messages[0].seq).toBe(14);
    expect(res.body.data.messages[1].seq).toBe(15);

    const history = mock.answerQuestion.mock.calls[0][1] as FollowupTurn[];
    expect(history).toHaveLength(10);
    expect(history.some((turn) => turn.content === 'ERROR_CANARY_DO_NOT_SEND')).toBe(false);
    expect(history.some((turn) => turn.content.includes('What was agreed about the database?'))).toBe(false);
    expect(history[0].content).toBe('older-user');
    expect(history[history.length - 1].content).toBe('kept-assistant-13');
    expect(history.some((turn) => turn.content === SOURCE)).toBe(false);

    const stored = await Message.find({ conversationId: conversation!._id }).sort({ seq: 1 });
    expect(stored.map((msg) => msg.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('keeps the user message and stores an error message when the LLM call fails', async () => {
    useMock(async () => {
      throw new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.');
    });
    const id = await createChat();

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'What was agreed about the database?' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('LLM_UNAVAILABLE');

    const messages = await Message.find({ conversationId: id }).sort({ seq: 1 });
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe('user');
    expect(messages[2].seq).toBe(3);
    expect(messages[2].content).toBe('What was agreed about the database?');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].seq).toBe(4);
    expect(messages[3].messageType).toBe('error');
    expect(messages[3].content).toContain('currently unavailable');
  });

  it('replaces an error on retry and returns 409 when the last message is not an error', async () => {
    const failing = useMock(async () => {
      throw new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.');
    });
    const id = await createChat();

    const failed = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'What was agreed about the database?' });
    expect(failed.status).toBe(502);

    const before = await Message.find({ conversationId: id }).sort({ seq: 1 });
    const errorId = before[3]._id.toString();
    expect(before).toHaveLength(4);

    const retryClient = useMock();
    const retried = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', OWNER);
    expect(retried.status).toBe(200);
    expect(retried.body.data.message.id).toBe(errorId);
    expect(retried.body.data.message.seq).toBe(4);
    expect(retried.body.data.message.messageType).toBe('text');
    expect(retried.body.data.message.content).toBe(DATABASE_ANSWER);
    expect(retryClient.generateMinutes).not.toHaveBeenCalled();
    expect(retryClient.answerQuestion).toHaveBeenCalledTimes(1);
    const [sourceText, history, question] = retryClient.answerQuestion.mock.calls[0] as [
      string,
      FollowupTurn[],
      string,
    ];
    expect(sourceText).toBe(SOURCE);
    expect(question).toBe('What was agreed about the database?');
    expect(history.some((turn) => turn.content.includes('currently unavailable'))).toBe(false);

    const after = await Message.find({ conversationId: id }).sort({ seq: 1 });
    expect(after).toHaveLength(4);
    expect(after[3].messageType).toBe('text');

    const again = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', OWNER);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RETRY_NOT_ALLOWED');

    expect(failing.answerQuestion).toHaveBeenCalled();
  });

  it('regenerates minutes when retrying a failed minutes generation', async () => {
    const failing: llmService.LlmClient = {
      generateMinutes: vi.fn().mockRejectedValue(
        new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.')
      ),
      answerQuestion: vi.fn(),
    };
    llmService.setLlmClient(failing);

    const created = await request(app).post('/api/conversations').set('x-client-id', OWNER).send({ text: SOURCE });
    expect(created.status).toBe(502);

    const conversation = await Conversation.findOne({ clientId: OWNER });
    expect(conversation).toBeTruthy();
    expect(conversation!.title).toBe('Generating minutes...');
    const id = conversation!._id.toString();
    const stored = await Message.find({ conversationId: id }).sort({ seq: 1 });
    expect(stored).toHaveLength(2);
    expect(stored[1].messageType).toBe('error');
    const errorId = stored[1]._id.toString();

    const retryClient = useMock();
    const retried = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', OWNER);
    expect(retried.status).toBe(200);
    expect(retried.body.data.message.id).toBe(errorId);
    expect(retried.body.data.message.seq).toBe(2);
    expect(retried.body.data.message.messageType).toBe('minutes');
    expect(retried.body.data.message.structuredData.title).toBe(llmService.STUB_MINUTES.title);
    expect(retryClient.generateMinutes).toHaveBeenCalledWith(SOURCE);
    expect(retryClient.answerQuestion).not.toHaveBeenCalled();

    const updated = await Conversation.findById(id);
    expect(updated!.title).toBe(llmService.STUB_MINUTES.title);
    const messages = await Message.find({ conversationId: id });
    expect(messages).toHaveLength(2);
  });

  it('returns 404 for a foreign clientId on messages and retry', async () => {
    useMock(async () => {
      throw new AppError(502, 'LLM_UNAVAILABLE', 'The AI service is currently unavailable. Please try again later.');
    });
    const id = await createChat();
    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'What was agreed about the database?' });

    const foreignMessage = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OTHER)
      .send({ content: 'What was agreed about the database?' });
    expect(foreignMessage.status).toBe(404);
    expect(foreignMessage.body.error.code).toBe('CONVERSATION_NOT_FOUND');

    const foreignRetry = await request(app).post(`/api/conversations/${id}/retry`).set('x-client-id', OTHER);
    expect(foreignRetry.status).toBe(404);
    expect(foreignRetry.body.error.code).toBe('CONVERSATION_NOT_FOUND');

    const ownerMessages = await Message.find({ conversationId: id });
    expect(ownerMessages).toHaveLength(4);
  });

  it('rejects empty, blank, and over-long questions', async () => {
    const id = await createChat();

    const missing = await request(app).post(`/api/conversations/${id}/messages`).set('x-client-id', OWNER).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const blank = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: '   ' });
    expect(blank.status).toBe(400);

    const tooLong = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'a'.repeat(2001) });
    expect(tooLong.status).toBe(400);

    const messages = await Message.find({ conversationId: id });
    expect(messages).toHaveLength(2);
  });

  it('does not log the question or the meeting text', async () => {
    const canary = 'CANARY_QUESTION_AND_SOURCE_991122';
    const source = `${SOURCE} Marker ${canary}.`;
    const mock = useMock(async () => Promise.resolve(`Reply that must not be logged ${canary}`));
    llmService.setLlmClient({
      generateMinutes: vi.fn().mockResolvedValue(llmService.STUB_MINUTES),
      answerQuestion: mock.answerQuestion,
    });

    const created = await request(app).post('/api/conversations').set('x-client-id', OWNER).send({ text: source });
    expect(created.status).toBe(201);
    const id = created.body.data.conversation.id as string;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: `Please explain ${canary}` });
    expect(res.status).toBe(201);

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(logged).not.toContain(canary);
    expect(logged).not.toContain('Reply that must not be logged');

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('handles a failed question followed by a new question producing valid alternating turns in Gemini contents', async () => {
    const gemini = new GeminiLlmClient('dummy-api-key', 'gemini-2.5-flash');
    const generateContent = vi.fn();
    (gemini as unknown as { ai: { models: { generateContent: typeof generateContent } } }).ai.models.generateContent =
      generateContent;
    llmService.setLlmClient(gemini);

    generateContent.mockResolvedValueOnce({
      text: JSON.stringify(llmService.STUB_MINUTES),
      candidates: [{ finishReason: 'STOP' }],
    });

    const created = await request(app).post('/api/conversations').set('x-client-id', OWNER).send({ text: SOURCE });
    expect(created.status).toBe(201);
    const id = created.body.data.conversation.id as string;

    generateContent.mockRejectedValueOnce({
      name: 'ApiError',
      status: 503,
      message: 'Service unavailable',
    });

    const failed = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'Failed first question' });
    expect(failed.status).toBe(502);

    const messagesAfterFail = await Message.find({ conversationId: id }).sort({ seq: 1 });
    expect(messagesAfterFail).toHaveLength(4);
    expect(messagesAfterFail[2].content).toBe('Failed first question');
    expect(messagesAfterFail[3].messageType).toBe('error');

    generateContent.mockResolvedValueOnce({
      text: 'Valid answer to the second question.',
      candidates: [{ finishReason: 'STOP' }],
    });

    const success = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-client-id', OWNER)
      .send({ content: 'Second follow-up question' });
    expect(success.status).toBe(201);
    expect(success.body.data.messages[1].content).toBe('Valid answer to the second question.');

    expect(generateContent).toHaveBeenCalledTimes(3);
    const callArgs = generateContent.mock.calls[2][0] as {
      contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
    };
    const contents = callArgs.contents;

    expect(contents[0].role).toBe('user');
    for (let i = 1; i < contents.length; i++) {
      expect(contents[i].role).not.toBe(contents[i - 1].role);
    }
    const lastTurn = contents[contents.length - 1];
    expect(lastTurn.role).toBe('user');
    expect(lastTurn.parts?.[0]?.text).toContain('Failed first question\n\nSecond follow-up question');
    expect(lastTurn.parts?.[0]?.text?.endsWith('Second follow-up question')).toBe(true);
  });
});
