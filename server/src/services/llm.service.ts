import type { Minutes } from '../schemas/minutes.schema.js';
import type { FollowupTurn } from '../prompts/followup.js';
import { env } from '../config/env.js';
import { GEMINI_API_KEY_REQUIRED_MESSAGE } from '../config/geminiApiKey.js';
import { GeminiLlmClient } from './gemini.llm.service.js';

export interface LlmClient {
  generateMinutes(text: string): Promise<Minutes>;
  answerQuestion(sourceText: string, history: FollowupTurn[], question: string): Promise<string>;
}

export const STUB_MINUTES: Minutes = {
  title: 'Project Kickoff & Roadmap Alignment',
  summary:
    'The team reviewed the overall project scope, aligned on essential deliverables, and scheduled weekly progress check-ins.',
  decisions: [
    {
      decision: 'Adopt Node.js 26 and Express for backend architecture',
      context: 'Ensures LTS compatibility and modern runtime performance',
    },
    {
      decision: 'Use MongoDB with strict schema validation',
    },
  ],
  actionItems: [
    {
      task: 'Set up repository skeleton and CI pipeline',
      assignee: 'Team Lead',
      deadline: 'Friday 5 PM',
    },
    {
      task: 'Draft initial database indexes and collection schemas',
      assignee: 'Backend Engineer',
      deadline: 'Next Monday',
    },
    {
      task: 'Document API contracts for frontend integration',
      assignee: 'Unassigned',
      deadline: 'Not specified',
    },
  ],
  suggestions: [
    {
      text: 'Consider adding automated migration scripts for future schema updates',
    },
  ],
  pendingIssues: [
    {
      issue: 'Confirm production rate limits for LLM free tier quotas',
      kind: 'open_question',
    },
  ],
  limitations: ['Audio transcription not included in this phase.'],
};

export class StubLlmClient implements LlmClient {
  async generateMinutes(_text: string): Promise<Minutes> {
    return structuredClone(STUB_MINUTES);
  }

  async answerQuestion(_sourceText: string, _history: FollowupTurn[], _question: string): Promise<string> {
    return 'The source does not contain that information.';
  }
}

function createInitialLlmClient(): LlmClient {
  if (env.GEMINI_API_KEY) return new GeminiLlmClient(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.GEMINI_TIMEOUT_MS);
  if (process.env.NODE_ENV === 'test') return new StubLlmClient();
  throw new Error(GEMINI_API_KEY_REQUIRED_MESSAGE);
}

let activeLlmClient: LlmClient = createInitialLlmClient();

export function getLlmClient(): LlmClient {
  return activeLlmClient;
}

export function setLlmClient(client: LlmClient): void {
  activeLlmClient = client;
}
