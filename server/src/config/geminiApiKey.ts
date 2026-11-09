export const GEMINI_API_KEY_REQUIRED_MESSAGE = 'GEMINI_API_KEY is required outside tests.';

export function requireGeminiApiKey(apiKey: string | undefined): string {
  if (!apiKey?.trim()) throw new Error(GEMINI_API_KEY_REQUIRED_MESSAGE);
  return apiKey;
}
