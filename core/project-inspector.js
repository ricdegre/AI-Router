import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SECRET_FILE_PATTERN } from './safe-path.js';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.agents', '.codex', '.codex-remote-attachments', '.openai', '.wrangler', '.next', '.nuxt',
  '.cache', '.venv', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'out', 'target', 'bin', 'obj',
  '__pycache__', 'backups', '.backups', 'outputs', 'tmp', 'temp', 'logs'
]);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.bin', '.exe', '.dll', '.wasm']);
const TEXT_EXTENSIONS = new Set(['', '.md', '.txt', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.yml', '.yaml', '.toml', '.sql', '.graphql', '.gql', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.sh', '.ps1']);
const ROOT_KEY_FILES = /^(?:readme(?:\.[^/]+)?|package\.json|wrangler\.jsonc|tsconfig\.json|vite\.config\.[^/]+|next\.config\.[^/]+|dockerfile|compose\.ya?ml)$/i;
const KEY_FILES = /(?:^|\/)(?:schema\.[^/]+|index\.[^/]+|layout\.[^/]+|route\.[^/]+|00-indice\.md)$/i;
const LOCK_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
export function contextPathAllowed(relativePath, scope = {}) {
  const value = normalized(path.normalize(relativePath));
  const parts = value.split('/');
  if (path.isAbsolute(relativePath) || value === '..' || value.startsWith('../') || parts.includes('..') || parts.some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase())) || SECRET_FILE_PATTERN.test(value) || LOCK_FILES.test(value)) return false;
  const within = (prefix) => prefix === '.' || value === prefix || value.startsWith(`${prefix}/`);
  const allowed = scope.allowed_paths?.length ? scope.allowed_paths : ['.'];
  return allowed.some((entry) => within(normalized(path.normalize(entry)))) && !(scope.denied_paths ?? []).some((entry) => within(normalized(path.normalize(entry))));
}

function normalized(relativePath) { return relativePath.split(path.sep).join('/'); }
function termsFor(task) { return String(`${task.objective ?? ''} ${task.prompt ?? ''}`).toLowerCase().split(/[^a-z0-9áéíóúñ_]+/u).filter((item) => item.length >= 4); }

function scoreFile(file, terms, focusTerms = new Set()) {
  let score = ROOT_KEY_FILES.test(file) ? 300 : KEY_FILES.test(file) ? 100 : 0;
  if (/^docs\/(?:00-indice|.*(?:architecture|arquitectura|handoff|overview|security)).*\.md$/i.test(file)) score += 180;
  if (/^(?:src|app|worker|server|core|db|docs)\//i.test(file)) score += 25;
  if (/(?:^|\/)(?:index|main|app|server|router|schema|architecture|overview|handoff)[.-]/i.test(file)) score += 30;
  const pathTerms = new Set(file.toLowerCase().split(/[^a-z0-9áéíóúñ_]+/u).filter((term) => term.length >= 4));
  for (const term of terms) if (file.toLowerCase().includes(term)) score += 8;
  for (const term of focusTerms) if (pathTerms.has(term)) score += 320;
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
      if (!entry.isFile() || SECRET_FILE_PATTERN.test(relative) || LOCK_FILES.test(relative) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { excludedFiles += 1; continue; }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { excludedFiles += 1; continue; }
      files.push(relative);
      if (files.length >= (options.maxFiles ?? 5_000)) break;
    }
  }
  await visit(root, 0);
  return { files, excludedDirectories: [...excludedDirectories], excludedFiles };
}

function taskText(task) { return `${task.objective ?? ''}\n${task.prompt ?? ''}\n${task.instruction ?? ''}`; }

// Files the task names explicitly (full relative path, or a unique file name) are context the model cannot work without.
function namedFiles(files, task) {
  const text = taskText(task).replaceAll('\\', '/');
  const tokens = new Set(text.split(/[\s'"`()[\]{},;:]+/u).map((token) => token.replace(/[.!?]+$/u, '')).filter(Boolean));
  const named = new Set(files.filter((file) => tokens.has(file)));
  const byName = new Map();
  for (const file of files) { const name = path.posix.basename(file); byName.set(name, [...(byName.get(name) ?? []), file]); }
  for (const [name, matches] of byName) if (matches.length === 1 && name.includes('.') && tokens.has(name)) named.add(matches[0]);
  return named;
}

// Prefer the whole file; when it does not fit, center the window on text quoted in the task.
function namedExcerpt(content, task, available) {
  if (content.length <= available) return { excerpt: content, start: 0 };
  const quoted = [...taskText(task).matchAll(/['"`‘’“”]([^'"`‘’“”\n]{4,200})['"`‘’“”]/gu)].map((match) => match[1]);
  const hit = quoted.map((needle) => content.indexOf(needle)).find((index) => index >= 0);
  const start = hit == null ? 0 : Math.max(0, Math.min(content.length - available, hit - Math.floor(available / 2)));
  return { excerpt: content.slice(start, start + available), start };
}

export async function inspectProject(workspacePath, task = {}, options = {}) {
  const root = path.resolve(workspacePath); const budgetChars = options.budgetChars ?? 10_000;
  const found = await inventory(root, options);
  const { excludedDirectories, excludedFiles } = found;
  const files = found.files.filter((file) => contextPathAllowed(file, options.scope));
  const terms = termsFor(task);
  const focusTerms = new Set(String(task.objective ?? '').toLowerCase().split(/[^a-z0-9áéíóúñ_]+/u).filter((term) => term.length >= 4));
  const ranked = files.filter((file) => !(options.excludeFiles ?? []).includes(file)).map((file) => ({ file, score: scoreFile(file, terms, focusTerms) })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const named = namedFiles(files, task);
  const selected = [...ranked.filter(({ file }) => named.has(file)), ...ranked.filter(({ file }) => !named.has(file)).slice(0, options.maxInspectedFiles ?? 24)];
  const treeLimit = Math.min(named.size ? 1_500 : 3_500, Math.floor(budgetChars * 0.3));
  const tree = files.slice(0, 300).join('\n').slice(0, treeLimit);
  const sections = [`PROJECT FILE INVENTORY (${files.length} text files; generated/vendor/binary/secret paths excluded)\n${tree}`];
  let used = sections[0].length; const includedFiles = []; const includedFileMetadata = [];
  for (const { file } of selected) {
    const available = budgetChars - used - file.length - 12; if (available < 160) break;
    try {
      const content = await readFile(path.join(root, file), 'utf8');
      if (content.includes('\0')) { continue; }
      const isNamed = named.has(file);
      const { excerpt, start } = isNamed ? namedExcerpt(content, task, available) : { excerpt: content.slice(0, Math.min(1_600, available)), start: 0 };
      sections.push(`FILE: ${file}${start ? ` (from character ${start})` : ''}\n${excerpt}`); includedFiles.push(file); includedFileMetadata.push({ path: file, sha256: createHash('sha256').update(content).digest('hex'), mode: excerpt.length === content.length ? 'full' : 'extract', range: { start_char: start, end_char: start + excerpt.length }, chars: excerpt.length, mandatory: isNamed, reason: isNamed ? 'named in task' : 'project inspection relevance' }); used += file.length + excerpt.length + 8;
    } catch {}
  }
  const rendered = sections.join('\n\n');
  return {
    inspection_version: '0.1', files_discovered: files.length, files_inspected: selected.length,
    files_included: includedFiles.length, included_files: includedFiles, included_file_metadata: includedFileMetadata,
    excluded_directories: excludedDirectories, excluded_files: excludedFiles,
    context_chars: rendered.length, approximate_tokens: Math.ceil(rendered.length / 4), rendered
  };
}
