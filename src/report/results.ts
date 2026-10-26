import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { median } from "../grading/judge";
import { countableTrials, isInconclusive, scoreRun } from "../grading/scoring";
import {
	type CandidateCosts,
	type CostSource,
	type ModelRef,
	RESULTS_SCHEMA_VERSION,
	type RunConfig,
	RunResults,
	type TrialResult,
	type Weights,
} from "../types";

type Phase = "design" | "build" | "setup";

/** Bucket one trial's spend by phase. Prefers the trial-level phase buckets
 *  recorded by aggregateTelemetry; falls back to the session-script derivation
 *  for pre-Phase-D documents (same result, just re-parsed). */
function phaseCosts(
	trial: TrialResult,
): Record<Phase, { usd: number; tokens: number }> {
	const recorded = trial.telemetry?.phases;
	if (recorded) {
		return {
			design: { usd: recorded.design.costUsd, tokens: recorded.design.tokens },
			build: { usd: recorded.build.costUsd, tokens: recorded.build.tokens },
			setup: { usd: recorded.setup.costUsd, tokens: recorded.setup.tokens },
		};
	}
	const out: Record<Phase, { usd: number; tokens: number }> = {
		design: { usd: 0, tokens: 0 },
		build: { usd: 0, tokens: 0 },
		setup: { usd: 0, tokens: 0 },
	};
	for (const session of trial.telemetry?.sessions ?? []) {
		const phase =
			trial.provenance.sessionScript[session.stepIndex]?.phase ?? "setup";
		out[phase].usd += session.costUsd;
		out[phase].tokens +=
			session.usage.inputTokens + session.usage.outputTokens;
	}
	return out;
}

function medianOr(values: number[]): number | null {
	return values.length > 0 ? median(values) : null;
}

/** Phase-split spend (median across counted trials) + cost-per-passing-step. */
function candidateCosts(trials: TrialResult[]): CandidateCosts {
	const usable = countableTrials(trials);
	const phases = usable.map(phaseCosts);
	const bucket = (phase: Phase) => ({
		usd:
			Math.round((medianOr(phases.map((p) => p[phase].usd)) ?? 0) * 1e4) / 1e4,
		tokens: Math.round(medianOr(phases.map((p) => p[phase].tokens)) ?? 0),
	});
	const perPassingStep: number[] = [];
	for (const [i, trial] of usable.entries()) {
		const credit = trial.grades?.adherence?.weightedCredit ?? 0;
		// n/a (null), never 0, when nothing passed the test plan.
		if (credit > 0) perPassingStep.push((phases[i]?.build.usd ?? 0) / credit);
	}
	return {
		designCost: bucket("design"),
		buildCost: bucket("build"),
		setupCost: bucket("setup"),
		costPerPassingStepUsd: medianOr(perPassingStep),
	};
}

export interface BuildResultsInput {
	runId: string;
	config: RunConfig;
	/** Allows re-weighting at report time without re-running (grading-rubric spec). */
	weights?: Weights;
	prdSha256: string;
	testPlanSha256: string | null;
	startedAt: string;
	endedAt: string | null;
	trials: TrialResult[];
	/** Resolved model profiles + caveats (model-registry). */
	workerModel?: ModelRef;
	judgeModel?: ModelRef;
	/** Both graders, separately pinned (v2). */
	judgeModels?: { codeJudge: ModelRef; specJudge: ModelRef };
	crossVendorJudge?: boolean;
	costSource?: CostSource;
}

/**
 * Build the machine-readable results document (task 7.1). Schema v2 — adds
 * specQuality, phase-split costs, cost-per-passing-step, judgeModels and
 * snapshotIds. Keyed by candidate/harness/model for cross-run comparison.
 */
export function buildResults(input: BuildResultsInput): RunResults {
	// Spec-only: specQuality is the only scored dimension, so normalize its
	// weight to 1.0 (others 0 = n/a; never "0 points" for an ungraded axis).
	const weights: Weights = input.config.specOnly
		? {
				prdAdherence: 0,
				codeQuality: 0,
				specQuality: 1,
				speed: 0,
				tokenSpend: 0,
			}
		: (input.weights ?? input.config.weights);
	// Reconcile the embedded config with the resolved worker model so
	// `config.model` agrees with workerModel/provenance instead of keeping its
	// default while --worker-model is in effect (also fixes re-reported runs).
	const config = input.config;
	if (input.workerModel) config.model = input.workerModel.name;
	// Key scores by the resolved worker model when present.
	const scores = scoreRun({
		harness: config.harness,
		model: input.workerModel?.name ?? config.model,
		weights,
		trials: input.trials,
	});
	const byCandidate = new Map<string, TrialResult[]>();
	for (const trial of input.trials) {
		const list = byCandidate.get(trial.provenance.candidate) ?? [];
		list.push(trial);
		byCandidate.set(trial.provenance.candidate, list);
	}
	for (const score of scores) {
		score.costs = candidateCosts(byCandidate.get(score.candidate) ?? []);
	}
	const exclusions = input.trials
		.filter(
			(t) =>
				t.provenance.status === "infra-failed" ||
				t.provenance.status === "skipped:budget" ||
				t.provenance.status === "skipped:ineligible",
		)
		.map((t) => ({
			trialId: t.provenance.trialId,
			status: t.provenance.status,
			reason: t.provenance.notes.at(-1) ?? t.provenance.status,
		}));
	const judgeModels = input.judgeModels;
	return RunResults.parse({
		schemaVersion: RESULTS_SCHEMA_VERSION,
		runId: input.runId,
		mode: input.config.specOnly ? "spec-only" : "full",
		config: input.config,
		weights,
		prdSha256: input.prdSha256,
		testPlanSha256: input.testPlanSha256,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		workerModel: input.workerModel,
		judgeModel: input.judgeModel,
		judgeModels,
		snapshotIds:
			input.workerModel || judgeModels
				? {
						worker: input.workerModel?.snapshotId ?? null,
						codeJudge: judgeModels?.codeJudge.snapshotId ?? null,
						specJudge: judgeModels?.specJudge.snapshotId ?? null,
					}
				: undefined,
		crossVendorJudge: input.crossVendorJudge ?? false,
		costSource: input.costSource ?? "harness-reported",
		scores,
		// Cohort lifecycle fields are set at publish time; default them here so
		// every written trial carries the trio.
		trials: input.trials.map((t) => ({
			cohortStatus: "valid" as const,
			cohortId: null,
			dnd: false,
			...t,
		})),
		exclusions,
		inconclusive: isInconclusive(scores),
	});
}

export function writeResults(runDir: string, results: RunResults): string {
	const path = join(runDir, "results.json");
	writeFileSync(path, JSON.stringify(results, null, 2));
	return path;
}
