import { AiRouterError } from '../core/errors.js';
import { ACTION_TYPES } from '../actions/action-mediator.js';
import { analyzeTask } from '../routing/task-analysis.js';
import { resolveSafePath } from '../core/safe-path.js';
import { parseArtp } from './parser.js';
import { ARTP_VERSION, CONTEXT_MANIFEST_VERSION, FUTURE_EXECUTION_ENVELOPE, sha256 } from './contracts.js';
import { safeArtpPath } from './alias-store.js';

const WRITES = new Set(['create_file', 'modify_file', 'append_file']);
const KNOWN_DENIALS = new Set([...ACTION_TYPES, 'delete_file', 'move_file', 'execute_shell']);
const READ_ONLY_ACTIONS = ['read_file', 'list_directory', 'inspect_git_status'];
const SECRET_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:sk-proj-|ghp_)[A-Za-z0-9_-]{12,}|Authorization\s*:\s*Bearer\s+\S+/i;

function policyList(value, field) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new AiRouterError(`Invalid trusted ${field} policy.`, 'ARTP_POLICY_CONFLICT');
  return value;
}

function intersectPaths(left, right) {
  const result = [];
  for (const a of left) for (const b of right) {
    if (a === '.' || b === a || b.startsWith(`${a}/`)) result.push(b);
    else if (b === '.' || a.startsWith(`${b}/`)) result.push(a);
  }
  return [...new Set(result)];
}

function projectRef(value) { return /^[a-z0-9][a-z0-9-]{2,79}$/.test(value); }
function validationRef(value) {
  const match = /^validation:([a-z0-9][a-z0-9._-]{1,79})$/.exec(value);
  if (!match) throw new AiRouterError('TEST must reference a registered validation ID.', 'ARTP_VALIDATION_INVALID');
  return match[1];
}

export class ArtpCompiler {
  constructor({ projectRegistry, aliasStore, attachmentStore, validationRegistry = new Map(), globalPolicy = {}, projectPolicy = {}, workspacePolicy = {}, taskPermissions = {} }) {
    Object.assign(this, { projectRegistry, aliasStore, attachmentStore, validationRegistry, globalPolicy, projectPolicy, workspacePolicy, taskPermissions });
  }

  async preview({ descriptor, draft_id = null, attachment_ids = [], write_authorized = false }) {
    const parsed = parseArtp(descriptor);
    if (SECRET_PATTERN.test(descriptor)) throw new AiRouterError('ARTP must not contain credentials or private keys.', 'ARTP_SECRET_REJECTED');
    if (!Array.isArray(attachment_ids) || attachment_ids.length > 4) throw new AiRouterError('Attachment references are invalid.', 'ARTP_ATTACHMENT_INVALID');
    const fields = parsed.fields;
    let project; const used = new Map();
    if (fields.P.startsWith('@')) {
      const alias = await this.aliasStore.current(fields.P);
      if (alias.type !== 'PROJECT') throw new AiRouterError('P requires a PROJECT alias.', 'ARTP_ALIAS_TYPE');
      project = await this.projectRegistry.get(alias.content.project_id);
      used.set(`${alias.scope}:${alias.owner_id}:${alias.alias_id}`, alias);
    } else {
      if (!projectRef(fields.P)) throw new AiRouterError('P must be a registered project ID or PROJECT alias.', 'ARTP_PROJECT_INVALID');
      project = await this.projectRegistry.get(fields.P);
    }
    const expand = async (value, expectedType) => {
      const records = await this.aliasStore.expand(value, project);
      const root = records.at(-1);
      if (root.type !== expectedType) throw new AiRouterError(`Alias @${root.alias_id} is not ${expectedType}.`, 'ARTP_ALIAS_TYPE');
      if (records.some((record) => record.type === 'PROJECT' || record.type === 'SCOPE' && expectedType !== 'SCOPE')) throw new AiRouterError('Alias dependency has no valid meaning in this field.', 'ARTP_ALIAS_TYPE');
      for (const record of records) used.set(`${record.scope}:${record.owner_id}:${record.alias_id}:${record.revision}`, record);
      return records;
    };

    let scope = ['.']; const requestedPaths = []; const forbiddenPaths = []; const forbiddenOps = []; const preserve = []; const advisory = []; const references = []; const validatorIds = [];
    const applyRecord = (record) => {
      if (record.type === 'CONSTRAINT') {
        preserve.push(...record.content.preserve); advisory.push(...record.content.advisory);
        forbiddenPaths.push(...record.content.denied_paths); forbiddenOps.push(...record.content.denied_operations);
      } else if (record.type === 'REFERENCE') references.push(...record.content.references);
      else if (record.type === 'VALIDATION_SET') validatorIds.push(...record.content.validation_ids);
    };
    for (const entry of fields.F ?? []) {
      if (entry.startsWith('@')) {
        const records = await expand(entry, 'SCOPE');
        const paths = records.filter((item) => item.type === 'SCOPE').flatMap((item) => item.content.paths);
        if (!paths.length) throw new AiRouterError('Scope alias has no paths.', 'ARTP_SCOPE_INVALID');
        requestedPaths.push(...paths);
        records.forEach(applyRecord);
      } else if (entry.startsWith('path:')) requestedPaths.push(safeArtpPath(entry.slice(5)));
      else throw new AiRouterError('F accepts only path: references or SCOPE aliases.', 'ARTP_SCOPE_INVALID');
    }
    for (const entry of fields.KEEP ?? []) {
      if (entry.startsWith('@')) (await expand(entry, 'CONSTRAINT')).forEach(applyRecord);
      else advisory.push(entry);
    }
    for (const entry of fields.NO ?? []) {
      if (entry.startsWith('path:')) forbiddenPaths.push(safeArtpPath(entry.slice(5)));
      else if (entry.startsWith('op:')) {
        const operation = entry.slice(3);
        if (!KNOWN_DENIALS.has(operation)) throw new AiRouterError(`Unknown forbidden operation '${operation}'.`, 'ARTP_POLICY_CONFLICT');
        forbiddenOps.push(operation);
      } else if (entry.startsWith('@')) (await expand(entry, 'CONSTRAINT')).forEach(applyRecord);
      else throw new AiRouterError('NO requires path:, op:, or a CONSTRAINT alias.', 'ARTP_POLICY_CONFLICT');
    }
    for (const entry of fields.REF ?? []) {
      if (entry.startsWith('@')) (await expand(entry, 'REFERENCE')).forEach(applyRecord);
      else if (entry.startsWith('path:')) references.push(`path:${safeArtpPath(entry.slice(5))}`);
      else throw new AiRouterError('REF accepts only path: references or REFERENCE aliases.', 'ARTP_REFERENCE_INVALID');
    }
    for (const entry of fields.TEST ?? []) {
      if (entry.startsWith('@')) (await expand(entry, 'VALIDATION_SET')).forEach(applyRecord);
      else validatorIds.push(validationRef(entry));
    }
    if (fields.CTX) advisory.push(fields.CTX);
    if (requestedPaths.length) scope = intersectPaths(scope, [...new Set(requestedPaths)]);
    if (!scope.length) throw new AiRouterError('ARTP scope has no overlap with allowed workspace.', 'ARTP_POLICY_CONFLICT');

    const trustedPolicies = [this.globalPolicy, this.projectPolicy, this.workspacePolicy, this.taskPermissions];
    const policySources = ['core', ...['global', 'project', 'workspace', 'task'].filter((name, index) => Object.keys(trustedPolicies[index]).length), 'artp'];
    let allowedOps = [...ACTION_TYPES];
    for (const [index, policy] of trustedPolicies.entries()) {
      const allowed = policyList(policy.allowed_operations, `allowed_operations:${index}`);
      if (allowed) allowedOps = allowedOps.filter((item) => allowed.includes(item));
      const paths = policyList(policy.allowed_paths, `allowed_paths:${index}`);
      if (paths) scope = intersectPaths(scope, paths.map(safeArtpPath));
      forbiddenPaths.push(...(policyList(policy.denied_paths, `denied_paths:${index}`) ?? []).map(safeArtpPath));
      forbiddenOps.push(...(policyList(policy.denied_operations, `denied_operations:${index}`) ?? []));
      validatorIds.push(...(policyList(policy.required_validations, `required_validations:${index}`) ?? []));
    }
    // No caller-supplied ARTP field can grant write permission. The API uses
    // the default task permission; a trusted host can inject a narrower policy.
    const taskAllowed = policyList(this.taskPermissions.allowed_operations, 'task allowed_operations') ?? (write_authorized ? ACTION_TYPES.filter((type) => type !== 'run_validation_command') : READ_ONLY_ACTIONS);
    allowedOps = allowedOps.filter((item) => taskAllowed.includes(item));
    const uniqueDeniedOps = [...new Set(forbiddenOps)];
    if (uniqueDeniedOps.some((item) => !KNOWN_DENIALS.has(item))) throw new AiRouterError('Policy contains unsupported operation.', 'ARTP_POLICY_CONFLICT');
    allowedOps = allowedOps.filter((item) => !uniqueDeniedOps.includes(item));
    if (!scope.length) throw new AiRouterError('ARTP scope conflicts with superior policy.', 'ARTP_POLICY_CONFLICT');
    const deniedPaths = [...new Set(forbiddenPaths)];
    if (scope.every((allowed) => deniedPaths.some((denied) => denied === '.' || allowed === denied || allowed.startsWith(`${denied}/`)))) throw new AiRouterError('All requested scope is denied by effective policy.', 'ARTP_POLICY_CONFLICT');
    for (const target of [...scope, ...deniedPaths, ...references.filter((item) => item.startsWith('path:')).map((item) => item.slice(5))]) await resolveSafePath(project.workspacePath, target, { mustExist: false });

    const refs = [...new Set(references)];
    for (const ref of refs.filter((item) => item.startsWith('path:'))) {
      const target = ref.slice(5);
      if (!scope.some((allowed) => allowed === '.' || target === allowed || target.startsWith(`${allowed}/`)) || deniedPaths.some((denied) => denied === '.' || target === denied || target.startsWith(`${denied}/`))) throw new AiRouterError(`Reference '${target}' is outside task scope.`, 'ARTP_REFERENCE_OUTSIDE_SCOPE');
    }
    const ids = [...new Set(validatorIds)]; const validations = []; const validationBindings = [];
    for (const id of ids) {
      if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(id)) throw new AiRouterError('Invalid validation reference.', 'ARTP_VALIDATION_INVALID');
      const definition = this.validationRegistry instanceof Map ? this.validationRegistry.get(id) : this.validationRegistry[id];
      if (!definition) throw new AiRouterError(`Unknown validation '${id}'.`, 'ARTP_VALIDATION_UNKNOWN');
      // Historical MVP A registries may expose preview-only validators. Durable
      // execution rejects these later through descriptor validation.
      if (definition.target) {
        const target = safeArtpPath(definition.target);
        if (!scope.some((allowed) => allowed === '.' || target === allowed || target.startsWith(`${allowed}/`)) || deniedPaths.some((denied) => denied === '.' || target === denied || target.startsWith(`${denied}/`))) throw new AiRouterError(`Validation '${id}' is outside task scope.`, 'ARTP_VALIDATION_OUTSIDE_SCOPE');
      }
      if (definition.type === 'command' && (!definition.command_id || !definition.command || !Array.isArray(definition.args ?? []))) throw new AiRouterError(`Registered command '${id}' is incomplete.`, 'ARTP_VALIDATION_INVALID');
      validations.push({ validation_id: id, type: definition.type, ...(definition.target ? { target: definition.target } : {}), ...(definition.expected !== undefined ? { expected: definition.expected } : {}), ...(definition.command_id ? { command_id: definition.command_id } : {}) });
      validationBindings.push({ validation_id: id, hash: sha256(definition) });
    }

    const slots = fields.IMG ?? [];
    if (new Set(slots).size !== slots.length || (!slots.length && attachment_ids.length)) throw new AiRouterError('Duplicate or unused attachment slot.', 'ARTP_ATTACHMENT_INVALID');
    let draftAttachments = [];
    if (attachment_ids.length) draftAttachments = await this.attachmentStore.inspectDraft(attachment_ids, draft_id);
    const attachments = slots.map((slot) => {
      const match = /^slot:([1-9][0-9]*)$/.exec(slot);
      if (!match || Number(match[1]) > draftAttachments.length) throw new AiRouterError('IMG slot is missing from this draft.', 'ARTP_ATTACHMENT_NOT_FOUND');
      return draftAttachments[Number(match[1]) - 1];
    });
    if (new Set(attachments.map((item) => item.attachment_id)).size !== attachments.length) throw new AiRouterError('Duplicate attachment.', 'ARTP_ATTACHMENT_INVALID');

    const rawPolicy = { allowed_operations: allowedOps, forbidden_operations: uniqueDeniedOps, allowed_paths: scope, denied_paths: deniedPaths, required_validations: ids, sources: policySources };
    const analysis = analyzeTask({ objective: fields.DO, action_policy: { allowed: allowedOps, denied: uniqueDeniedOps.filter((item) => ACTION_TYPES.includes(item)) }, attachments });
    if (analysis.write_mode === 'read_only') allowedOps = allowedOps.filter((item) => !WRITES.has(item));
    const effectivePolicy = { ...rawPolicy, allowed_operations: allowedOps, write_mode: analysis.write_mode, metered_allowed: false, enforceability: 'HARD' };
    const policyHash = sha256(effectivePolicy);
    const aliasBindings = [...used.values()].map((record) => ({ alias_id: record.alias_id, scope: record.scope, owner_id: record.owner_id, revision: record.revision, hash: record.hash, type: record.type })).sort((a, b) => `${a.scope}:${a.owner_id}:${a.alias_id}:${a.revision}`.localeCompare(`${b.scope}:${b.owner_id}:${b.alias_id}:${b.revision}`));
    const expandedAliases = aliasBindings.map((binding) => ({ ...binding, source: [...used.values()].find((record) => record.alias_id === binding.alias_id && record.scope === binding.scope && record.owner_id === binding.owner_id && record.revision === binding.revision)?.source ?? 'unknown' }));
    const semanticData = {
      protocol_version: ARTP_VERSION, project_id: project.projectId, objective: fields.DO,
      scope: { allowed_paths: scope, denied_paths: deniedPaths }, preserve: [...new Set(preserve)], forbidden_operations: uniqueDeniedOps,
      additional_context: fields.CTX ?? null, advisory: [...new Set(advisory)], references: refs, attachments,
      validation_references: ids, validation_bindings: validationBindings, completion_criteria: fields.DONE ?? [], alias_bindings: aliasBindings,
      project_registration_hash: sha256({ projectId: project.projectId, workspacePath: project.workspacePath, fingerprint: project.fingerprint ?? null, displayName: project.displayName, createdAt: project.createdAt, status: project.status })
    };
    const semanticHash = sha256(semanticData);
    const semantic = { ...semanticData, artp_provenance: { descriptor_hash: parsed.descriptor_hash } };
    const manifestBody = { manifest_version: CONTEXT_MANIFEST_VERSION, project_id: project.projectId, protocol_version: ARTP_VERSION, descriptor_semantic_hash: semanticHash, alias_bindings: aliasBindings, policy_hash: policyHash, references: refs, attachments: attachments.map(({ filename: _filename, ...metadata }) => metadata), validation_references: ids, scope: semantic.scope, required_capabilities: analysis.required_capabilities, vision_required: analysis.vision_required, mandatory_context: ['effective_policy', ...aliasBindings.map((item) => `${item.scope}:${item.alias_id}@${item.revision}`)] };
    const manifest = { ...manifestBody, hash: sha256(manifestBody) };
    const expanded = {
      project: { project_id: project.projectId, display_name: project.displayName }, objective: fields.DO, scope: semantic.scope,
      aliases: expandedAliases, requested_operation: analysis.requested_operation, effective_write_mode: analysis.write_mode,
      allowed_operations: allowedOps, forbidden_operations: uniqueDeniedOps,
      hard_constraints: [{ kind: 'effective_policy', policy_hash: policyHash, paths: deniedPaths, operations: uniqueDeniedOps, enforceability: 'HARD' }],
      advisory_constraints: [...new Set([...advisory, ...preserve])].map((instruction) => ({ instruction, enforceability: 'ADVISORY' })),
      references: refs, attachments, vision_required: analysis.vision_required, validation_requirements: validations,
      completion_criteria: (fields.DONE ?? []).map((criterion) => ({ criterion, enforceability: 'ADVISORY' })), policy_sources: effectivePolicy.sources, required_capabilities: analysis.required_capabilities,
      conflicts: [], warnings: []
    };
    return {
      preview_version: '0.2', execution_enabled: false, descriptor_version: '0.2',
      compact_view: { protocol_version: ARTP_VERSION, descriptor: parsed.original, parse_valid: true },
      canonical_task: semantic, semantic_hash: semanticHash, task_analysis: analysis, effective_policy: effectivePolicy,
      context_manifest: manifest, expanded_view: expanded,
      future_execution_envelope_contract: FUTURE_EXECUTION_ENVELOPE,
      audit_metadata: { protocol_version: ARTP_VERSION, descriptor_hash: parsed.descriptor_hash, compiler_result: 'PREVIEW_VALID', alias_bindings: aliasBindings, policy_hash: policyHash, manifest_hash: manifest.hash },
      metrics: { artp_bytes: Buffer.byteLength(descriptor, 'utf8'), artp_chars: descriptor.length, artp_tokens_estimate: Math.ceil(descriptor.length / 4), estimate_only: true, expanded_chars_estimate: JSON.stringify(expanded).length }
    };
  }
}
