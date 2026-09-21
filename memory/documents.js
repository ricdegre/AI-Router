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

${clean(data.task)}

## Status

${clean(data.status)}

## Acceptance criteria

${clean(data.acceptanceCriteria)}

## Completed work

${clean(data.completedWork)}

## Remaining work

${clean(data.remainingWork)}

## Do not modify

${clean(data.doNotModify)}

${structuredBlock(data)}
`;
}

export function renderHandoff(data) {
  return `# Agent Handoff

## Task

${clean(data.task)}

## Agent and resource

- Agent: ${clean(data.agent)}
- Provider: ${clean(data.provider)}
- Account/profile: ${clean(data.accountProfile)}
- Status: ${clean(data.status)}
- Started: ${clean(data.startedAt)}
- Completed: ${clean(data.completedAt)}

## Completed work

${clean(data.completedWork)}

## Remaining work

${clean(data.remainingWork)}

## Files touched

${clean(data.filesTouched)}

## Validation

${clean(data.validation)}

## Failures already attempted

${clean(data.failures)}

## Do not modify

${clean(data.doNotModify)}

## Last checkpoint

${clean(data.lastCheckpoint)}

## Recommended next action

${clean(data.recommendedNextAction)}

${structuredBlock(data)}
`;
}

