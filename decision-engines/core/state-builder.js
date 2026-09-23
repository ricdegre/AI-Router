const cleanArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 32) : [];

export class DecisionStateBuilder {
  build(task, deterministic, context = {}, maxChars = 12_000) {
    const state = {
      state_version: '0.1',
      task: { objective: String(task.objective ?? '').slice(0, 2_000), type: task.task_type ?? 'general', risk: task.risk ?? 'low', required_capabilities: cleanArray(task.required_capabilities), current_state: task.current_state ?? null },
      task_analysis: task.task_analysis ? { intent: task.task_analysis.intent, scope: task.task_analysis.scope, write_mode: task.task_analysis.write_mode, complexity: task.task_analysis.complexity, required_capabilities: cleanArray(task.task_analysis.required_capabilities), required_strength: task.task_analysis.required_strength, risk: task.task_analysis.risk, context_requirement: task.task_analysis.context_requirement, parallelizable: Boolean(task.task_analysis.parallelizable) } : null,
      project: context.project ? { type: context.project.type ?? null, git: context.project.git ? { is_repository: Boolean(context.project.git.isRepository), dirty: context.project.git.dirty ?? null } : null } : null,
      candidates: deterministic.evaluations.map((item) => ({ provider_id: item.provider_id, profile_id: item.profile_id, model_id: item.model_id, execution_channel: item.execution_channel, reasoning_effort: item.reasoning_effort, eligible: item.eligible, health: item.health, capabilities: cleanArray(item.capabilities), strength_class: item.strength_class, cost_category: item.cost_category, rejected: cleanArray(item.rejected) })),
      recent_failures: (task.recent_failures ?? []).slice(-10).map((item) => ({ provider_id: item.provider_id, profile_id: item.profile_id, category: item.failure_category ?? null })),
      preferences: { prefer_local: task.cost_policy?.prefer_local ?? true, prefer_subscription: task.cost_policy?.prefer_subscription ?? true, allow_metered: task.cost_policy?.allow_metered ?? false },
      manual_overrides: { provider_id: task.manual_provider ?? null, profile_id: task.manual_profile ?? null, model_id: task.manual_model ?? null, execution_channel: task.manual_execution_channel ?? null, reasoning_effort: task.manual_reasoning_effort ?? null }
    };
    const initialSize = JSON.stringify(state).length;
    if (initialSize > maxChars) { state.task.objective = state.task.objective.slice(0, 256); state.recent_failures = state.recent_failures.slice(-5); for (const candidate of state.candidates) candidate.rejected = candidate.rejected.slice(0, 4); }
    while (JSON.stringify(state).length > maxChars && state.candidates.length > 1) state.candidates.pop();
    const compact = JSON.stringify(state);
    return { state, input_size_chars: compact.length, estimated_input_tokens: Math.ceil(compact.length / 4), truncated: initialSize > maxChars };
  }
}
