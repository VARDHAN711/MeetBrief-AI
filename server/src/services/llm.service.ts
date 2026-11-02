import type { Minutes } from '../schemas/minutes.schema.js';

export interface LlmClient {
  generateMinutes(text: string): Promise<Minutes>;
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
}

let activeLlmClient: LlmClient = new StubLlmClient();

export function getLlmClient(): LlmClient {
  return activeLlmClient;
}

export function setLlmClient(client: LlmClient): void {
  activeLlmClient = client;
}

