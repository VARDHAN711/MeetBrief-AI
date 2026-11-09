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

export function formatMinutesToText(minutes: Minutes): string {
  const lines = [minutes.title, '', 'Summary', minutes.summary];
  if (minutes.decisions.length) {
    lines.push('', 'Key Decisions', ...minutes.decisions.map(d => d.context ? `- ${d.decision} — ${d.context}` : `- ${d.decision}`));
  }
  if (minutes.actionItems.length) {
    lines.push('', 'Action Items');
    for (const item of minutes.actionItems) lines.push(`Task: ${item.task}`, `Assignee: ${item.assignee || 'Unassigned'}`, `Deadline: ${item.deadline || 'Not specified'}`, '');
  }
  if (minutes.suggestions.length) lines.push('', 'Suggestions', ...minutes.suggestions.map(item => `- ${item.text}`));
  if (minutes.pendingIssues.length) lines.push('', 'Pending Issues', ...minutes.pendingIssues.map(item => `- ${item.kind.replace(/_/g, ' ')}: ${item.issue}`));
  if (minutes.limitations.length) lines.push('', 'Notes and Limitations', ...minutes.limitations.map(item => `- ${item}`));
  return lines.join('\n').trim();
}

