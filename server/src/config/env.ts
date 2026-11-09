import dotenv from 'dotenv';
import { z } from 'zod';
import { GEMINI_API_KEY_REQUIRED_MESSAGE } from './geminiApiKey.js';

const isTestEnvironment = process.env.NODE_ENV === 'test';
if (!isTestEnvironment) dotenv.config({ path: process.env.DOTENV_CONFIG_PATH });

export const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: isTestEnvironment
    ? z.string().min(1, 'MONGODB_URI is required').default('mongodb://127.0.0.1:27017/meetbrief_test')
    : z.string({
        required_error: 'MONGODB_URI is required',
        invalid_type_error: 'MONGODB_URI must be a string',
      }).min(1, 'MONGODB_URI is required'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_LOG_ERROR_DETAILS: z.enum(['true', 'false']).optional().default('false'),
  GEMINI_MODEL: isTestEnvironment
    ? z.string().min(1, 'GEMINI_MODEL is required').default('test-model')
    : z.string({
        required_error: 'GEMINI_MODEL is required',
        invalid_type_error: 'GEMINI_MODEL must be a string',
      }).min(1, 'GEMINI_MODEL is required'),
  GEMINI_TIMEOUT_MS: z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.coerce.number({
      invalid_type_error: 'GEMINI_TIMEOUT_MS must be a number',
    }).int().positive().default(60_000)
  ),
  GEMINI_TRANSCRIBE_TIMEOUT_MS: z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.coerce.number({
      invalid_type_error: 'GEMINI_TRANSCRIBE_TIMEOUT_MS must be a number',
    }).int().positive().default(300_000)
  ),
  CLIENT_ORIGIN: z.string({
    required_error: 'CLIENT_ORIGIN is required',
    invalid_type_error: 'CLIENT_ORIGIN must be a string',
  }).min(1, 'CLIENT_ORIGIN is required').default('http://localhost:5173'),
  MAX_TEXT_CHARS: z.coerce.number().default(200000),
  MAX_AUDIO_MB: z.coerce.number().default(25),
  MAX_DOC_MB: z.coerce.number().default(10),
}).superRefine((values, context) => {
  if (process.env.NODE_ENV !== 'test' && !values.GEMINI_API_KEY?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEMINI_API_KEY'],
      message: GEMINI_API_KEY_REQUIRED_MESSAGE,
    });
  }
});

export function formatEnvironmentIssues(issues: readonly z.ZodIssue[]): string[] {
  const names = issues.map((issue) => issue.path.join('.')).filter(Boolean).join(', ');
  return [
    `Missing or invalid environment variable(s): ${names || 'configuration error'}`,
    ...issues.map((issue) => {
      const varName = issue.path.join('.') || 'variable';
      return `  - ${varName}: ${issue.message}`;
    }),
  ];
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  formatEnvironmentIssues(parsed.error.issues).forEach((line) => console.error(line));
  process.exit(1);
}

export const env = parsed.data;
