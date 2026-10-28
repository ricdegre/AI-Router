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
function affirmativeOperationText(text) {
  return text
    .replace(/\b(?:without|sin)\s+(?:changing|modifying|editing|creating|implementing|writing|touching|cambi\w*|modific\w*|edit\w*|cre\w*|implement\w*|escrib\w*|toc\w*)\b/giu, ' ')
    .replace(/\b(?:without|sin)\s+(?:(?:changing|modifying|editing|creating|implementing|writing|touching|cambi\w*|modific\w*|edit\w*|cre\w*|implement\w*|escrib\w*|toc\w*)\s+){1,4}(?:any\s+)?(?:files?|code|anything|archivos?|c[oó]digo)\b[^.;!?\n]*/giu, ' ')
    .replace(/(?:^|[.;!?\n])[^\S\r\n]*(?:no|nunca|do not|don't|never|without|sin)[^\S\r\n]+(?:[^\s.;!?\n]+[^\S\r\n]+){0,4}(?:modific\w*|cambi\w*|edit\w*|creat\w*|cre\w*|implement\w*|agreg\w*|a[nñ]ad\w*|quit\w*|elimin\w*|retir\w*|mov\w*|traslad\w*|convert\w*|reorganiz\w*|refactor\w*|chang\w*|updat\w*|writ\w*|toc\w*|touch\w*)[^.;!?\n]*/giu, ' ');
}

// Small, presentation-only edits that a light model handles well.
const COSMETIC_PATTERNS = [/\b(?:colou?r|background|fondo|font|fuente|tipograf\w*|padding|margin|margen|spacing|espaciad\w*|typo|errata|ortograf\w*|rename|renombr\w*|label|etiqueta|t[ií]tulo|title|icon|[ií]cono|css|estilos?|styles?|wording|copy|texto del|text of|alineaci[oó]n|align\w*|border|borde)\b/, /\b(?:one[- ]line|single[- ]line|una (?:sola )?l[ií]nea)\b/];
const ARCHITECTURE_ACTION = /(?:redise[ñn]\w*|re-?design\w*|diseñ\w*|design\w*|replante\w*|reestructur\w*|restructur\w*)\s+(?:(?:la|el|the|our|nuestra?)\s+)?(?:arquitectura|architecture|sistema|system)/;
const INCIDENTAL_TESTS = /\b(?:with|con|and|y|plus|m[aá]s|including|incluyendo)\s+(?:(?:sus|their|its|unit|unitarios?)\s+)?(?:tests?|pruebas?)\b/g;

function inferIntent(input, text) {
  const declared = String(input.intent ?? input.task_type ?? '').toLowerCase();
  if (TASK_INTENTS.includes(declared)) return declared;
  if (contains(text, [/code review|review (?:the )?(?:code|diff|pull request)|revis(?:a|ar) (?:el )?c[oó]digo/])) return 'code_review';
  if (contains(text, [/debug|diagnos|investigat(?:e|ing).*bug|fix (?:a )?bug|\bbug\b|no responde|no funciona|doesn't work|not working|error|fall[oa]/])) return 'debug';
  if (contains(text, [/whole project|entire project|this project|el proyecto|todo el proyecto|project analysis|analiza.*proyecto/])) return 'project_analysis';
  if (contains(text, [/research|investiga|look up|buscar en (?:la )?web|current official/])) return 'research';
  if (ARCHITECTURE_ACTION.test(text)) return 'architecture';
  if (contains(text.replace(INCIDENTAL_TESTS, ' '), [/\btest(?:s|ing)?\b|prueba(?:s)?/])) return 'test';
  if (contains(text, [/document|readme|docs|documentaci[oó]n/])) return 'documentation';
  if (contains(text, [/edit|change|modify|implement|add|remove|fix|move|relocat|convert|reorganiz|refactor|update|create|write|modific\w*|cambi\w*|implement\w*|agreg\w*|a[nñ]ad\w*|cre\w*|corrig\w*|arregl\w*|quit\w*|elimin\w*|retir\w*|mov\w*|traslad\w*|convert\w*|reorganiz\w*|reestructur\w*|refactor\w*|actualiz\w*|escrib\w*/])) return 'edit';
  if (contains(text, [/architect|arquitect|system design|diseñ[oa] (?:del )?sistema/])) return 'architecture';
  if (contains(text, [/refactor|reorganiz|reestructur/])) return 'refactor';
  return declared === 'coding' ? 'edit' : 'other';
}

function inferScope(input, text) {
  if (TASK_SCOPES.includes(input.scope)) return input.scope;
  if (input.multi_project === true || contains(text, [/multi[- ]project|multiple projects|varios proyectos/])) return 'multi-project';
  if (contains(text, [/whole (?:codebase|project)|entire (?:codebase|project)|this project|el proyecto|todo el proyecto|project-wide|codebase-wide/])) return 'project';
  if (input.selection || input.has_selection === true || contains(text, [/selected (?:text|code)|selection[- ]only|task scope.{0,24}selection|selecci[oó]n de (?:texto|c[oó]digo)|c[oó]digo seleccionado/])) return 'selection';
  if (input.active_file || contains(text, [/this file|active file|archivo actual|single file/])) return 'file';
  if (contains(text, [/module|package|m[oó]dulo|subsystem|servicio/])) return 'module';
  return contains(text, [/feature|workflow|flow|funcionalidad/]) ? 'feature' : 'feature';
}

function inferWriteMode(input, intent, text) {
  if (input.write_mode === 'read_only' || input.write_mode === 'write_allowed') return input.write_mode;
  if (input.read_only === true || contains(text, [
    /read[- ]only|solo lectura|analysis[- ]only|analiza solamente|analiza solo|revisa y dime|review and tell me/,
    /do not (?:create|change|modify|edit|write) (?:any )?(?:files?|code|anything)|without (?:changing|modifying|editing|writing|touching) (?:any )?(?:files?|code|anything)|no file changes/,
    /sin (?:tocar|modificar|cambiar|editar|escribir) (?:ning[uú]n |los |el |ninguna )?(?:archivos?|c[oó]digo)|no (?:toques|modifiques|cambies) (?:ning[uú]n |los |el |ninguna )?(?:archivos?|c[oó]digo)/
  ])) return 'read_only';
  const denied = input.action_policy?.denied ?? [];
  const writes = ['create_file', 'modify_file', 'append_file'];
  const allowed = input.action_policy?.allowed;
  if (writes.every((action) => denied.includes(action)) || (Array.isArray(allowed) && !writes.some((action) => allowed.includes(action)))) return 'read_only';
  const positive = affirmativeOperationText(text);
  if (contains(positive, [/\b(?:corrig\w*|cambi\w*|modific\w*|implement\w*|agreg\w*|a[nñ]ad\w*|cre\w*|edit\w*|arregl\w*|fix\w*|chang\w*|modify\w*|implement\w*|add\w*|creat\w*|edit\w*|updat\w*|refactor\w*|mov\w*|traslad\w*|convert\w*|reorganiz\w*|quit\w*|elimin\w*|retir\w*)\b/u])) return 'write_allowed';
  return ['project_analysis', 'code_review', 'architecture', 'research', 'test'].includes(intent) || contains(text, [/diagnos|investigat|analiz|analy[sz]|review|revisa|explica|explain/]) ? 'read_only' : 'write_allowed';
}

function requestedOperation(intent, text) {
  if (['edit', 'refactor'].includes(intent)) return 'edit';
  if (intent === 'test') return 'validate';
  if (['project_analysis', 'code_review', 'architecture', 'research'].includes(intent) || /diagnos|analiz|analy[sz]|review|revisa|explica|explain/.test(text)) return 'inspect';
  return 'other';
}

function inferComplexity(input, intent, scope, writeMode, text) {
  if (TASK_COMPLEXITIES.includes(input.complexity)) return input.complexity;
  if (contains(text, [/expert|security-critical|cross[- ]project|distributed system|migrat(?:e|ion).*architecture/]) || scope === 'multi-project') return 'expert';
  const specificationSections = [...text.matchAll(/^\s*(?:\d{1,2}[.)]|#{1,6})\s+\S/gm)].length;
  if (writeMode === 'write_allowed' && text.length >= 3_000 && specificationSections >= 6) return 'high';
  if (['architecture', 'project_analysis'].includes(intent) || scope === 'project' || contains(text, [/large refactor|major refactor|whole codebase/])) return 'high';
  if (['edit', 'documentation'].includes(intent) && scope === 'feature' && text.length < 400 && contains(text, COSMETIC_PATTERNS)) return 'low';
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
  // Only an explicit request to search or browse needs web access; "web" in page copy or file names does not.
  if (intent === 'research' || contains(text, [/\b(?:search|browse|look up|check|busca\w*|navega\w*|consulta\w*|revisa\w*)\s+(?:(?:on|in|en)\s+)?(?:the\s+|la\s+)?(?:web|internet)\b|\b(?:online|en l[ií]nea)\s+(?:search|b[uú]squeda)|current official/])) capabilities.add('web');
  if ((input.attachments ?? []).some((attachment) => attachment?.type === 'image') || contains(text, [/\b(?:images?|screenshots?|vision|imagen|im[aá]genes|capturas?)\b/])) capabilities.add('vision');
  return [...capabilities];
}

export function analyzeTask(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiRouterError('Task input is required for analysis.', 'INVALID_TASK_ANALYSIS_INPUT');
  const text = textOf(input);
  const scopeText = affirmativeScopeText(affirmativeOperationText(text));
  const intent = inferIntent(input, scopeText);
  const scope = inferScope(input, scopeText);
  const writeMode = inferWriteMode(input, intent, text);
  const complexity = inferComplexity(input, intent, scope, writeMode, text);
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
