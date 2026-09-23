import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.agents', '.codex', '.codex-remote-attachments', '.openai', '.wrangler', '.next', '.nuxt',
  '.cache', '.venv', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'out', 'target', 'bin', 'obj',
  '__pycache__', 'backups', '.backups', 'outputs', 'tmp', 'temp', 'logs'
]);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.bin', '.exe', '.dll', '.wasm']);
const TEXT_EXTENSIONS = new Set(['', '.md', '.txt', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.yml', '.yaml', '.toml', '.sql', '.graphql', '.gql', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.sh', '.ps1']);
const ROOT_KEY_FILES = /^(?:readme(?:\.[^/]+)?|package\.json|wrangler\.jsonc|tsconfig\.json|vite\.config\.[^/]+|next\.config\.[^/]+|dockerfile|compose\.ya?ml)$/i;
const KEY_FILES = /(?:^|\/)(?:schema\.[^/]+|index\.[^/]+|layout\.[^/]+|route\.[^/]+|00-indice\.md)$/i;
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|auth\.json)$/i;
const LOCK_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;

function normalized(relativePath) { return relativePath.split(path.sep).join('/'); }
function termsFor(task) { return String(`${task.objective ?? ''} ${task.prompt ?? ''}`).toLowerCase().split(/[^a-z0-9áéíóúñ_]+/u).filter((item) => item.length >= 4); }

function scoreFile(file, terms) {
  let score = ROOT_KEY_FILES.test(file) ? 300 : KEY_FILES.test(file) ? 100 : 0;
  if (/^docs\/(?:00-indice|.*(?:architecture|arquitectura|handoff|overview|security)).*\.md$/i.test(file)) score += 180;
  if (/^(?:src|app|worker|server|core|db|docs)\//i.test(file)) score += 25;
  if (/(?:^|\/)(?:index|main|app|server|router|schema|architecture|overview|handoff)[.-]/i.test(file)) score += 30;
  for (const term of terms) if (file.toLowerCase().includes(term)) score += 8;
  if (/\/tests?\//i.test(`/${file}`) || /^tests?\//i.test(file)) score -= 40;
  if (/^examples\//i.test(file)) score -= 50;
  return score;
}

async function inventory(root, options = {}) {
  const files = []; const excludedDirectories = new Set(); let excludedFiles = 0;
  async function visit(directory, depth) {
    if (depth > (options.maxDepth ?? 12) || files.length >= (options.maxFiles ?? 5_000)) return;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name); const relative = normalized(path.relative(root, absolute));
      if (entry.isSymbolicLink()) { excludedFiles += 1; continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) { excludedDirectories.add(relative); continue; }
        await visit(absolute, depth + 1); continue;
      }
      if (!entry.isFile() || SECRET_FILES.test(relative) || LOCK_FILES.test(relative) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { excludedFiles += 1; continue; }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { excludedFiles += 1; continue; }
      files.push(relative);
      if (files.length >= (options.maxFiles ?? 5_000)) break;
    }
  }
  await visit(root, 0);
  return { files, excludedDirectories: [...excludedDirectories], excludedFiles };
}

export async function inspectProject(workspacePath, task = {}, options = {}) {
  const root = path.resolve(workspacePath); const budgetChars = options.budgetChars ?? 10_000;
  const { files, excludedDirectories, excludedFiles } = await inventory(root, options);
  const terms = termsFor(task);
  const ranked = files.map((file) => ({ file, score: scoreFile(file, terms) })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const selected = ranked.slice(0, options.maxInspectedFiles ?? 24);
  const treeLimit = Math.min(3_500, Math.floor(budgetChars * 0.3));
  const tree = files.slice(0, 300).join('\n').slice(0, treeLimit);
  const sections = [`PROJECT FILE INVENTORY (${files.length} text files; generated/vendor/binary/secret paths excluded)\n${tree}`];
  let used = sections[0].length; const includedFiles = [];
  for (const { file } of selected) {
    const available = budgetChars - used - file.length - 12; if (available < 160) break;
    try {
      const content = await readFile(path.join(root, file), 'utf8');
      if (content.includes('\0')) { continue; }
      const excerpt = content.slice(0, Math.min(1_600, available));
      sections.push(`FILE: ${file}\n${excerpt}`); includedFiles.push(file); used += file.length + excerpt.length + 8;
    } catch {}
  }
  const rendered = sections.join('\n\n');
  return {
    inspection_version: '0.1', files_discovered: files.length, files_inspected: selected.length,
    files_included: includedFiles.length, included_files: includedFiles,
    excluded_directories: excludedDirectories, excluded_files: excludedFiles,
    context_chars: rendered.length, approximate_tokens: Math.ceil(rendered.length / 4), rendered
  };
}
