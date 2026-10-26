import type {
	Phase,
	PhaseTelemetry,
	SessionRecord,
	SessionStep,
	TokenUsage,
	TrialTelemetry,
} from "../types";

/**
 * Aggregate per-session records into trial telemetry. Speed dimension uses
 * agent working time only — sandbox setup/install time is recorded
 * separately and never counts toward speed (run-telemetry spec).
 */
export function aggregateTelemetry(
	sessions: SessionRecord[],
	setupDurationMs: number,
	steps: SessionStep[] = [],
): TrialTelemetry {
	const totalTokens: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
	let agentDurationMs = 0;
	let totalCostUsd = 0;
	let totalTurns = 0;
	// Phase buckets: untagged steps, install time and continuation traffic all
	// land in setup. `steps` is the script the trial actually ran (design-only
	// in spec-only runs), so stepIndex lines up with its phase tags.
	const phases: Record<Phase, PhaseTelemetry> = {
		design: { durationMs: 0, costUsd: 0, tokens: 0 },
		build: { durationMs: 0, costUsd: 0, tokens: 0 },
		setup: { durationMs: setupDurationMs, costUsd: 0, tokens: 0 },
	};
	for (const s of sessions) {
		agentDurationMs += s.durationMs;
		totalCostUsd += s.costUsd;
		totalTurns += s.numTurns;
		totalTokens.inputTokens += s.usage.inputTokens;
		totalTokens.outputTokens += s.usage.outputTokens;
		totalTokens.cacheReadTokens += s.usage.cacheReadTokens;
		totalTokens.cacheCreationTokens += s.usage.cacheCreationTokens;
		const phase: Phase = steps[s.stepIndex]?.phase ?? "setup";
		const bucket = phases[phase];
		bucket.durationMs += s.durationMs;
		bucket.costUsd += s.costUsd;
		bucket.tokens += s.usage.inputTokens + s.usage.outputTokens;
	}
	return {
		sessions,
		agentDurationMs,
		setupDurationMs,
		totalCostUsd,
		totalTokens,
		totalTurns,
		phases,
	};
}
