import path from 'node:path';
import { createRuntimeServices } from '../../core/runtime-services.js';
import { contentHash } from '../../actions/changeset.js';
import { AiRouterError } from '../../core/errors.js';
import { MockProvider } from '../mock-provider.js';

const [dataRoot, projectId, profileId] = process.argv.slice(2);
const action = { action_id: 'multiprocess-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'DONE' } } };
const provider = new MockProvider('worker-provider', { execute: async () => ({ structured: { schema_version: '0.1', status: 'ok', summary: 'worker response', observations: [], proposed_actions: [action], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] } }) });
const services = createRuntimeServices({ dataRoot, projectRoots: [] }, { registerOllama: false, providers: [provider] });
await services.orchestrator.run({
  project_id: projectId, task_id: 'multiprocess-01', objective: 'Complete a task across two processes',
  manual_provider: 'worker-provider', manual_profile: profileId, required_capabilities: ['coding'],
  action_policy: { allowed: ['modify_file'] }, max_attempts: 2,
  validation_requirements: [{ validation_id: 'done-01', type: 'exact_content', target: 'status.txt', expected: 'STATUS=DONE\n' }]
}, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'after-action-before-receipt') throw new AiRouterError('worker crash', 'SIMULATED_CRASH'); } });
