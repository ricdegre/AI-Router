export function buildStructuredTaskPrompt(request = {}) {
  const analysis = request.task_analysis ?? request.task?.task_analysis ?? {};
  const readOnlyAnalysis = analysis.write_mode === 'read_only';
  return `You are a subordinate execution worker for AI Router. AI Router owns routing, file mutation, Git, memory, validation, checkpoints, and handoff. Use only the task and router-supplied project evidence below. Do not call tools or inspect paths outside this supplied context.

RESPONSE CONTRACT
Return only one JSON object, with no Markdown fence or commentary. It must contain exactly these top-level fields: schema_version (the string "0.1"), status (one of "ok", "partial", "blocked", "failed"), summary (a non-empty string), observations (string array), proposed_actions (object array), validation_requested (string array), remaining_work (string array), uncertainty (string array), and handoff_notes (string array).
${readOnlyAnalysis ? 'This is a read-only analysis. Propose no actions. If the supplied project evidence supports a complete answer, use status "ok", leave remaining_work empty, and provide evidence-based observations. Use "partial" only when specific missing evidence prevents completion.' : 'Preserve any proposed action object supplied by the task exactly.'}

TASK ANALYSIS
${JSON.stringify(analysis)}

TASK
${request.prompt ?? request.task?.objective ?? ''}

ATTACHMENTS
${JSON.stringify((request.attachments ?? []).map(({ path: _path, source: _source, ...attachment }) => attachment))}
The attachment metadata above corresponds to image content delivered separately through the provider's native image-input mechanism. Analyze the actual images, not only their filenames or metadata.

ROUTER CONTEXT
${request.context ?? ''}`;
}
