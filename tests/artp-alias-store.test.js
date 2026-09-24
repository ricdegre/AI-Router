import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { ArtpAliasStore } from '../artp/alias-store.js';

async function fixture(t) {
  const root = await temporaryDirectory(t, 'artp-alias-'); const workspace = path.join(root, 'project'); await mkdir(workspace);
  const registry = new ProjectRegistry(path.join(root, 'data')); const { project } = await registry.register(workspace);
  return { project, store: new ArtpAliasStore(path.join(root, 'data'), registry) };
}

test('versioned aliases pin dependencies and preserve historical meaning', async (t) => {
  const { project, store } = await fixture(t);
  const first = await store.publish({ scope: 'project', project_id: project.projectId, alias_id: 'I18N', type: 'CONSTRAINT', content: { preserve: ['ES/EN'] } });
  const dependent = await store.publish({ scope: 'project', project_id: project.projectId, alias_id: 'ADMIN', type: 'SCOPE', content: { paths: ['admin'] }, dependencies: ['I18N'] });
  assert.equal(dependent.dependencies[0].revision, 1);
  const second = await store.publish({ scope: 'project', project_id: project.projectId, alias_id: 'I18N', type: 'CONSTRAINT', content: { preserve: ['ES/EN', 'RTL'] } });
  assert.notEqual(first.hash, second.hash);
  assert.equal((await store.get({ alias_id: 'I18N', scope: 'project', owner_id: project.projectId, revision: 1, hash: first.hash }, project)).content.preserve.length, 1);
  const expanded = await store.expand('ADMIN', project); assert.equal(expanded[0].revision, 1);
  assert.equal((await store.current('I18N', project)).revision, 2);
  await assert.rejects(() => store.current('MISSING', project), { code: 'ARTP_UNKNOWN_ALIAS' });
  await assert.rejects(() => store.publish({ scope: 'project', project_id: project.projectId, alias_id: 'I18N', type: 'CONSTRAINT', content: {}, dependencies: ['ADMIN'] }), { code: 'ARTP_ALIAS_CYCLE' });
});

test('alias scope ambiguity is explicit and PROJECT aliases point only to registered projects', async (t) => {
  const { project, store } = await fixture(t);
  await store.publish({ scope: 'global', alias_id: 'APP', type: 'PROJECT', content: { project_id: project.projectId } });
  assert.equal((await store.current('APP')).content.project_id, project.projectId);
  await store.publish({ scope: 'global', alias_id: 'SHARED', type: 'CONSTRAINT', content: { advisory: ['global'] } });
  await store.publish({ scope: 'project', project_id: project.projectId, alias_id: 'SHARED', type: 'CONSTRAINT', content: { advisory: ['project'] } });
  await assert.rejects(() => store.current('SHARED', project), { code: 'ARTP_ALIAS_CONFLICT' });
});

test('alias depth is bounded, revisions detect tampering, and workspace identity is explicit', async (t) => {
  const { project, store } = await fixture(t);
  const base = await store.publish({ scope: 'workspace', project_id: project.projectId, alias_id: 'BASE', type: 'CONSTRAINT', content: { preserve: ['Keep UI stable'] } });
  const top = await store.publish({ scope: 'workspace', project_id: project.projectId, alias_id: 'TOP', type: 'SCOPE', content: { paths: ['src'] }, dependencies: ['BASE'] });
  assert.equal((await store.expand('TOP', project))[0].hash, base.hash);
  const shallow = new ArtpAliasStore(store.dataRoot, store.projectRegistry, { maxDepth: 0 });
  await assert.rejects(() => shallow.expand('TOP', project), { code: 'ARTP_ALIAS_DEPTH' });
  const file = path.join(store.directory('workspace', project), 'BASE', 'rev-1.json');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('Keep UI stable', 'Changed without revision'));
  await assert.rejects(() => store.expand('TOP', project), { code: 'ARTP_ALIAS_INTEGRITY' });
  assert.equal(top.dependencies[0].revision, 1);
});
