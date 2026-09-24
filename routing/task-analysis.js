import { AiRouterError } from '../core/errors.js';

export const TASK_ANALYSIS_VERSION = '0.1';
export const TASK_INTENTS = Object.freeze(['edit', 'debug', 'project_analysis', 'code_review', 'architecture', 'research', 'refactor', 'test', 'documentation', 'other']);
export const TASK_SCOPES = Object.freeze(['selection', 'file', 'module', 'feature', 'project', 'multi-project']);
export const TASK_COMPLEXITIES = Object.freeze(['trivial', 'low', 'medium', 'high', 'expert']);

const STRENGTH_BY_COMPLEXITY = Object.freeze({ trivial: 'basic', low: 'basic', medium: 'standard', high: 'strong', expert: 'strong' });
const ROUTABLE_CAPABILITIES = new Set(['coding', 'long_context', 'vision', 'web', 'tool_use']);

function textOf(input) { return `${input.objective ?? ''}\n${input.instruction ?? ''}`.toLowerCase(); }
function contains(text, patterns) { return patterns.some((pattern) => pattern.test(text)); }
function affirmativeScopeText(text) {
  return text.replace(/(?:^|[.;!?\n])[^\S\r\n]*(?:no|nunca|do not|don't|never|without|sin)[^\S\r\n]+(?:[^\s.;!?\n]+[^\S\r\n]+){0,3}(?:anali[zc]\w*|analy[sz]\w*|revis\w*|review\w*|inspect\w*|inspeccion\w*)[^.;!?\n]*/giu, ' ');
}

function inferIntent(input, text) {
  const declared = String(input.intent ?? input.task_type ?? '').toLowerCase();
  if (TASK_INTENTS.includes(declared)) return declared;
  if (contains(text, [/code review|review (?:the )?(?:code|diff|pull request)|revis(?:a|ar) (?:el )?c[oó]digo/])) return 'code_review';
  if (contains(text, [/architect|arquitect|system design|diseñ[oa] (?:del )?sistema/])) return 'architecture';
  if (contains(text, [/refactor|reorganiz|reestructur/])) return 'refactor';
  if (contains(text, [/debug|diagnos|investigat(?:e|ing).*bug|fix (?:a )?bug|error|fall[oa]/])) return 'debug';
  if (contains(text, [/whole project|entire project|this project|el proyecto|todo el proyecto|project analysis|analiza.*proyecto/])) return 'project_analysis';
  if (contains(text, [/research|investiga|look up|buscar en (?:la )?web|current official/])) return 'research';
  if (contains(text, [/\btest(?:s|ing)?\b|prueba(?:s)?/])) return 'test';
  if (contains(text, [/document|readme|docs|documentaci[oó]n/])) return 'documentation';
  if (contains(text, [/edit|change|modify|implement|add|remove|fix|corrige|cambia|modifica|implementa|agrega/])) return 'edit';
  return declared === 'coding' ? 'edit' : 'other';
}

function inferScope(input, text) {
  if (TASK_SCOPES.includes(input.scope)) return input.scope;
  if (input.multi_project === true || contains(text, [/multi[- ]project|multiple projects|varios proyectos/])) return 'multi-project';
  if (contains(text, [/whole (?:codebase|project)|entire (?:codebase|project)|this project|el proyecto|todo el proyecto|project-wide|codebase-wide/])) return 'project';
  if (input.selection || input.has_selection === true || contains(text, [/selected (?:text|code)|selection|selecci[oó]n/])) return 'selection';
  if (input.active_file || contains(text, [/this file|active file|archivo actual|single file/])) return 'file';
  if (contains(text, [/module|package|m[oó]dulo|subsystem|servicio/])) return 'module';
  return contains(text, [/feature|workflow|flow|funcionalidad/]) ? 'feature' : 'feature';
}

function inferWriteMode(input, intent, text) {
  if (input.write_mode === 'read_only' || input.write_mode === 'write_allowed') return input.write_mode;
  if (input.read_only === true || contains(text, [
    /read[- ]only|solo lectura|analysis[- ]only|analiza solamente|analiza solo|revisa y dime|review and tell me/,
    /do not (?:create|change|modify|write) (?:any )?(?:files?|code|anything)|without (?:changing|modifying|writing|touching) (?:any )?(?:files?|code|anything)|no file changes/,
    /sin (?:tocar|modificar|cambiar|editar|escribir) (?:ning[uú]n |los |el |ninguna )?(?:archivos?|c[oó]digo)|no (?:toques|modifiques|cambies) (?:ning[uú]n |los |el |ninguna )?(?:archivos?|c[oó]digo)/
  ])) return 'read_only';
  const denied = input.action_policy?.denied ?? [];
  const writes = ['create_file', 'modify_file', 'append_file'];
  const allowed = input.action_policy?.allowed;
  if (writes.every((action) => denied.includes(action)) || (Array.isArray(allowed) && !writes.some((action) => allowed.includes(action)))) return 'read_only';
  const positive = text.replace(/(?:\bno|do not|don't)\s+(?:cambies?|modifiques?|edites?|alteres?|change|modify|edit|alter)\b[^.;\n]*/gu, '');
  if (contains(positive, [/\b(?:corrige|cambia|modifica|implementa|agrega|a[nñ]ade|crea|edita|arregla|fix|change|modify|implement|add|create|edit|update|refactor)\b/u])) return 'write_allowed';
  return ['project_analysis', 'code_review', 'architecture', 'research', 'test'].includes(intent) || contains(text, [/diagnos|investigat|analiz|analy[sz]|review|revisa|explica|explain/]) ? 'read_only' : 'write_allowed';
}

function requestedOperation(intent, text) {
  if (['edit', 'refactor'].includes(intent)) return 'edit';
  if (intent === 'test') return 'validate';
  if (['project_analysis', 'code_review', 'architecture', 'research'].includes(intent) || /diagnos|analiz|analy[sz]|review|revisa|explica|explain/.test(text)) return 'inspect';
  return 'other';
}

function inferComplexity(input, intent, scope, text) {
  if (TASK_COMPLEXITIES.includes(input.complexity)) return input.complexity;
  if (contains(text, [/expert|security-critical|cross[- ]project|distributed system|migrat(?:e|ion).*architecture/]) || scope === 'multi-project') return 'expert';
  if (['architecture', 'project_analysis'].includes(intent) || scope === 'project' || contains(text, [/large refactor|major refactor|whole codebase/])) return 'high';
  if (['debug', 'refactor', 'code_review'].includes(intent) || ['module', 'feature'].includes(scope)) return 'medium';
  if (scope === 'file') return 'low';
  return scope === 'selection' ? 'trivial' : 'low';
}

function deriveCapabilities(input, intent, scope, writeMode, text) {
  const capabilities = new Set(input.required_capabilities ?? []);
  capabilities.add('filesystem_read');
  if (writeMode === 'write_allowed') capabilities.add('filesystem_write');
  if (scope === 'project' || scope === 'multi-project' || ['project_analysis', 'code_review', 'architecture', 'refactor'].includes(intent)) capabilities.add('repository_navigation');
  if (['edit', 'debug', 'project_analysis', 'code_review', 'architecture', 'refactor', 'test'].includes(intent)) capabilities.add('code_understanding');
  if (['edit', 'debug', 'refactor', 'test'].includes(intent)) capabilities.add('coding');
  if (intent === 'architecture') capabilities.add('architecture_reasoning');
  if (scope === 'project' || scope === 'multi-project' || intent === 'architecture') capabilities.add('long_context');
  if (intent === 'research' || contains(text, [/\bweb\b|internet|online|current official/])) capabilities.add('web');
  if ((input.attachments ?? []).some((attachment) => attachment?.type === 'image') || contains(text, [/image|screenshot|vision|imagen|captura/])) capabilities.add('vision');
  return [...capabilities];
}

export function analyzeTask(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiRouterError('Task input is required for analysis.', 'INVALID_TASK_ANALYSIS_INPUT');
  const text = textOf(input);
  const scopeText = affirmativeScopeText(text);
  const intent = inferIntent(input, scopeText);
  const scope = inferScope(input, scopeText);
  const writeMode = inferWriteMode(input, intent, text);
  const complexity = inferComplexity(input, intent, scope, scopeText);
  const requiredCapabilities = deriveCapabilities(input, intent, scope, writeMode, text);
  const routingCapabilities = [...new Set(requiredCapabilities.flatMap((capability) => {
    if (ROUTABLE_CAPABILITIES.has(capability)) return [capability];
    if (capability === 'filesystem_read') return [];
    if (['code_understanding', 'repository_navigation', 'filesystem_write'].includes(capability)) return ['coding'];
    if (capability === 'architecture_reasoning') return ['coding', 'long_context'];
    return [capability];
  }))];
  const requiredStrength = input.minimum_strength ?? STRENGTH_BY_COMPLEXITY[complexity];
  const contextRequirement = ['project', 'multi-project'].includes(scope) ? 'high' : scope === 'selection' ? 'low' : 'medium';
  const attachmentSummary = { count: input.attachments?.length ?? 0, image_count: (input.attachments ?? []).filter((attachment) => attachment?.type === 'image').length };
  return {
    task_analysis_version: TASK_ANALYSIS_VERSION,
    intent, scope, requested_operation: requestedOperation(intent, text),
    write_permission: writeMode === 'read_only' ? 'denied' : 'allowed',
    prohibited_operations: [...new Set(input.action_policy?.denied ?? [])],
    scope_restrictions: [...new Set(input.do_not_modify ?? [])],
    write_mode: writeMode, complexity,
    required_capabilities: requiredCapabilities,
    routing_capabilities: routingCapabilities,
    required_strength: requiredStrength,
    risk: input.risk ?? 'low',
    context_requirement: contextRequirement, attachments: attachmentSummary, vision_required: requiredCapabilities.includes('vision'),
    parallelizable: scope === 'multi-project' || (scope === 'project' && ['project_analysis', 'code_review', 'test', 'documentation'].includes(intent))
  };
}
