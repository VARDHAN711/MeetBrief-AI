import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string({
    required_error: 'MONGODB_URI is required',
    invalid_type_error: 'MONGODB_URI must be a string',
  }).min(1, 'MONGODB_URI is required'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string({
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues;
  const names = issues.map((i) => i.path.join('.')).filter(Boolean).join(', ');
  console.error(`Missing or invalid environment variable(s): ${names || 'configuration error'}`);
  issues.forEach((issue) => {
    const varName = issue.path.join('.') || 'variable';
    console.error(`  - ${varName}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
