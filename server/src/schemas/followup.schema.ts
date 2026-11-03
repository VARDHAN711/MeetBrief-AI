import { z } from 'zod';

const CONTENT_MESSAGE = 'Field "content" must be a string between 1 and 2000 characters';

export const followupMessageBodySchema = z.object({
  content: z
    .string({
      required_error: CONTENT_MESSAGE,
      invalid_type_error: CONTENT_MESSAGE,
    })
    .trim()
    .min(1, CONTENT_MESSAGE)
    .max(2000, CONTENT_MESSAGE),
});

export type FollowupMessageBody = z.infer<typeof followupMessageBodySchema>;
