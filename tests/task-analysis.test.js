import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTask } from '../routing/task-analysis.js';

test('task analysis classifies project analysis before resource routing', () => {
  const analysis = analyzeTask({ objective: 'Analyze this entire project without modifying files', task_type: 'analysis', risk: 'low' });
  assert.equal(analysis.intent, 'project_analysis');
  assert.equal(analysis.scope, 'project');
  assert.equal(analysis.write_mode, 'read_only');
  assert.equal(analysis.complexity, 'high');
  assert.equal(analysis.required_strength, 'strong');
  for (const capability of ['filesystem_read', 'repository_navigation', 'code_understanding', 'long_context']) assert.ok(analysis.required_capabilities.includes(capability));
  assert.equal(analysis.parallelizable, true);
});

test('a minimal read-only Git-status request does not inherit denied project-wide analysis', () => {
  const objective = 'SMOKE TEST — READ ONLY\n\nTrabaja únicamente con el workspace actualmente registrado.\n\nNO analices el proyecto completo.\nNO modifiques ningún archivo.\n\nConfirma solamente:\n- ruta del workspace;\n- branch Git actual;\n- si Git está clean o dirty.\n\nNo hagas commits.\nNo hagas push.\nNo escribas archivos.\n\nTermina en COMPLETED después de devolver esos tres datos.';
  const analysis = analyzeTask({ objective, task_type: 'coding' });
  assert.notEqual(analysis.intent, 'project_analysis');
  assert.notEqual(analysis.scope, 'project');
  assert.equal(analysis.write_mode, 'read_only');
  assert.notEqual(analysis.context_requirement, 'high');
  assert.equal(analysis.required_capabilities.includes('long_context'), false);
  assert.deepEqual(analysis.routing_capabilities, ['coding']);
  assert.equal(analyzeTask({ objective: 'Do not analyze the entire project. Report the current Git branch.' }).required_capabilities.includes('long_context'), false);
  assert.equal(analyzeTask({ objective: 'Do not analyze the entire project. Then analyze the whole project.' }).required_capabilities.includes('long_context'), true);
  assert.equal(analyzeTask({ objective: 'No hagas commits. Analiza todo el proyecto.' }).required_capabilities.includes('long_context'), true);
});

test('a long write specification with many explicit sections requires strong execution', () => {
  const sections = Array.from({ length: 8 }, (_, index) => `${index + 1}. Requirement ${index + 1}\n${'Preserve existing routes, localization, active selection, permissions, validation, security, and current data behavior. '.repeat(5)}\n`).join('\n');
  const analysis = analyzeTask({ objective: `Implement a cross-cutting interface change.\n\n${sections}`, task_type: 'coding' });
  assert.equal(analysis.write_mode, 'write_allowed');
  assert.equal(analysis.complexity, 'high');
  assert.equal(analysis.required_strength, 'strong');
  const readOnly = analyzeTask({ objective: `Analyze the system without changing files.\n\n${sections}`, read_only: true });
  assert.notEqual(readOnly.complexity, 'high');
});

test('a long Spanish navigation edit is not misclassified by preservation mentions of selection or architecture', () => {
  const sections = Array.from({ length: 8 }, (_, index) => `${index + 1}. Requisito ${index + 1}\nPreservar rutas, selección activa, permisos, traducciones y arquitectura existente. ${'No tocar Productos y servicios ni datos no relacionados. '.repeat(10)}\n`).join('\n');
  const analysis = analyzeTask({ objective: 'SND/YDB — MOVE WHOLESALE NAVIGATION INTO SIDEBAR SUBMENU', instruction: `Modificar la navegación de Wholesale y convertir Operaciones Wholesale en un submenu.\n\n${sections}`, task_type: 'coding', attachments: [{ type: 'image' }] });
  assert.equal(analysis.intent, 'edit');
  assert.equal(analysis.scope, 'feature');
  assert.equal(analysis.write_mode, 'write_allowed');
  assert.equal(analysis.complexity, 'high');
  assert.equal(analysis.required_strength, 'strong');
  assert.deepEqual(analysis.routing_capabilities, ['coding', 'vision']);
});

test('task analysis distinguishes a small writable selection from project work', () => {
  const analysis = analyzeTask({ objective: 'Change this selected CSS color', has_selection: true, task_type: 'coding' });
  assert.equal(analysis.intent, 'edit');
  assert.equal(analysis.scope, 'selection');
  assert.equal(analysis.write_mode, 'write_allowed');
  assert.equal(analysis.complexity, 'trivial');
  assert.deepEqual(analysis.routing_capabilities, ['coding']);
});

test('an image attachment requires vision independently of task wording', () => {
  const analysis = analyzeTask({ objective: 'Describe the important visible elements', read_only: true, attachments: [{ type: 'image', attachment_id: 'att-one' }] });
  assert.equal(analysis.vision_required, true); assert.equal(analysis.attachments.image_count, 1); assert.ok(analysis.routing_capabilities.includes('vision')); assert.equal(analysis.write_mode, 'read_only');
});

test('visual tasks preserve independent read-only and write-enabled intent', () => {
  const attachment = [{ type: 'image' }]; const readOnly = analyzeTask({ objective: 'Tell me what is wrong. Do not modify anything.', attachments: attachment }); const writable = analyzeTask({ objective: 'Fix this screen to match the screenshot', attachments: attachment });
  assert.equal(readOnly.write_mode, 'read_only'); assert.equal(readOnly.required_capabilities.includes('filesystem_write'), false); assert.equal(writable.write_mode, 'write_allowed'); assert.ok(writable.required_capabilities.includes('filesystem_write')); assert.ok(writable.routing_capabilities.includes('vision'));
});

test('write scope limits do not turn an explicitly requested edit into read-only', () => {
  const analysis = analyzeTask({ objective: 'Implement nested Wholesale sidebar navigation', instruction: 'Do not change unrelated routes, data, logic, or styles.' });
  assert.equal(analysis.intent, 'edit'); assert.equal(analysis.write_mode, 'write_allowed');
  assert.equal(analyzeTask({ objective: 'Explain the page without changing any files' }).write_mode, 'read_only');
});

test('requested editing and permission remain separate from scoped prohibitions', () => {
  for (const objective of [
    'Solo cambia X; no modifiques Y.',
    'Corrige X pero conserva todo lo demás.',
    'No cambies navegación no relacionada. Corrige únicamente este archivo.',
    'Puedes modificar archivos existentes pero no crear nuevos.'
  ]) {
    const analysis = analyzeTask({ objective, action_policy: { allowed: ['modify_file'], denied: ['create_file', 'append_file'] } });
    assert.equal(analysis.write_mode, 'write_allowed', objective);
    assert.equal(analysis.write_permission, 'allowed');
    assert.deepEqual(analysis.prohibited_operations, ['create_file', 'append_file']);
  }
});

test('diagnosis and whole-task no-write instructions stay read-only', () => {
  for (const objective of ['Diagnostica el problema sin tocar archivos.', 'Analiza solamente.', 'Revisa y dime qué está mal.']) {
    const analysis = analyzeTask({ objective });
    assert.equal(analysis.write_mode, 'read_only', objective);
    assert.equal(analysis.write_permission, 'denied');
  }
});

test('task analysis separates light edits, architecture redesigns, and incidental tests', () => {
  assert.equal(analyzeTask({ objective: 'Corrige el typo en el título del README' }).complexity, 'low');
  assert.equal(analyzeTask({ objective: 'Change the button border color' }).complexity, 'low');
  const redesign = analyzeTask({ objective: 'Rediseña la arquitectura del sistema de autenticación' });
  assert.equal(redesign.intent, 'architecture'); assert.equal(redesign.required_strength, 'strong');
  const feature = analyzeTask({ objective: 'Agrega un endpoint REST para exportar tareas a CSV con tests' });
  assert.equal(feature.intent, 'edit'); assert.equal(feature.complexity, 'medium');
  assert.equal(analyzeTask({ objective: 'Write unit tests for the parser' }).intent, 'test');
});

test('one-line changes are light work', () => {
  assert.equal(analyzeTask({ objective: 'Make a one-line change in status.txt' }).complexity, 'low');
  assert.equal(analyzeTask({ objective: 'Cambia una sola línea del archivo de configuración' }).complexity, 'low');
});
