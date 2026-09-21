import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResumeSafety } from '../core/resume-safety.js';

const safe = { drift: { classification: 'SAFE', reasons: [] }, lock: { locked: false }, journal: { valid: true, pending: [] }, resumePolicy: { failed: 'escalate' } };

test('resume safety matrix covers every task state', () => {
  for (const state of ['CREATED', 'READY', 'ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'FAILED', 'ESCALATING']) assert.equal(evaluateResumeSafety({ ...safe, state }).recommendation, 'RESUMABLE', state);
  assert.equal(evaluateResumeSafety({ ...safe, state: 'BLOCKED' }).recommendation, 'REVIEW_REQUIRED');
  assert.equal(evaluateResumeSafety({ ...safe, state: 'CANCELLED' }).recommendation, 'BLOCKED');
  assert.equal(evaluateResumeSafety({ ...safe, state: 'COMPLETED' }).recommendation, 'COMPLETED');
});

test('resume safety blocks locks, corrupt journal, drift, and uncertain effects', () => {
  assert.equal(evaluateResumeSafety({ ...safe, state: 'READY', lock: { locked: true } }).recommendation, 'BLOCKED');
  assert.equal(evaluateResumeSafety({ ...safe, state: 'READY', journal: { valid: false, pending: [] } }).recommendation, 'BLOCKED');
  assert.equal(evaluateResumeSafety({ ...safe, state: 'READY', drift: { classification: 'REVIEW_REQUIRED', reasons: ['working-tree-changed'] } }).recommendation, 'REVIEW_REQUIRED');
  assert.equal(evaluateResumeSafety({ ...safe, state: 'RUNNING', journal: { valid: true, pending: [{ recovery: 'BLOCKING' }] } }).recommendation, 'BLOCKED');
});
