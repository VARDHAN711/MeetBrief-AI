import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEMINI_API_KEY_REQUIRED_MESSAGE } from '../src/config/geminiApiKey.js';

function importRuntimeConfig(apiKey: string | undefined) {
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/config_test_only',
    GEMINI_MODEL: 'config-test-model',
    DOTENV_CONFIG_PATH: path.join(process.cwd(), 'tests', 'intentionally-missing-env-file'),
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
  };
  if (apiKey !== undefined) childEnv.GEMINI_API_KEY = apiKey;
  return spawnSync(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '-e', 'await import("./src/config/env.ts")',
  ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' });
}

describe('runtime environment startup validation', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
  ] as const)('fails fast with a value-free GEMINI_API_KEY message when the key is %s', (_state, apiKey) => {
    const child = importRuntimeConfig(apiKey);
    const diagnostic = `${child.stdout}${child.stderr}`;
    expect(child.status).toBe(1);
    expect(diagnostic).toContain('GEMINI_API_KEY');
    expect(diagnostic).toContain(GEMINI_API_KEY_REQUIRED_MESSAGE);
    expect(diagnostic).not.toContain('config_test_only');
  });
});
