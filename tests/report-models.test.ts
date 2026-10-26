import { describe, expect, test } from "bun:test";
import { renderScorecard } from "../src/report/markdown";
import { buildResults } from "../src/report/results";
import { RunConfig, type TrialResult } from "../src/types";

// Minimal completed trial with grades so a score is produced.
function trial(candidate: string): TrialResult {
	return {
		provenance: {
			runId: "run-x",
			trialId: `${candidate}-t1`,
			candidate,
			candidateVersion: "1.0.0",
			harness: "claude-code",
			harnessVersion: "2.1.170",
			model: "x",
			provider: "worktree",
			snapshotId: null,
			prdSha256: "sha",
			testPlanSha256: "plan",
			sessionScript: [],
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			status: "completed",
			cappedBy: null,
			notes: [],
		},
		telemetry: {
			sessions: [],
			agentDurationMs: 600000,
			setupDurationMs: 1000,
			totalCostUsd: 0.3,
			totalTokens: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
			totalTurns: 4,
		},
		grades: {
			trialId: `${candidate}-t1`,
			adherence: {
				gradedScore: 70,
				passAt1: true,
				completeFailure: false,
				stepResults: [],
			},
			quality: { judgeModel: "j", criteria: [], score: 60 },
			integration: null,
		},
	} as unknown as TrialResult;
}

describe("reporting with model registry (tasks 3.1/3.2)", () => {
	const config = RunConfig.parse({
		candidates: ["gsd"],
		trialsPerCandidate: 1,
		provider: "worktree",
	});

	test("results key scores by the resolved worker model, not config.model", () => {
		const results = buildResults({
			runId: "run-x",
			config, // config.model is the default claude-opus-4-6
			prdSha256: "sha",
			testPlanSha256: "plan",
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			trials: [trial("gsd")],
			workerModel: {
				name: "glm-4.7",
				provider: "z.ai",
				modelId: "glm-4.7",
				endpointHost: "api.z.ai",
			},
			judgeModel: {
				name: "claude-sonnet-4-6",
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				endpointHost: null,
			},
			crossVendorJudge: true,
			costSource: "tokens-only",
		});
		expect(results.scores[0]?.model).toBe("glm-4.7");
		expect(results.workerModel?.provider).toBe("z.ai");
		expect(results.crossVendorJudge).toBe(true);
		expect(results.costSource).toBe("tokens-only");
		// Embedded config reconciled to the resolved worker (not the default).
		expect(results.config.model).toBe("glm-4.7");
	});

	test("scorecard renders cross-vendor and cost-basis caveats", () => {
		const results = buildResults({
			runId: "run-x",
			config,
			prdSha256: "sha",
			testPlanSha256: "plan",
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			trials: [trial("gsd")],
			workerModel: {
				name: "glm-4.7",
				provider: "z.ai",
				modelId: "glm-4.7",
				endpointHost: "api.z.ai",
			},
			judgeModel: {
				name: "claude-sonnet-4-6",
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				endpointHost: null,
			},
			crossVendorJudge: true,
			costSource: "tokens-only",
		});
		const md = renderScorecard(results);
		expect(md).toContain("worker model **glm-4.7 (z.ai)**");
		expect(md).toContain("Cross-vendor judge");
		expect(md).toContain("tokens-only");
	});

	test("native run has no caveats and keeps backward-compatible defaults", () => {
		const results = buildResults({
			runId: "run-x",
			config,
			prdSha256: "sha",
			testPlanSha256: "plan",
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			trials: [trial("gsd")],
		});
		// Omitted fields default: no cross-vendor caveat, harness-reported cost.
		expect(results.crossVendorJudge).toBe(false);
		expect(results.costSource).toBe("harness-reported");
		const md = renderScorecard(results);
		expect(md).not.toContain("Cross-vendor judge");
	});
});

describe("results v2: spec quality, phase-split cost, cost-per-passing-step", () => {
	const weights = {
		prdAdherence: 0.35,
		codeQuality: 0.2,
		specQuality: 0.15,
		speed: 0.15,
		tokenSpend: 0.15,
	};
	const config = RunConfig.parse({
		candidates: ["gsd"],
		trialsPerCandidate: 1,
		provider: "worktree",
		weights,
	});
	const judge = {
		name: "claude-sonnet-4-6",
		provider: "anthropic",
		modelId: "claude-sonnet-4-6",
		endpointHost: null,
	};

	/** One graded trial: design step + build step, 5-criterion spec score. */
	function gradedTrial(): TrialResult {
		const t = trial("gsd");
		t.provenance.sessionScript = [
			{ prompt: "design", newSession: false, phase: "design" },
			{ prompt: "build", newSession: true, phase: "build" },
		];
		t.telemetry = {
			sessions: [
				{
					sessionId: "s1",
					stepIndex: 0,
					durationMs: 1000,
					numTurns: 1,
					costUsd: 1,
					isError: false,
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
				},
				{
					sessionId: "s2",
					stepIndex: 1,
					durationMs: 1000,
					numTurns: 1,
					costUsd: 6,
					isError: false,
					usage: {
						inputTokens: 300,
						outputTokens: 150,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
				},
			],
			agentDurationMs: 2000,
			setupDurationMs: 0,
			totalCostUsd: 7,
			totalTokens: {
				inputTokens: 400,
				outputTokens: 200,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
			totalTurns: 2,
		};
		const criteria = [
			"prdCoverage",
			"implementability",
			"concreteness",
			"decisionCapture",
			"clarity",
		] as const;
		t.grades = {
			trialId: t.provenance.trialId,
			adherence: {
				gradedScore: 50,
				passAt1: false,
				completeFailure: false,
				stepResults: [],
				weightedCredit: 2,
			},
			quality: t.grades?.quality ?? null,
			specQuality: {
				judgeModel: "claude-sonnet-4-6",
				criterionScores: criteria.map((criterion) => ({
					criterion,
					samples: [{ score: 8, justification: "explicit" }],
					median: 8,
				})),
				criterionMedians: Object.fromEntries(
					criteria.map((c) => [c, 8]),
				) as Record<(typeof criteria)[number], number>,
				overall: 8,
				note: null,
			},
			integration: null,
			designAdherence: null,
		};
		return t;
	}

	test("specQuality dimension, phase costs, judge models and snapshot ids", () => {
		const results = buildResults({
			runId: "run-v2",
			config,
			prdSha256: "sha",
			testPlanSha256: "plan",
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			trials: [gradedTrial()],
			judgeModels: { codeJudge: judge, specJudge: judge },
		});
		expect(results.schemaVersion).toBe(2);
		expect(results.mode).toBe("full");
		const s = results.scores[0];
		expect(s?.dimensions.specQuality).toBe(80);
		expect(s?.costs?.designCost).toEqual({ usd: 1, tokens: 150 });
		expect(s?.costs?.buildCost).toEqual({ usd: 6, tokens: 450 });
		expect(s?.costs?.setupCost).toEqual({ usd: 0, tokens: 0 });
		// buildCost ÷ Σ(stepWeight × credit) = 6 / 2
		expect(s?.costs?.costPerPassingStepUsd).toBe(3);
		expect(results.judgeModels?.specJudge.name).toBe("claude-sonnet-4-6");
		expect(results.snapshotIds).toEqual({
			worker: null,
			codeJudge: null,
			specJudge: null,
		});
		const md = renderScorecard(results);
		expect(md).toContain("Spec quality");
		expect(md).toContain("| 1 | **gsd** |");
	});

	test("spec-only runs are marked; zero passing steps → cost-per-passing-step n/a", () => {
		const t = gradedTrial();
		if (t.grades?.adherence) t.grades.adherence.weightedCredit = 0;
		const results = buildResults({
			runId: "run-v2-spec",
			config: RunConfig.parse({ ...config, specOnly: true }),
			prdSha256: "sha",
			testPlanSha256: "plan",
			startedAt: "2026-06-13T00:00:00.000Z",
			endedAt: "2026-06-13T00:10:00.000Z",
			trials: [t],
		});
		expect(results.mode).toBe("spec-only");
		expect(results.scores[0]?.costs?.costPerPassingStepUsd).toBeNull();
		expect(renderScorecard(results)).toContain("Spec-only run");
	});
});
