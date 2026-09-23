import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ActionMediator } from '../actions/action-mediator.js';
import { contentHash } from '../actions/changeset.js';
import { temporaryDirectory } from './helpers.js';

async function fixture(t) {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  const backups = path.join(base, 'runtime', 'backups');
  await mkdir(workspace);
  return { workspace, backups, mediator: new ActionMediator({ workspaceRoot: workspace, backupRoot: backups, maxFileBytes: 1024 }) };
}

test('mediator creates, reads, lists, and dry-runs only inside workspace', async (t) => {
  const { workspace, mediator } = await fixture(t);
  const dry = await mediator.execute({ action_id: 'create-dry', type: 'create_file', target: 'dry.txt', parameters: { content: 'dry' } }, { dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(await readdir(workspace).then((items) => items.includes('dry.txt')), false);
  const created = await mediator.execute({ action_id: 'create-real', type: 'create_file', target: 'safe.txt', parameters: { content: 'hello' } });
  assert.equal(created.status, 'completed');
  const read = await mediator.execute({ action_id: 'read-real', type: 'read_file', target: 'safe.txt', parameters: {} });
  assert.equal(read.result.content, 'hello');
  const list = await mediator.execute({ action_id: 'list-real', type: 'list_directory', target: '.', parameters: {} });
  assert.ok(list.result.entries.some((entry) => entry.name === 'safe.txt'));
});

test('absolute and relative targets enforce the same denied subpath', async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace, 'private'));
  await writeFile(path.join(workspace, 'private', 'secret.txt'), 'private');
  const mediator = new ActionMediator({ workspaceRoot: workspace, filesystemScope: { allowed_paths: ['.'], denied_paths: ['private'] } });
  for (const target of ['private/secret.txt', path.join(workspace, 'private', 'secret.txt')]) {
    const result = await mediator.execute({ action_id: 'scope-check', type: 'read_file', target, parameters: {} });
    assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'ACTION_SCOPE_REJECTED');
  }
});

test('exact changeset succeeds and preserves a private backup', async (t) => {
  const { workspace, backups, mediator } = await fixture(t);
  const source = 'alpha\nbeta\n';
  await writeFile(path.join(workspace, 'file.txt'), source);
  const result = await mediator.execute({
    action_id: 'patch-one', type: 'modify_file', target: 'file.txt',
    parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash(source), search: 'beta', replacement: 'gamma' } }
  });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(workspace, 'file.txt'), 'utf8'), 'alpha\ngamma\n');
  assert.equal((await readdir(backups)).filter((name) => name.endsWith('.bak')).length, 1);
});

test('changeset rejects stale, ambiguous, invalid, and escaping actions', async (t) => {
  const { workspace, mediator } = await fixture(t);
  await writeFile(path.join(workspace, 'ambiguous.txt'), 'same same');
  const stale = await mediator.execute({ action_id: 'stale-one', type: 'modify_file', target: 'ambiguous.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: '0'.repeat(64), search: 'same', replacement: 'x' } } });
  assert.equal(stale.error.code, 'STALE_CHANGESET');
  const ambiguous = await mediator.execute({ action_id: 'ambiguous-one', type: 'modify_file', target: 'ambiguous.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('same same'), search: 'same', replacement: 'x' } } });
  assert.equal(ambiguous.error.code, 'AMBIGUOUS_CHANGESET');
  const invalid = await mediator.execute({ action_id: 'invalid-one', type: 'modify_file', target: 'ambiguous.txt', parameters: { patch: { kind: 'unified_diff' } } });
  assert.equal(invalid.error.code, 'INVALID_CHANGESET');
  const escape = await mediator.execute({ action_id: 'escape-one', type: 'create_file', target: '../escape.txt', parameters: { content: 'no' } });
  assert.equal(escape.error.code, 'PATH_OUTSIDE_ROOT');
});

test('mediator rejects binary and oversized files', async (t) => {
  const { workspace, mediator } = await fixture(t);
  await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(2048));
  assert.equal((await mediator.execute({ action_id: 'binary-read', type: 'read_file', target: 'binary.bin', parameters: {} })).error.code, 'BINARY_FILE_REJECTED');
  assert.equal((await mediator.execute({ action_id: 'large-read', type: 'read_file', target: 'large.txt', parameters: {} })).error.code, 'FILE_TOO_LARGE');
});

test('mediator enforces descriptor filesystem sub-scopes', async (t) => {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  await mkdir(path.join(workspace, 'allowed'), { recursive: true });
  await mkdir(path.join(workspace, 'denied'), { recursive: true });
  await writeFile(path.join(workspace, 'allowed', 'ok.txt'), 'ok');
  await writeFile(path.join(workspace, 'denied', 'no.txt'), 'no');
  const mediator = new ActionMediator({ workspaceRoot: workspace, filesystemScope: { allowed_paths: ['allowed'], denied_paths: ['allowed/private'] }, actionPolicy: { allowed: ['read_file'], denied: [] } });
  assert.equal((await mediator.execute({ action_id: 'read-ok', type: 'read_file', target: 'allowed/ok.txt' })).status, 'completed');
  assert.equal((await mediator.execute({ action_id: 'read-no', type: 'read_file', target: 'denied/no.txt' })).error.code, 'ACTION_SCOPE_REJECTED');
  assert.equal((await mediator.execute({ action_id: 'create-no', type: 'create_file', target: 'allowed/new.txt', parameters: { content: 'x' } })).error.code, 'ACTION_POLICY_REJECTED');
});
