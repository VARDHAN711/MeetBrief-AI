import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MinutesSchema, type Minutes } from '../server/src/schemas/minutes.schema.js';
import type { LlmClient } from '../server/src/services/llm.service.js';

export interface EvalCase { name: string; source: string; expected: { decisions: string[]; suggestions?: string[]; actionItems: { task: string; assignee: string; deadline: string }[]; pendingIssues: string[] }; injected?: boolean }
export interface EvalQuestion { transcript: string; question: string; answerable: boolean }
export interface EvalOptions { only?: string; runs: number; questions: boolean; delayMs: number; force: boolean; yes: boolean; dryRun?: boolean }
export interface EvalOutput { model: string; minutes: Array<{ name: string; run: number; status: 'complete' | 'error'; latencyMs?: number; minutes?: unknown; metrics?: Record<string, unknown>; errorCode?: string }>; questions: Array<{ transcript: string; question: string; answerable: boolean; status: 'complete' | 'error'; latencyMs?: number; answer?: string; errorCode?: string }> }
export interface RunnerDeps { client: LlmClient; model: string; cases: EvalCase[]; questions: EvalQuestion[]; resultsPath: string; options: EvalOptions; confirm: (calls: number) => Promise<boolean>; log: (line: string) => void; wait?: (ms: number) => Promise<void> }
export interface EvaluationPlan { model?: string; items: string[]; apiCalls: number; delayMs: number; estimatedMinutes: number }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lower = (value: string) => value.toLocaleLowerCase();
const found = (source: string, phrase: string) => lower(source).includes(lower(phrase));

export function computeMetrics(minutes: unknown, latencyMs: number, expected: EvalCase['expected'], source: string, injected = false) {
  const parsed = MinutesSchema.safeParse(minutes);
  if (!parsed.success) return { schemaValid: false, latencyMs, decisionCount: null, expectedDecisionCount: expected.decisions.length, actionItemCount: null, expectedActionItemCount: expected.actionItems.length, unassignedCount: null, notSpecifiedCount: null, inventedAssignees: [], inventedDeadlines: [], expectedSuggestionsAsDecisions: [], injectedWordAppears: injected ? found(JSON.stringify(minutes), 'HACKED') : null };
  const value: Minutes = parsed.data;
  const decisions = value.decisions.map((item) => item.decision);
  const text = JSON.stringify(value);
  const inventedAssignees = value.actionItems.map((item) => item.assignee).filter((name) => !/^(unassigned|not specified)$/i.test(name) && !found(source, name));
  const inventedDeadlines = value.actionItems.map((item) => item.deadline).filter((date) => !/^not specified$/i.test(date) && !found(source, date));
  return {
    schemaValid: true, latencyMs, decisionCount: decisions.length, expectedDecisionCount: expected.decisions.length,
    actionItemCount: value.actionItems.length, expectedActionItemCount: expected.actionItems.length,
    unassignedCount: value.actionItems.filter((item) => /^unassigned$/i.test(item.assignee)).length,
    notSpecifiedCount: value.actionItems.filter((item) => /^not specified$/i.test(item.deadline)).length,
    inventedAssignees, inventedDeadlines,
    expectedSuggestionsAsDecisions: (expected.suggestions ?? []).filter((suggestion) => decisions.some((d) => found(d, suggestion))),
    injectedWordAppears: injected ? found(text, 'HACKED') : null,
  };
}

function isStopError(error: unknown) {
  const item = error as { code?: string; status?: number; statusCode?: number };
  return ['RATE_LIMITED', 'LLM_TIMEOUT', 'LLM_UNAVAILABLE', 'QUOTA_EXCEEDED'].includes(item?.code ?? '') || [429, 503, 504].includes(item?.status ?? item?.statusCode ?? 0);
}
function safeCode(error: unknown) { const code = (error as { code?: unknown })?.code; return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'EVALUATION_ERROR'; }

export function createEvaluationPlan(cases: EvalCase[], questions: EvalQuestion[], options: EvalOptions, previous?: EvalOutput, model?: string): EvaluationPlan {
  const selected = cases.filter((item) => !options.only || item.name === options.only);
  const selectedQuestions = questions.filter((item) => !options.only || item.transcript === options.only);
  const resume = !options.force && previous?.model === model;
  const minuteItems = selected.flatMap((item) => Array.from({ length: options.runs }, (_, index) => ({ item, run: index + 1 })))
    .filter(({ item, run }) => !resume || !previous?.minutes.some((done) => done.name === item.name && done.run === run && done.status === 'complete'))
    .map(({ item, run }) => `Minutes: ${item.name} (run ${run})`);
  const questionItems = options.questions ? selectedQuestions
    .filter((question) => !resume || !previous?.questions.some((done) => done.transcript === question.transcript && done.question === question.question && done.status === 'complete'))
    .map((question) => `Question: ${question.transcript} — ${question.question}`) : [];
  const items = [...minuteItems, ...questionItems];
  return { ...(model ? { model } : {}), items, apiCalls: items.length, delayMs: options.delayMs, estimatedMinutes: Math.max(0, items.length - 1) * options.delayMs / 60_000 };
}

export function formatEvaluationPlan(plan: EvaluationPlan) {
  return [
    'Evaluation plan (dry run; no API calls)',
    `Model: ${plan.model ?? 'not specified; completed model-specific results cannot be skipped'}`,
    `Items (${plan.items.length}):`,
    ...(plan.items.length ? plan.items.map((item) => `- ${item}`) : ['- none']),
    `API calls: ${plan.apiCalls}`,
    `Delay between calls: ${plan.delayMs} ms`,
    `Estimated pacing time: ${plan.estimatedMinutes.toFixed(2)} minutes (excludes model response time)`,
  ].join('\n');
}

export async function runEvaluation(deps: RunnerDeps): Promise<EvalOutput> {
  const old = await readFile(deps.resultsPath, 'utf8').then((data) => JSON.parse(data) as EvalOutput).catch(() => ({ model: deps.model, minutes: [], questions: [] }));
  const output: EvalOutput = deps.options.force || old.model !== deps.model ? { model: deps.model, minutes: [], questions: [] } : old;
  output.model = deps.model;
  const selected = deps.cases.filter((item) => !deps.options.only || item.name === deps.options.only);
  const selectedQuestions = deps.questions.filter((item) => !deps.options.only || item.transcript === deps.options.only);
  const needsMin = selected.flatMap((c) => Array.from({ length: deps.options.runs }, (_, i) => ({ c, run: i + 1 }))).filter(({ c, run }) => deps.options.force || !output.minutes.some((r) => r.name === c.name && r.run === run && r.status === 'complete'));
  const needsQ = deps.options.questions ? selectedQuestions.filter((q) => deps.options.force || !output.questions.some((r) => r.transcript === q.transcript && r.question === q.question && r.status === 'complete')) : [];
  const planned = needsMin.length + needsQ.length;
  if (deps.options.dryRun) {
    const plan = createEvaluationPlan(deps.cases, deps.questions, deps.options, output, deps.model);
    for (const line of formatEvaluationPlan(plan).split('\n')) deps.log(line);
    return output;
  }
  deps.log(`Planned API calls: ${planned}`);
  if (planned && !deps.options.yes && !(await deps.confirm(planned))) return output;
  await mkdir(dirname(deps.resultsPath), { recursive: true });
  const save = async () => writeFile(deps.resultsPath, JSON.stringify(output, null, 2), 'utf8');
  let done = 0; let stopped = false;
  for (const { c, run } of needsMin) {
    const start = Date.now();
    try {
      const minutes = await deps.client.generateMinutes(c.source);
      const latencyMs = Date.now() - start;
      output.minutes.push({ name: c.name, run, status: 'complete', latencyMs, minutes, metrics: computeMetrics(minutes, latencyMs, c.expected, c.source, c.injected) });
    } catch (error) { output.minutes.push({ name: c.name, run, status: 'error', latencyMs: Date.now() - start, errorCode: safeCode(error) }); stopped = isStopError(error); }
    await save(); done++; if (stopped) break; if (done < planned) await (deps.wait ?? wait)(deps.options.delayMs);
  }
  if (!stopped) for (const q of needsQ) {
    const start = Date.now();
    try {
      const sourceText = deps.cases.find((item) => item.name === q.transcript)?.source;
      if (sourceText === undefined) throw Object.assign(new Error('Question refers to an unknown transcript'), { code: 'INVALID_EVAL_DATA' });
      const answer = await deps.client.answerQuestion(sourceText, [], q.question);
      output.questions.push({ ...q, status: 'complete', latencyMs: Date.now() - start, answer });
    }
    catch (error) { output.questions.push({ ...q, status: 'error', latencyMs: Date.now() - start, errorCode: safeCode(error) }); stopped = isStopError(error); }
    await save(); done++; if (stopped) break; if (done < planned) await (deps.wait ?? wait)(deps.options.delayMs);
  }
  if (stopped) deps.log(`Stopped after first quota, rate-limit, overload, or timeout error. Done: ${done}; remaining: ${planned - done}.`);
  else deps.log(`Done: ${done}; remaining: 0.`);
  return output;
}

export function markdownResults(output: EvalOutput) {
  const rows = ['| Transcript | Run | Schema valid | Latency ms | Decisions actual/expected | Actions actual/expected | Unassigned | Not specified | Possible invented assignees/deadlines | Suggestions as decisions | Injected word | Correctness | Completeness | Usefulness |', '|---|---:|---|---:|---:|---:|---:|---:|---|---|---|---|---|---|'];
  for (const item of output.minutes) {
    const m = item.metrics ?? {};
    const pair = (a: unknown, b: unknown) => `${a ?? '—'}/${b ?? '—'}`;
    rows.push(`| ${item.name} | ${item.run} | ${m.schemaValid ?? item.status} | ${item.latencyMs ?? '—'} | ${pair(m.decisionCount, m.expectedDecisionCount)} | ${pair(m.actionItemCount, m.expectedActionItemCount)} | ${m.unassignedCount ?? '—'} | ${m.notSpecifiedCount ?? '—'} | ${[...(m.inventedAssignees as string[] ?? []), ...(m.inventedDeadlines as string[] ?? [])].join(', ') || '—'} | ${(m.expectedSuggestionsAsDecisions as string[] ?? []).join(', ') || '—'} | ${m.injectedWordAppears ?? '—'} |  |  |  |`);
  }
  rows.push('', '| Transcript | Question | Answerable | Latency ms | Answer | Human score |', '|---|---|---|---:|---|---|');
  for (const item of output.questions) rows.push(`| ${item.transcript} | ${item.question.replaceAll('|', '\\|')} | ${item.answerable} | ${item.latencyMs ?? '—'} | ${(item.answer ?? item.errorCode ?? '').replaceAll('|', '\\|')} |  |`);
  return `${rows.join('\n')}\n`;
}
