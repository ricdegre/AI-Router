import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { inspectProject } from '../core/project-inspector.js';

async function workspace(t) {
  const root = await temporaryDirectory(t, 'inspector-');
  await mkdir(path.join(root, 'src', 'pages'), { recursive: true });
  const filler = Array.from({ length: 400 }, (_, index) => `const line${index} = ${index};`).join('\n');
  await writeFile(path.join(root, 'src', 'pages', 'CreatedWebsites.tsx'), `${filler}\nexport const label = 'landing pages generadas';\n${filler}\n`);
  await writeFile(path.join(root, 'src', 'pages', 'Small.tsx'), "export const title = 'Hola';\n");
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
}

test('a file named in the task is included first, with the quoted text even when the file is larger than the budget', async (t) => {
  const root = await workspace(t);
  const result = await inspectProject(root, { objective: "En src/pages/CreatedWebsites.tsx reemplaza 'landing pages generadas' por 'sitios web generados'." }, { budgetChars: 4_000 });
  const metadata = result.included_file_metadata[0];
  assert.equal(metadata.path, 'src/pages/CreatedWebsites.tsx'); assert.equal(metadata.mandatory, true); assert.equal(metadata.reason, 'named in task');
  assert.ok(metadata.chars > 1_600); assert.ok(result.rendered.includes("'landing pages generadas'"));
});

test('a unique file name is enough, and small named files are sent whole', async (t) => {
  const root = await workspace(t);
  const result = await inspectProject(root, { objective: 'Cambia el título en Small.tsx' }, { budgetChars: 4_000 });
  const metadata = result.included_file_metadata.find((item) => item.path === 'src/pages/Small.tsx');
  assert.equal(metadata.mode, 'full'); assert.equal(metadata.mandatory, true);
});

test('several large named files all fit whole within the project inspection budget', async (t) => {
  const root = await workspace(t);
  const body = (name) => Array.from({ length: 300 }, (_, index) => `export const ${name}${index} = ${index};`).join('\n');
  for (const name of ['One', 'Two', 'Three']) await writeFile(path.join(root, 'src', 'pages', `${name}.tsx`), body(name));
  const result = await inspectProject(root, { objective: 'Update src/pages/One.tsx, src/pages/Two.tsx and src/pages/Three.tsx' }, { budgetChars: 32_000 });
  for (const name of ['One', 'Two', 'Three']) assert.equal(result.included_file_metadata.find((item) => item.path === `src/pages/${name}.tsx`)?.mode, 'full');
});
