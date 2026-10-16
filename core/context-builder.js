import { readFile } from 'node:fs/promises';
import { inspectProject, contextPathAllowed } from './project-inspector.js';
import { resolveSafePath } from './safe-path.js';
import { AiRouterError } from './errors.js';
import { sha256 } from '../artp/contracts.js';

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
    // Still capped per model by its context window; 16K characters starved multi-file tasks.
    this.defaultBudgetChars = options.defaultBudgetChars ?? 96_000;
  }

  async safeRead(projectId, name) {
    try { return await readFile(this.memoryManager.file(projectId, name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }

  plan(task, options = {}) {
    const requiredFiles = task.context_policy?.required_files ?? [];
    if (!Array.isArray(requiredFiles) || requiredFiles.length > (task.artp ? 32 : 4) || requiredFiles.some((item) => typeof item !== 'string' || !item.trim()) || new Set(requiredFiles).size !== requiredFiles.length) throw new AiRouterError('Required context files must be unique paths.', 'INVALID_CONTEXT_PLAN');
    if (requiredFiles.length && !options.workspacePath) throw new AiRouterError('Required source files need a workspace.', 'MANDATORY_CONTEXT_UNAVAILABLE');
    return { plan_version: '0.2', required_files: requiredFiles, scope: task.filesystem_scope ?? { allowed_paths: ['.'], denied_paths: [] }, workspace_path: options.workspacePath ?? null,
      mandatory: ['task', 'attachments', 'constraints', 'effective_policy', ...requiredFiles.map((file) => `file:${file}`)],
      optional: task.artp ? ['project_inspection', 'relevant_decisions', 'project_context'] : ['project_inspection', 'handoff', 'current_task', 'changed_files', 'relevant_decisions', 'project_context', 'recent_changelog'],
      reasons: Object.fromEntries(requiredFiles.map((file) => [`file:${file}`, 'explicit ARTP scope or reference'])) };
  }

  async render(projectId, task, plan, options = {}) {
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
    if (plan.workspace_path && plan.scope.workspace_path && plan.scope.workspace_path !== plan.workspace_path) throw new AiRouterError('Context workspace does not match task scope.', 'CONTEXT_SCOPE_MISMATCH');
    const requiredSources = []; const fileManifest = [];
    for (const name of plan.required_files) {
      if (!contextPathAllowed(name, plan.scope)) throw new AiRouterError('Required context file is outside authorized scope.', 'CONTEXT_FILE_UNSAFE');
      const safe = await resolveSafePath(plan.workspace_path, name, { mustExist: true });
      const content = await readFile(safe.path, 'utf8');
      if (content.includes('\0')) throw new AiRouterError('Required context file is not text.', 'CONTEXT_FILE_UNSAFE');
      requiredSources.push(`FILE: ${name}\nSHA-256: ${sha256(content)}\nEXACT CONTENT:\n${content}`);
      fileManifest.push({ path: name, sha256: sha256(content), chars: content.length, mode: 'full', mandatory: true, reason: plan.reasons?.[`file:${name}`] ?? 'required file' });
    }
    const projectInspection = options.workspacePath ? await inspectProject(options.workspacePath, task, { budgetChars: Math.min(80_000, Math.max(3_000, Math.floor(budgetChars * 0.85))), scope: plan.scope, excludeFiles: plan.required_files }) : null;
    const latestCheckpoint = memory.checkpoints.at(-1) ?? null;
    const candidates = [
      ['task', JSON.stringify({ task_id: task.task_id, objective: task.objective, instruction: task.prompt ?? '', acceptance_criteria: task.acceptance_criteria ?? [], requested_action_type: task.requested_action_type ?? null }, null, 2)],
      ['attachments', task.attachments?.length ? JSON.stringify(task.attachments.map(({ source: _source, filename: _filename, ...attachment }) => attachment), null, 2) : ''],
      ['constraints', JSON.stringify({ protocol_constraints: memory.currentTask?.constraints ?? [], do_not_modify: memory.currentTask?.do_not_modify ?? [], durable_constraints: raw.constraints }, null, 2)],
      ['effective_policy', JSON.stringify({ action_policy: task.action_policy ?? {}, filesystem_scope: { allowed_paths: plan.scope.allowed_paths ?? ['.'], denied_paths: plan.scope.denied_paths ?? [] }, validation_requirements: task.validation_requirements ?? [] }, null, 2)],
      ['required_sources', requiredSources.join('\n\n')],
      ['project_inspection', projectInspection?.rendered ?? ''],
      ['handoff', JSON.stringify(memory.handoff ?? {}, null, 2)],
      ['current_task', JSON.stringify(memory.currentTask ?? {}, null, 2)],
      ['changed_files', JSON.stringify(latestCheckpoint?.changedFiles ?? [], null, 2)],
      ['relevant_decisions', relevantExcerpt(raw.decisions, terms, 3_000)],
      ['project_context', relevantExcerpt(raw.context, terms, 3_000)],
      ['recent_changelog', raw.changelog.slice(-3_000)]
    ];
    const mandatoryNames = new Set(['task', 'attachments', 'constraints', 'effective_policy', 'required_sources']);
    const mandatory = candidates.filter(([name, content]) => mandatoryNames.has(name) && content).map(([name, content]) => ({ name, content, truncated: false }));
    const mandatoryChars = mandatory.map(({ name, content }) => `## ${name}\n${content}`).join('\n\n').length;
    if (mandatoryChars > budgetChars) throw new AiRouterError('Required task, policy, image references or source text exceeds candidate context budget.', 'MANDATORY_CONTEXT_TOO_LARGE', { required_chars: mandatoryChars, budget_chars: budgetChars });
    const minimumAllocation = {
      handoff: 100, current_task: 120,
      project_inspection: 1_000, changed_files: 40, relevant_decisions: 160, project_context: 100,
      recent_changelog: 60
    };
    const sections = [...mandatory];
    let used = mandatoryChars;
    const optional = candidates.filter(([name]) => !mandatoryNames.has(name) && (!task.artp || plan.optional.includes(name)));
    for (let index = 0; index < optional.length; index += 1) {
      const [name, content] = optional[index];
      if (!content) continue;
      const header = `## ${name}\n`;
      const future = optional.slice(index + 1).reduce((total, [futureName, futureContent]) => {
        if (!futureContent) return total;
        return total + Math.min(futureContent.length, minimumAllocation[futureName] ?? 0) + `## ${futureName}\n`.length + 2;
      }, 0);
      const available = Math.max(0, budgetChars - used - header.length - 2 - future);
      if (available <= 0) continue;
      const selected = content.slice(0, available);
      sections.push({ name, content: selected, truncated: selected.length < content.length });
      used += header.length + selected.length + 2;
    }
    const rendered = sections.map((section) => `## ${section.name}\n${section.content}`).join('\n\n');
    return {
      context_protocol_version: '0.1', project_id: projectId, task_id: task.task_id, plan,
      budget_chars: budgetChars, used_chars: rendered.length, approximate_tokens: approximateTokens(rendered),
      sections, file_manifest: [...fileManifest, ...(projectInspection?.included_file_metadata ?? []).filter((item) => sections.find((section) => section.name === 'project_inspection')?.content.includes(`FILE: ${item.path}\n`))],
      omitted: optional.filter(([name, content]) => content && !sections.some((section) => section.name === name)).map(([name]) => ({ name, reason: 'context budget' })),
      project_inspection: projectInspection ? { ...projectInspection, rendered: undefined } : null, rendered
    };
  }

  async build(projectId, task, options = {}) { return this.render(projectId, task, this.plan(task, options), options); }
}
