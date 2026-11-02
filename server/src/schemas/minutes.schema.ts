import { z } from 'zod';

export const DecisionSchema = z.object({
  decision: z.string(),
  context: z.string().optional(),
});

export const ActionItemSchema = z.object({
  task: z.string(),
  assignee: z.string(),
  deadline: z.string(),
});

export const SuggestionSchema = z.object({
  text: z.string(),
});

export const PendingIssueSchema = z.object({
  issue: z.string(),
  kind: z.enum(['open_question', 'unassigned_task', 'needs_discussion']),
});

export const MinutesSchema = z.object({
  title: z.string(),
  summary: z.string(),
  decisions: z.array(DecisionSchema),
  actionItems: z.array(ActionItemSchema),
  suggestions: z.array(SuggestionSchema),
  pendingIssues: z.array(PendingIssueSchema),
  limitations: z.array(z.string()),
});

export type Decision = z.infer<typeof DecisionSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type PendingIssue = z.infer<typeof PendingIssueSchema>;
export type Minutes = z.infer<typeof MinutesSchema>;

