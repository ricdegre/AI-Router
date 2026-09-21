import { ProjectCoordinator } from '../../core/project-coordinator.js';
const [dataRoot, projectId] = process.argv.slice(2);
const lock = await new ProjectCoordinator(dataRoot, { timeoutMs: 100 }).acquire(projectId);
process.stdout.write('READY\n');
setTimeout(async () => { await lock.release(); process.exit(0); }, 2_000);
