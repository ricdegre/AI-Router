import { readFile } from 'node:fs/promises';
import { inspectProject } from './project-inspector.js';

function approximateTokens(text) { return Math.ceil(text.length / 4); }

function taskTerms(task) {
  return new Set(String(task.objective ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4));
}

function relevantExcerpt(content, terms, limit) {
  const paragraphs = content.split(/\r?\n\s*\r?\n/).filter(Boolean);
  const matches = paragraphs.filter((paragraph) => [...terms].some((term) => paragraph.toLowerCase().includes(term)));
  return (matches.length ? matches : paragraphs).join('\n\n').slice(0, limit);
}

export class ContextBuilder {
  constructor(memoryManager, options = {}) {
    this.memoryManager = memoryManager;
    this.defaultBudgetChars = options.defaultBudgetChars ?? 16_000;
  }

  async safeRead(projectId, name) {
    try { return await readFile(this.memoryManager.file(projectId, name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }

  async build(projectId, task, options = {}) {
    const memory = await this.memoryManager.summary(projectId);
    const tokenLimit = options.providerContextTokens ?? null;
    const requestedChars = options.budgetChars ?? this.defaultBudgetChars;
    const budgetChars = tokenLimit ? Math.min(requestedChars, Math.floor(tokenLimit * 4 * 0.7)) : requestedChars;
    const terms = taskTerms(task);
    const raw = {
      constraints: await this.safeRead(projectId, 'constraints.md'),
      context: await this.safeRead(projectId, 'context.md'),
      decisions: await this.safeRead(projectId, 'decisions.md'),
      changelog: await this.safeRead(projectId, 'ai-changelog.md')
    };
    const projectInspection = options.workspacePath ? await inspectProject(options.workspacePath, task, { budgetChars: Math.min(10_000, Math.max(3_000, Math.floor(budgetChars * 0.65))) }) : null;
    const latestCheckpoint = memory.checkpoints.at(-1) ?? null;
    const candidates = [
      ['task', JSON.stringify({ task_id: task.task_id, objective: task.objective, acceptance_criteria: task.acceptance_criteria ?? [], requested_action_type: task.requested_action_type ?? null }, null, 2)],
      ['attachments', task.attachments?.length ? JSON.stringify(task.attachments.map(({ source: _source, ...attachment }) => attachment), null, 2) : ''],
      ['constraints', JSON.stringify({ protocol_constraints: memory.currentTask?.constraints ?? [], do_not_modify: memory.currentTask?.do_not_modify ?? [], durable_constraints: relevantExcerpt(raw.constraints, terms, 3_000) }, null, 2)],
      ['project_inspection', projectInspection?.rendered ?? ''],
      ['handoff', JSON.stringify(memory.handoff ?? {}, null, 2)],
      ['current_task', JSON.stringify(memory.currentTask ?? {}, null, 2)],
      ['changed_files', JSON.stringify(latestCheckpoint?.changedFiles ?? [], null, 2)],
      ['relevant_decisions', relevantExcerpt(raw.decisions, terms, 3_000)],
      ['project_context', relevantExcerpt(raw.context, terms, 3_000)],
      ['recent_changelog', raw.changelog.slice(-3_000)]
    ];
    const minimumAllocation = {
      task: 120, attachments: 100, constraints: 180, handoff: 100, current_task: 120,
      project_inspection: 1_000, changed_files: 40, relevant_decisions: 160, project_context: 100,
      recent_changelog: 60
    };
    const sections = [];
    let used = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const [name, content] = candidates[index];
      if (!content) continue;
      const header = `## ${name}\n`;
      const future = candidates.slice(index + 1).reduce((total, [futureName, futureContent]) => {
        if (!futureContent) return total;
        return total + Math.min(futureContent.length, minimumAllocation[futureName] ?? 0) + `## ${futureName}\n`.length + 2;
      }, 0);
      const available = Math.max(0, budgetChars - used - header.length - future);
      if (available <= 0) break;
      const selected = content.slice(0, available);
      sections.push({ name, content: selected, truncated: selected.length < content.length });
      used += header.length + selected.length + 2;
    }
    const rendered = sections.map((section) => `## ${section.name}\n${section.content}`).join('\n\n');
    return {
      context_protocol_version: '0.1', project_id: projectId, task_id: task.task_id,
      budget_chars: budgetChars, used_chars: rendered.length, approximate_tokens: approximateTokens(rendered),
      sections, project_inspection: projectInspection ? { ...projectInspection, rendered: undefined } : null, rendered
    };
  }
}
