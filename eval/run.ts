import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GEMINI_API_KEY_REQUIRED_MESSAGE, requireGeminiApiKey } from '../server/src/config/geminiApiKey.js';
import { createEvaluationPlan, formatEvaluationPlan, runEvaluation, markdownResults, type EvalCase, type EvalOptions, type EvalQuestion, type EvalOutput } from './runner.js';

const HELP = `Usage: npm run eval -- [options]
  --only <name>       Run one transcript (and its questions if requested)
  --runs <n>           Minutes runs per transcript (default 1)
  --questions          Include independent follow-up questions
  --delay-ms <n>       Pause between API calls (default 15000)
  --force              Redo completed items
  --yes                Skip confirmation
  --dry-run            Print the plan and exit without loading API configuration
  --help               Show options`;
function parse(args: string[]): EvalOptions & { help: boolean } {
  const options: EvalOptions & { help: boolean } = { runs: 1, questions: false, delayMs: 15000, force: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--questions') options.questions = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i];
    else if (arg === '--runs' && args[i + 1]) options.runs = Number(args[++i]);
    else if (arg === '--delay-ms' && args[i + 1]) options.delayMs = Number(args[++i]);
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || !Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error('--runs must be a positive integer and --delay-ms a nonnegative integer');
  return options;
}

const options = parse(process.argv.slice(2));
if (options.help) { console.log(HELP); process.exit(0); }
const root = resolve(import.meta.dirname, '..');
const loadCases = async (): Promise<EvalCase[]> => {
  const base = join(root, 'eval/transcripts'); const names = (await readdir(base)).filter((file) => file.endsWith('.txt'));
  return Promise.all(names.map(async (file) => {
    const name = file.slice(0, -4); const expected = JSON.parse(await readFile(join(root, 'eval/expected', `${name}.json`), 'utf8')) as EvalCase['expected'];
    return { name, source: await readFile(join(base, file), 'utf8'), expected, injected: name === 'injection' };
  }));
};
const cases = await loadCases();
const questions = JSON.parse(await readFile(join(root, 'eval/questions.json'), 'utf8')) as EvalQuestion[];
if (options.dryRun) {
  const model = process.env.GEMINI_MODEL;
  const resultPath = model ? join(root, 'eval/results', `${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`) : '';
  const previous = resultPath ? await readFile(resultPath, 'utf8').then((data) => JSON.parse(data) as EvalOutput).catch(() => undefined) : undefined;
  console.log(formatEvaluationPlan(createEvaluationPlan(cases, questions, options, previous, model)));
  process.exit(0);
}
const { env } = await import('../server/src/config/env.js');
try { requireGeminiApiKey(env.GEMINI_API_KEY); } catch { console.error(GEMINI_API_KEY_REQUIRED_MESSAGE); process.exit(1); }
const { getLlmClient } = await import('../server/src/services/llm.service.js');
const output = await runEvaluation({
  client: getLlmClient(), model: env.GEMINI_MODEL, cases, questions, options,
  resultsPath: join(root, 'eval/results', `${env.GEMINI_MODEL.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`),
  confirm: async (calls) => { const readline = await import('node:readline/promises'); const io = readline.createInterface({ input: process.stdin, output: process.stdout }); try { return /^y(es)?$/i.test(await io.question(`This will make ${calls} API calls. Continue? [y/N] `)); } finally { io.close(); } },
  log: (line) => console.log(line),
});
await mkdir(join(root, 'eval/results'), { recursive: true });
await writeFile(join(root, 'eval/results', `${env.GEMINI_MODEL.replace(/[^a-zA-Z0-9_.-]/g, '_')}.md`), markdownResults(output), 'utf8');
