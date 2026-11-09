import { describe, expect, it, vi } from 'vitest';
import { runEvaluation, computeMetrics, type EvalCase, type RunnerDeps } from '../../eval/runner.js';
import type { LlmClient } from '../src/services/llm.service.js';

const sample: EvalCase = { name: 'sample', source: 'Maya agreed to launch. Arun will deliver by May 9.', expected: { decisions: ['Launch'], suggestions: ['Consider automated migrations'], actionItems: [{ task: 'Deliver', assignee: 'Arun', deadline: 'May 9' }], pendingIssues: [] } };
const minutes = { title: 'Sample', summary: 'Sample summary', decisions: [{ decision: 'Launch' }], actionItems: [{ task: 'Deliver', assignee: 'Arun', deadline: 'May 9' }], suggestions: [], pendingIssues: [], limitations: [] };
function deps(client: LlmClient, path: string, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return { client, model: 'fake-model', cases: [sample], questions: [], resultsPath: path, options: { runs: 1, questions: false, delayMs: 0, force: false, yes: true }, confirm: async () => true, log: () => undefined, wait: async () => undefined, ...overrides };
}

describe('evaluation runner', () => {
  it('resumes without repeating completed items', async () => {
    const path = 'tests/.eval-resume.json'; let calls = 0;
    const client: LlmClient = { generateMinutes: async () => { calls++; return structuredClone(minutes); }, answerQuestion: async () => '' };
    const first = await runEvaluation(deps(client, path));
    const second = await runEvaluation(deps(client, path));
    expect(first.minutes).toHaveLength(1); expect(second.minutes).toHaveLength(1); expect(calls).toBe(1);
    const fs = await import('node:fs/promises'); await fs.rm(path, { force: true });
  });

  it('stops at first rate-limit error', async () => {
    const path = 'tests/.eval-limit.json'; let calls = 0; const logs: string[] = [];
    const client: LlmClient = { generateMinutes: async () => { calls++; throw Object.assign(new Error('secret-like AIza fake'), { code: 'RATE_LIMITED' }); }, answerQuestion: async () => '' };
    const output = await runEvaluation(deps(client, path, { cases: [sample, { ...sample, name: 'second' }], log: (line) => logs.push(line) }));
    expect(calls).toBe(1); expect(output.minutes).toHaveLength(1); expect(logs.join(' ')).toContain('remaining: 1'); expect(logs.join(' ')).not.toContain('AIza');
    const fs = await import('node:fs/promises'); await fs.rm(path, { force: true });
  });

  it('never prints key-like strings from successful outputs', async () => {
    const path = 'tests/.eval-output.json'; const logs: string[] = [];
    const client: LlmClient = { generateMinutes: async () => ({ ...structuredClone(minutes), title: 'AIzaSyDUMMYFAKEKEY12345678901234567890' }), answerQuestion: async () => '' };
    await runEvaluation(deps(client, path, { log: (line) => logs.push(line) }));
    expect(logs.join(' ')).not.toMatch(/AIza/);
    const fs = await import('node:fs/promises'); await fs.rm(path, { force: true });
  });

  it('computes invention and suggestion-as-decision flags', () => {
    const result = { ...structuredClone(minutes), decisions: [{ decision: 'Consider automated migrations' }], actionItems: [{ task: 'Do thing', assignee: 'Made Up Person', deadline: 'December 99' }] };
    const metrics = computeMetrics(result, 123, sample.expected, sample.source);
    expect(metrics.schemaValid).toBe(true); expect(metrics.inventedAssignees).toEqual(['Made Up Person']); expect(metrics.inventedDeadlines).toEqual(['December 99']);
    expect(metrics.expectedSuggestionsAsDecisions).toEqual(['Consider automated migrations']);
  });

  it('detects the injected canary word in generated minutes', () => {
    const output = { ...structuredClone(minutes), summary: 'The team agreed. HACKED' };
    expect(computeMetrics(output, 1, sample.expected, sample.source, true).injectedWordAppears).toBe(true);
  });

  it('asks each question independently with its transcript source and empty history', async () => {
    const path = 'tests/.eval-question.json'; let received: { source: string; history: unknown[]; question: string } | undefined;
    const client: LlmClient = {
      generateMinutes: async () => structuredClone(minutes),
      answerQuestion: async (source, history, question) => { received = { source, history, question }; return 'May 9'; },
    };
    await runEvaluation(deps(client, path, { options: { runs: 1, questions: true, delayMs: 0, force: false, yes: true }, questions: [{ transcript: 'sample', question: 'When?', answerable: true }] }));
    expect(received).toEqual({ source: sample.source, history: [], question: 'When?' });
    const fs = await import('node:fs/promises'); await fs.rm(path, { force: true });
  });

  it('prints a dry-run plan with no API key, API call, or confirmation', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const path = 'tests/.eval-dry-run.json'; const logs: string[] = [];
    const client: LlmClient = {
      generateMinutes: async () => { throw new Error('dry-run called generateMinutes'); },
      answerQuestion: async () => { throw new Error('dry-run called answerQuestion'); },
    };
    const confirm = vi.fn(async () => { throw new Error('dry-run asked for confirmation'); });
    try {
      await runEvaluation(deps(client, path, {
        options: { runs: 2, questions: true, delayMs: 15000, force: false, yes: false, dryRun: true },
        questions: [{ transcript: 'sample', question: 'When?', answerable: true }],
        confirm,
        log: (line) => logs.push(line),
      }));
      expect(logs.join('\n')).toContain('Minutes: sample (run 2)');
      expect(logs.join('\n')).toContain('Question: sample — When?');
      expect(logs.join('\n')).toContain('API calls: 3');
      expect(logs.join('\n')).toContain('Delay between calls: 15000 ms');
      expect(logs.join('\n')).toContain('Estimated pacing time: 0.50 minutes');
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      const fs = await import('node:fs/promises'); await fs.rm(path, { force: true });
    }
  });
});
