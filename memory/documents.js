const BLOCK_START = '<!-- AI_ROUTER_STRUCTURED_DATA';
const BLOCK_END = 'AI_ROUTER_STRUCTURED_DATA -->';

function clean(value) {
  if (value === undefined || value === null || value === '') return 'Not recorded.';
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : 'None recorded.';
  return String(value);
}

export function structuredBlock(data) {
  return `${BLOCK_START}\n${JSON.stringify(data, null, 2)}\n${BLOCK_END}`;
}

export function parseStructuredDocument(content) {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start < 0 || end < 0 || end <= start) return null;
  const json = content.slice(start + BLOCK_START.length, end).trim();
  return JSON.parse(json);
}

export function renderCurrentTask(data) {
  return `# Current Task

## Task

${clean(data.objective)}

## Status

${clean(data.status)}

## Acceptance criteria

${clean(data.acceptance_criteria)}

## Completed work

${clean(data.completed_work)}

## Remaining work

${clean(data.remaining_work)}

## Constraints

${clean(data.constraints)}

## Do not modify

${clean(data.do_not_modify)}

${structuredBlock(data)}
`;
}

export function renderHandoff(data) {
  return `# Agent Handoff

## Task

${clean(data.objective)}

## Agent and resource

- Agent: ${clean(data.agent_id)}
- Provider: ${clean(data.provider_id)}
- Account/profile: ${clean(data.profile_id)}
- Status: ${clean(data.status)}
- Started: ${clean(data.started_at)}
- Stopped/completed: ${clean(data.stopped_at)}

## Completed work

${clean(data.completed_work)}

## Remaining work

${clean(data.remaining_work)}

## Files touched

${clean(data.files_touched)}

## Validation

### Performed

${clean(data.validation_performed)}

### Results

${clean(data.validation_results)}

## Failures already attempted

${clean(data.failed_attempts)}

## Known issues

${clean(data.known_issues)}

## Constraints

${clean(data.constraints)}

## Do not modify

${clean(data.do_not_modify)}

## Last checkpoint

${clean(data.checkpoint)}

## Recommended next action

${clean(data.recommended_next_action)}

## Confidence and uncertainty

- Confidence: ${clean(data.confidence)}

${clean(data.uncertainty_notes)}

${structuredBlock(data)}
`;
}
