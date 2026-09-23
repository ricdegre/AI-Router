export function buildStructuredTaskPrompt(request = {}) {
  const analysis = request.task_analysis ?? request.task?.task_analysis ?? {};
  const readOnlyAnalysis = analysis.write_mode === 'read_only';
  return `You are a subordinate execution worker for AI Router. AI Router owns routing, file mutation, Git, memory, validation, checkpoints, and handoff. Use only the task and router-supplied project evidence below. Do not call tools or inspect paths outside this supplied context.

RESPONSE CONTRACT
Return only one JSON object, with no Markdown fence or commentary. It must contain exactly these top-level fields: schema_version (the string "0.1"), status (one of "ok", "partial", "blocked", "failed"), summary (a non-empty string), observations (string array), proposed_actions (object array), validation_requested (string array), remaining_work (string array), uncertainty (string array), and handoff_notes (string array).
${readOnlyAnalysis ? 'This is a read-only analysis. Propose no actions. If the supplied project evidence supports a complete answer, use status "ok", leave remaining_work empty, and provide evidence-based observations. Use "partial" only when specific missing evidence prevents completion.' : `For every requested file change, propose actions in AI Router's exact action protocol. Each action must be {"action_id":"stable-kebab-id","type":"create_file|modify_file|append_file","target":"workspace-relative/path","parameters":{...}}. Never use id, instruction, or file_path in place of these fields. create_file parameters: {"content":"full text","create_parents":true|false}. modify_file parameters: {"patch":{"kind":"exact_replace","expected_sha256":"SHA-256 of the exact source text","search":"unique exact source text","replacement":"replacement text"}}. append_file parameters: {"content":"text to append","expected_sha256":"SHA-256 of the exact source text"}. The router will reject actions without this schema. Do not invent a source hash; request/read the file first through supplied evidence or use read_file action, and only propose changes after evidence is available. Do not propose shell commands or arbitrary tools.`}

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
