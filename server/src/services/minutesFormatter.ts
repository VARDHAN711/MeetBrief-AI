import type { Minutes } from '../schemas/minutes.schema.js';

export function formatMinutesToMarkdown(minutes: Minutes): string {
  const sections: string[] = [];

  sections.push(`# ${minutes.title}\n`);

  sections.push(`## Summary\n\n${minutes.summary}\n`);

  if (minutes.decisions && minutes.decisions.length > 0) {
    sections.push('## Key Decisions\n');
    for (const d of minutes.decisions) {
      if (d.context) {
        sections.push(`- **${d.decision}** — *${d.context}*`);
      } else {
        sections.push(`- **${d.decision}**`);
      }
    }
    sections.push('');
  }

  if (minutes.actionItems && minutes.actionItems.length > 0) {
    sections.push('## Action Items\n');
    sections.push('| Task | Assignee | Deadline |');
    sections.push('| :--- | :--- | :--- |');
    for (const item of minutes.actionItems) {
      const assignee = item.assignee || 'Unassigned';
      const deadline = item.deadline || 'Not specified';
      sections.push(`| ${item.task} | ${assignee} | ${deadline} |`);
    }
    sections.push('');
  }

  if (minutes.suggestions && minutes.suggestions.length > 0) {
    sections.push('## Suggestions\n');
    for (const s of minutes.suggestions) {
      sections.push(`- ${s.text}`);
    }
    sections.push('');
  }

  if (minutes.pendingIssues && minutes.pendingIssues.length > 0) {
    sections.push('## Pending Issues\n');
    for (const p of minutes.pendingIssues) {
      const kindLabel = p.kind.replace(/_/g, ' ');
      sections.push(`- [${kindLabel}] ${p.issue}`);
    }
    sections.push('');
  }

  if (minutes.limitations && minutes.limitations.length > 0) {
    sections.push('## Notes & Limitations\n');
    for (const lim of minutes.limitations) {
      sections.push(`- ${lim}`);
    }
    sections.push('');
  }

  return sections.join('\n').trim();
}

