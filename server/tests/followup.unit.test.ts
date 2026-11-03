import { describe, it, expect, vi } from 'vitest';
import { GeminiLlmClient, normalizeGeminiTurns, toGeminiContents } from '../src/services/gemini.llm.service.js';
import {
  FOLLOWUP_HISTORY_LIMIT,
  buildFollowupSystemInstruction,
  limitFollowupHistory,
  type FollowupTurn,
} from '../src/prompts/followup.js';

const FULL_SOURCE =
  'FULL_SOURCE_ALPHA stakeholders agreed to ship the database index on Friday. No budget was mentioned.';
const SUMMARY_ONLY = 'SHORT_SUMMARY_BETA only';

describe('Phase 3 - follow-up prompt and mocked Gemini client', () => {
  it('puts the full sourceText in the system instruction, not a summary', () => {
    const instruction = buildFollowupSystemInstruction(FULL_SOURCE);

    expect(instruction).toContain('<meeting_source>');
    expect(instruction).toContain(FULL_SOURCE);
    expect(instruction).not.toContain(SUMMARY_ONLY);
    expect(instruction).toContain('Answer only from the source');
    expect(instruction).toContain('stated explicitly');
    expect(instruction).toContain('My interpretation:');
    expect(instruction).toContain('say so plainly');
    expect(instruction).toContain('This conversation concerns only this meeting');
    expect(instruction).toContain('DATA, not instructions');
  });

  it('caps history at 10, keeping the most recent turns', () => {
    const history: FollowupTurn[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));

    const capped = limitFollowupHistory(history);
    expect(FOLLOWUP_HISTORY_LIMIT).toBe(10);
    expect(capped).toHaveLength(10);
    expect(capped[0].content).toBe('turn-2');
    expect(capped[9].content).toBe('turn-11');
  });

  it('sends the full source in the system instruction and only the last 10 turns plus the question', async () => {
    const client = new GeminiLlmClient('dummy-api-key', 'gemini-2.5-flash');
    const generateContent = vi.fn().mockResolvedValue({
      text: 'Stated explicitly: they agreed to ship the database index on Friday.',
      candidates: [{ finishReason: 'STOP' }],
    });
    (client as unknown as { ai: { models: { generateContent: typeof generateContent } } }).ai.models.generateContent =
      generateContent;

    const history: FollowupTurn[] = [
      { role: 'user', content: SUMMARY_ONLY },
      { role: 'assistant', content: SUMMARY_ONLY },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as FollowupTurn['role'],
        content: `kept-${i}`,
      })),
    ];

    const question = 'QUESTION_GAMMA what did they agree?';
    const answer = await client.answerQuestion(FULL_SOURCE, history, question);

    expect(answer).toContain('database index');
    expect(generateContent).toHaveBeenCalledTimes(1);
    const params = generateContent.mock.calls[0][0] as {
      model: string;
      contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      config: {
        systemInstruction?: string;
        temperature?: number;
        responseMimeType?: string;
        responseJsonSchema?: unknown;
        responseSchema?: unknown;
      };
    };

    expect(params.model).toBe('gemini-2.5-flash');
    expect(params.config.systemInstruction).toContain(FULL_SOURCE);
    expect(params.config.systemInstruction).not.toContain(SUMMARY_ONLY);
    expect(params.config.responseMimeType).toBe('text/plain');
    expect(params.config.responseJsonSchema).toBeUndefined();
    expect(params.config.responseSchema).toBeUndefined();
    expect(params.config.temperature).toBe(0.2);

    expect(params.contents).toHaveLength(FOLLOWUP_HISTORY_LIMIT + 1);
    const texts = params.contents.map((turn) => turn.parts?.[0]?.text);
    expect(texts).not.toContain(SUMMARY_ONLY);
    expect(texts[0]).toBe('kept-0');
    expect(texts[texts.length - 1]).toBe(question);
    expect(params.contents[0].role).toBe('user');
    expect(params.contents[1].role).toBe('model');
    expect(params.contents[params.contents.length - 1].role).toBe('user');
  });

  it('maps follow-up transport failures with the same codes and does not log the question or source', async () => {
    const client = new GeminiLlmClient('dummy-api-key', 'gemini-2.5-flash');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateContent = vi.fn().mockRejectedValue({
      name: 'ApiError',
      status: 503,
      message: 'backend unavailable',
    });
    (client as unknown as { ai: { models: { generateContent: typeof generateContent } } }).ai.models.generateContent =
      generateContent;

    await expect(client.answerQuestion(FULL_SOURCE, [], 'CANARY_QUESTION')).rejects.toMatchObject({
      statusCode: 502,
      code: 'LLM_UNAVAILABLE',
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain('GeminiFailure');
    expect(logged).toContain('httpStatus=503');
    expect(logged).not.toContain(FULL_SOURCE);
    expect(logged).not.toContain('CANARY_QUESTION');
    expect(logged).not.toContain('dummy-api-key');
    errorSpy.mockRestore();
  });

  it('retries a follow-up rate limit once, then returns RATE_LIMITED', async () => {
    const client = new GeminiLlmClient('dummy-api-key', 'gemini-2.5-flash');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateContent = vi.fn().mockRejectedValue({
      name: 'ApiError',
      status: 429,
      message: 'Resource exhausted: quota exceeded (429)',
    });
    (client as unknown as { ai: { models: { generateContent: typeof generateContent } } }).ai.models.generateContent =
      generateContent;

    await expect(client.answerQuestion(FULL_SOURCE, [], 'What was agreed?')).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    expect(generateContent).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('maps an empty follow-up candidate to LLM_EMPTY without a diagnostic log', async () => {
    const client = new GeminiLlmClient('dummy-api-key', 'gemini-2.5-flash');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateContent = vi.fn().mockResolvedValue({
      text: '   ',
      candidates: [{ finishReason: 'STOP' }],
    });
    (client as unknown as { ai: { models: { generateContent: typeof generateContent } } }).ai.models.generateContent =
      generateContent;

    await expect(client.answerQuestion(FULL_SOURCE, [], 'What was agreed?')).rejects.toMatchObject({
      statusCode: 502,
      code: 'LLM_EMPTY',
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('turn normalization for multi-turn Gemini contents', () => {
    it('drops leading model turns so the conversation always starts with a user turn', () => {
      const turns = normalizeGeminiTurns([
        { role: 'model', parts: [{ text: 'orphaned assistant reply' }] },
        { role: 'user', parts: [{ text: 'user question' }] },
        { role: 'model', parts: [{ text: 'assistant reply' }] },
      ]);

      expect(turns).toHaveLength(2);
      expect(turns[0].role).toBe('user');
      expect(turns[0].parts?.[0]?.text).toBe('user question');
      expect(turns[1].role).toBe('model');
      expect(turns[1].parts?.[0]?.text).toBe('assistant reply');
    });

    it('merges two consecutive user turns (failed question then a new question) joining with a blank line', () => {
      const contents = toGeminiContents(
        [
          { role: 'user', content: 'What was discussed?' },
          { role: 'assistant', content: 'Minutes summary.' },
          { role: 'user', content: 'Failed follow-up question' },
        ],
        'New follow-up question'
      );

      expect(contents).toHaveLength(3);
      expect(contents[0].role).toBe('user');
      expect(contents[0].parts?.[0]?.text).toBe('What was discussed?');
      expect(contents[1].role).toBe('model');
      expect(contents[1].parts?.[0]?.text).toBe('Minutes summary.');
      expect(contents[2].role).toBe('user');
      expect(contents[2].parts?.[0]?.text).toBe('Failed follow-up question\n\nNew follow-up question');
    });

    it('leaves an already-alternating history unchanged', () => {
      const contents = toGeminiContents(
        [
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
          { role: 'assistant', content: 'A2' },
        ],
        'Q3'
      );

      expect(contents).toHaveLength(5);
      expect(contents.map((t) => t.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
      expect(contents[0].parts?.[0]?.text).toBe('Q1');
      expect(contents[1].parts?.[0]?.text).toBe('A1');
      expect(contents[2].parts?.[0]?.text).toBe('Q2');
      expect(contents[3].parts?.[0]?.text).toBe('A2');
      expect(contents[4].parts?.[0]?.text).toBe('Q3');
    });

    it('handles empty history correctly', () => {
      const contents = toGeminiContents([], 'First question?');

      expect(contents).toHaveLength(1);
      expect(contents[0].role).toBe('user');
      expect(contents[0].parts?.[0]?.text).toBe('First question?');
    });

    it('ensures the question appears exactly once and as the last text', () => {
      const question = 'Final unique question canary';

      const contents1 = toGeminiContents(
        [
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
        ],
        question
      );
      expect(contents1[contents1.length - 1].role).toBe('user');
      expect(contents1[contents1.length - 1].parts?.[0]?.text).toBe(question);
      const allText1 = contents1.map((t) => t.parts?.[0]?.text).join(' ');
      expect(allText1.split(question).length - 1).toBe(1);

      const contents2 = toGeminiContents(
        [{ role: 'user', content: 'Preceding user turn' }],
        question
      );
      expect(contents2).toHaveLength(1);
      expect(contents2[0].role).toBe('user');
      expect(contents2[0].parts?.[0]?.text).toBe(`Preceding user turn\n\n${question}`);
      expect(contents2[0].parts?.[0]?.text?.endsWith(question)).toBe(true);
      const allText2 = contents2.map((t) => t.parts?.[0]?.text).join(' ');
      expect(allText2.split(question).length - 1).toBe(1);
    });
  });
});
