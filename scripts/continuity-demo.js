import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, validateConfig } from '../config/index.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { createCheckpointMetadata, inspectGit } from '../checkpoints/git-checkpoint.js';

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git command failed');
}

const config = await validateConfig(await loadConfig());
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const demoProjectRoot = path.join(config.dataRoot, 'demos', runId);
const workspace = path.join(demoProjectRoot, 'continuity-demo');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Synthetic continuity demo\n', 'utf8');
git(workspace, ['init', '-b', 'main']);
git(workspace, ['config', 'user.name', 'AI Router Demo']);
git(workspace, ['config', 'user.email', 'demo@invalid.local']);
git(workspace, ['add', 'README.md']);
git(workspace, ['commit', '-m', 'Create synthetic demo project']);

const registry = new ProjectRegistry(config.dataRoot);
const scan = await registry.scan(demoProjectRoot);
const registration = scan.registered.find((entry) => entry.project.workspacePath === workspace);
if (!registration) throw new Error('Demo project was not registered.');
const project = registration.project;

const memory = new MemoryManager(config.dataRoot);
await memory.initialize(project);
await memory.updateCurrentTask(project.projectId, {
  task: 'Add a small status file to prove cross-agent continuity.',
  status: 'in-progress',
  acceptanceCriteria: ['Agent B understands the remaining step without Agent A chat history.'],
  completedWork: ['Created and registered the synthetic project.', 'Initialized shared project memory.'],
  remainingWork: ['Agent B should create STATUS.md in a future execution.'],
  doNotModify: ['The initial README commit.']
});
await memory.appendChangelog(project.projectId, {
  agent: 'Agent A', provider: 'synthetic-provider-a', summary: 'Initialized the task and prepared a structured handoff.'
});
const gitState = inspectGit(workspace);
const checkpoint = createCheckpointMetadata(gitState, { label: 'Demo baseline', validation: ['Initial Git commit exists.'] });
await memory.addCheckpoint(project.projectId, checkpoint);
await memory.createHandoff(project.projectId, {
  task: 'Add a small status file to prove cross-agent continuity.',
  agent: 'Agent A',
  provider: 'synthetic-provider-a',
  accountProfile: 'demo-profile-a',
  startedAt: checkpoint.recordedAt,
  completedAt: new Date().toISOString(),
  status: 'ready-for-handoff',
  completedWork: ['Registered project.', 'Initialized memory.', 'Recorded baseline checkpoint metadata.'],
  remainingWork: ['Create STATUS.md containing a completion sentence.', 'Validate Git status and update the handoff.'],
  filesTouched: ['README.md (initial synthetic commit only)'],
  validation: ['Project is a valid Git repository.', 'Memory files can be read.'],
  failures: [],
  doNotModify: ['Do not rewrite the initial README commit.'],
  lastCheckpoint: checkpoint.commit,
  recommendedNextAction: 'Agent B should create STATUS.md, validate it, and record completion.'
});

// Agent B receives only project memory, not Agent A's conversation.
const agentBView = await memory.summary(project.projectId);
process.stdout.write(`${JSON.stringify({
  demo: 'passed',
  projectId: project.projectId,
  workspace,
  detected: scan.candidates >= 1,
  registered: true,
  memoryInitialized: true,
  agentBUnderstandsRemaining: agentBView.handoff.remaining_work,
  recommendedNextAction: agentBView.handoff.recommended_next_action,
  checkpoint: checkpoint.commit,
  projectStatus: project.status
}, null, 2)}\n`);
