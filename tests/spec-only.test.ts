import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionScriptResult } from "../src/driver/session";
import {
	RunLedger,
	runTrial,
	specOnlySteps,
} from "../src/orchestrator/scheduler";
import type { Sandbox, SandboxProvider } from "../src/providers/types";
import { loadRegistry } from "../src/registry";
import { renderScorecard } from "../src/report/markdown";
import { buildResults } from "../src/report/results";
import type {
	CandidateEntry,
	SessionStep,
	SpecScore,
	TrialResult,
} from "../src/types";
import { RunConfig } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "he-spec-only-"));
const registry = loadRegistry("config/registry.yaml");
const base = registry.candidates[0] as CandidateEntry;

class MemorySandbox implements Sandbox {
	id = "mem-trial";
	workspacePath = "/workspace";
	writes = new Map<string, string>();
	execs: Array<{ command: string; env?: Record<string, string> }> = [];
	destroyed = false;

	async exec(command: string, opts?: { env?: Record<string, string> }) {
		this.execs.push({ command, env: opts?.env });
		return { exitCode: 0, stdout: "", stderr: "" };
	}
	async copyOut() {}
	async writeFile(sandboxPath: string, content: string) {
		this.writes.set(sandboxPath, content);
	}
	async destroy() {
		this.destroyed = true;
	}
}

class MemoryProvider implements SandboxProvider {
	id = "worktree" as const;
	snapshotId = "memory-snapshot";
	sandboxes: MemorySandbox[] = [];
	async provision() {
		const sandbox = new MemorySandbox();
		this.sandboxes.push(sandbox);
		return sandbox;
	}
}

/** Candidate whose claude-code session script is exactly `script`. */
function candidateWith(script: SessionStep[]) {
	return {
		...base,
		harnesses: {
			...base.harnesses,
			"claude-code": {
				install: ["install-ok"],
				session: script,
				continuation: { allowlist: ["go"], maxContinuations: 2 },
			},
		},
	};
}

function specScore(overall: number): SpecScore {
	const criteria = [
		"prdCoverage",
		"implementability",
		"concreteness",
		"decisionCapture",
		"clarity",
	] as const;
	return {
		judgeModel: "judge-model",
		criterionScores: criteria.map((criterion) => ({
			criterion,
			samples: [{ score: overall, justification: "test" }],
			median: overall,
		})),
		criterionMedians: Object.fromEntries(
			criteria.map((c) => [c, overall]),
		) as SpecScore["criterionMedians"],
		overall,
		note: null,
	};
}

const script: SessionStep[] = [
	{ prompt: "setup-traffic", newSession: false }, // untagged = setup
	{ prompt: "/design", newSession: false, phase: "design" },
	{ prompt: "implement", newSession: true, phase: "build" },
];

function runConfig(specOnly: boolean) {
	return RunConfig.parse({
		candidates: [base.id],
		trialsPerCandidate: 1,
		provider: "worktree",
		specOnly,
	});
}

const depsBase = () => ({
	registry: { ...registry, basePrompt: "same task", candidates: [base] },
	prdContent: "# PRD",
	prdSha256: "prd",
	testPlanSha256: "plan",
	harnessVersion: "harness-v1",
	archive: async () => ({}) as never,
});

describe("spec-only mode (Phase D)", () => {
	test("stop-after-design: only design steps run; untagged setup and build steps are skipped", () => {
		expect(specOnlySteps(script).map((s) => s.prompt)).toEqual(["/design"]);
		// "Through the last design step": a build step between design steps is
		// skipped too, so spec-only runs stay code-free.
		const sandwiched: SessionStep[] = [
			{ prompt: "d1", newSession: false, phase: "design" },
			{ prompt: "b1", newSession: false, phase: "build" },
			{ prompt: "d2", newSession: false, phase: "design" },
		];
		expect(specOnlySteps(sandwiched).map((s) => s.prompt)).toEqual([
			"d1",
			"d2",
		]);
	});

	test("spec-only trial executes design steps only and buckets spend by phase", async () => {
		const provider = new MemoryProvider();
		let seen: SessionStep[] = [];
		const executeScript = async (
			_sandbox: Sandbox,
			opts: { steps: SessionStep[] },
		): Promise<SessionScriptResult> => {
			seen = opts.steps;
			const usage = {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			};
			return {
				records: [
					{
						sessionId: "s",
						stepIndex: 0,
						durationMs: 100,
						numTurns: 1,
						costUsd: 2,
						usage,
						isError: false,
					},
					// continuation traffic lands past the script → setup bucket
					{
						sessionId: "s",
						stepIndex: 9,
						durationMs: 20,
						numTurns: 1,
						costUsd: 0.5,
						usage,
						isError: false,
					},
				],
				transcripts: ["{}", "{}"],
				status: "completed",
				cappedBy: null,
				notes: [],
			};
		};
		const trial = await runTrial(
			{ trialId: "design-t1", candidate: candidateWith(script), trialIndex: 0 },
			runConfig(true),
			{
				...depsBase(),
				provider,
				runDir: join(tmp, "design-run"),
				executeScript: executeScript as never,
			},
			new RunLedger(10),
		);
		expect(seen.map((s) => s.prompt)).toEqual(["/design"]);
		const phases = trial.telemetry?.phases;
		expect(phases?.design.costUsd).toBe(2);
		expect(phases?.setup.costUsd).toBe(0.5);
		expect(phases?.build.costUsd).toBe(0);
		expect(phases?.design.durationMs).toBe(100);
		// setup carries install time plus continuation duration
		expect(phases?.setup.durationMs).toBeGreaterThanOrEqual(20);
		// provenance keeps the full registry script for reproducibility
		expect(trial.provenance.sessionScript.length).toBe(3);
	});

	test("zero design-tagged steps: candidate excluded without provisioning", async () => {
		const provider = new MemoryProvider();
		let called = false;
		const candidate = candidateWith([
			{ prompt: "setup-traffic", newSession: false },
			{ prompt: "implement", newSession: true, phase: "build" },
		]);
		const trial = await runTrial(
			{ trialId: "ineligible-t1", candidate, trialIndex: 0 },
			runConfig(true),
			{
				...depsBase(),
				provider,
				runDir: join(tmp, "ineligible-run"),
				executeScript: (async () => {
					called = true;
					return {
						records: [],
						transcripts: [],
						status: "completed",
						cappedBy: null,
						notes: [],
					} as SessionScriptResult;
				}) as never,
			},
			new RunLedger(10),
		);
		expect(called).toBe(false);
		expect(provider.sandboxes.length).toBe(0);
		expect(trial.provenance.status).toBe("skipped:ineligible");
		expect(trial.provenance.notes.at(-1)).toMatch(/no design-tagged steps/);
		expect(trial.telemetry).toBeNull();
	});

	test("spec-only results normalize weights to specQuality=1 and render n/a", () => {
		const startedAt = new Date().toISOString();
		const trial: TrialResult = {
			provenance: {
				runId: "run-spec",
				trialId: "design-t1",
				candidate: base.id,
				candidateVersion: base.pinnedVersion,
				harness: "claude-code",
				harnessVersion: "harness-v1",
				model: "worker",
				provider: "worktree",
				snapshotId: "memory-snapshot",
				prdSha256: "prd",
				testPlanSha256: "plan",
				sessionScript: script,
				startedAt,
				endedAt: startedAt,
				status: "completed",
				cappedBy: null,
				notes: [],
			},
			telemetry: {
				sessions: [],
				agentDurationMs: 120,
				setupDurationMs: 5,
				totalCostUsd: 2.5,
				totalTokens: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
				},
				totalTurns: 2,
				phases: {
					design: { durationMs: 100, costUsd: 2, tokens: 15 },
					build: { durationMs: 0, costUsd: 0, tokens: 0 },
					setup: { durationMs: 25, costUsd: 0.5, tokens: 0 },
				},
			},
			grades: {
				trialId: "design-t1",
				adherence: null,
				quality: null,
				specQuality: specScore(7.5),
				integration: null,
				designAdherence: null,
			},
		};
		const results = buildResults({
			runId: "run-spec",
			config: runConfig(true),
			prdSha256: "prd",
			testPlanSha256: "plan",
			startedAt,
			endedAt: startedAt,
			trials: [trial],
		});
		expect(results.mode).toBe("spec-only");
		expect(results.weights.specQuality).toBe(1);
		expect(results.weights.prdAdherence).toBe(0);
		expect(results.weights.codeQuality).toBe(0);
		expect(results.weights.speed).toBe(0);
		expect(results.weights.tokenSpend).toBe(0);
		expect(results.scores[0]?.composite).toBe(75); // 7.5/10 × 10 × weight 1
		expect(results.scores[0]?.costs?.designCost).toEqual({
			usd: 2,
			tokens: 15,
		});
		const md = renderScorecard(results);
		expect(md).toContain("Spec-only run");
		expect(md).toContain("n/a");
	});
});
