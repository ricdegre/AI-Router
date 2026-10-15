export const TRIAGE_QUESTION_SET_VERSION = '0.1';

export const TRIAGE_ROUTING_QUESTIONS = Object.freeze([
  { id: 'task_complexity', type: 'choice', choices: ['trivial', 'normal', 'difficult', 'expert'] },
  { id: 'required_strength', type: 'choice', choices: ['local', 'standard', 'strong'] },
  { id: 'high_blast_radius', type: 'probability' },
  { id: 'needs_deep_reasoning', type: 'probability' },
  { id: 'underspecified', type: 'probability' },
  { id: 'local_suitability', type: 'score' },
  { id: 'coding_specialization', type: 'score' },
  { id: 'web_required', type: 'probability' },
  { id: 'filesystem_required', type: 'probability' }
]);
