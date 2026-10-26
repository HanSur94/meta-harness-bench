import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { CriterionScore, QualityCriterion, QualityResult } from "../types";

const execFileAsync = promisify(execFile);

/**
 * One rubric line, supplied by the caller. The code-quality judge passes
 * CRITERIA; the spec-quality judge passes its own five-criterion rubric.
 */
export interface JudgeCriterion {
	key: string;
	prompt: string;
}

export const CRITERIA: { key: QualityCriterion; prompt: string }[] = [
	{
		key: "tests",
		prompt:
			"Are the tests meaningful and passing? Run the artifact's own test suite and weigh observed results heavily: coverage of core behaviors, assertions that would actually catch regressions, no trivially-green tests.",
	},
	{
		key: "architecture",
		prompt:
			"Does the structure match the layered architecture in SPEC-REFERENCE.md §3.2 (policy/config/coordination/execution/integration/observability)? Are boundaries clean and dependencies pointed the right way?",
	},
	{
		key: "errorHandling",
		prompt:
			"Is error handling robust? Typed errors where the spec requires, no swallowed failures, retries/timeouts where external calls occur, crash-safety in the daemon loop.",
	},
	{
		key: "deadCode",
		prompt:
			"Is the codebase free of dead code, duplicated logic, vestigial scaffolding, and unused dependencies?",
	},
	{
		key: "documentation",
		prompt:
			"Is documentation adequate? README/setup accuracy, WORKFLOW.md contract documented, non-obvious decisions explained where they matter.",
	},
];

export const JUDGE_SYSTEM = `You are a senior engineer reviewing an anonymous codebase that implements a daemon service against the specification provided at SPEC-REFERENCE.md in the workspace.

Score ONE criterion from 0-10. Base your score on evidence: run commands (tests, linters, type checkers, grep) and cite what you observed. Do not assume; verify. Do not attempt to identify who or what produced the code — judge the artifact only. NEVER modify the artifact.

When done, call record_score exactly once with {score: 0-10, justification: "<evidence-citing rationale>"}.`;

export interface JudgeOptions {
	model: string;
	blindWorkspaceDir: string;
	samples?: number;
	maxIterationsPerSample?: number;
	apiKey?: string;
	/** Called after each criterion is scored — checkpoint hook. */
	onCriterion?: (c: CriterionScore) => void;
	/** Criteria already scored in a prior interrupted run. */
	preScored?: CriterionScore[];
	client?: Anthropic;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

async function judgeOneSample(
	client: Anthropic,
	opts: { model: string; blindWorkspaceDir: string; system: string; maxIterationsPerSample?: number },
	criterion: JudgeCriterion,
): Promise<{ score: number; justification: string }> {
	const messages: Anthropic.MessageParam[] = [
		{
			role: "user",
			content: `Criterion: ${criterion.prompt}\nWorkspace: ${opts.blindWorkspaceDir}`,
		},
	];
	const tools: Anthropic.Tool[] = [
		{
			name: "bash",
			description: "Run a shell command in the workspace (read-only intent).",
			input_schema: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
		{
			name: "record_score",
			description: "Record the criterion score. Call exactly once, then stop.",
			input_schema: {
				type: "object",
				properties: {
					score: { type: "number", minimum: 0, maximum: 10 },
					justification: { type: "string" },
				},
				required: ["score", "justification"],
			},
		},
	];

	const maxIterations = opts.maxIterationsPerSample ?? 25;
	for (let i = 0; i < maxIterations; i++) {
		const response = await client.messages.create({
			model: opts.model,
			max_tokens: 2048,
			temperature: 0,
			system: opts.system,
			messages,
			tools,
		});
		messages.push({ role: "assistant", content: response.content });
		const toolUses = response.content.filter(
			(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
		);
		if (toolUses.length === 0) break;
		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const use of toolUses) {
			if (use.name === "record_score") {
				const input = use.input as { score?: unknown; justification?: unknown };
				const raw = Number(input.score);
				if (!Number.isFinite(raw)) {
					// Malformed score (missing/NaN): refuse it and ask again instead
					// of poisoning the sample with NaN.
					results.push({
						type: "tool_result",
						tool_use_id: use.id,
						content:
							"record_score failed: score must be a finite number 0-10. Call record_score again with a valid score.",
					});
					continue;
				}
				return {
					score: Math.max(0, Math.min(10, raw)),
					justification: String(input.justification ?? ""),
				};
			}
			const input = use.input as { command: string };
			let output: string;
			try {
				const { stdout, stderr } = await execFileAsync(
					"bash",
					["-c", input.command],
					{
						cwd: opts.blindWorkspaceDir,
						timeout: 120_000,
						maxBuffer: 8 * 1024 * 1024,
					},
				);
				output = `exit 0\n${stdout.slice(0, 12000)}\n${stderr.slice(0, 3000)}`;
			} catch (err) {
				const e = err as {
					code?: number | string;
					stdout?: string;
					stderr?: string;
				};
				output = `exit ${e.code ?? "error"}\n${(e.stdout ?? "").slice(0, 12000)}\n${(e.stderr ?? String(err)).slice(0, 3000)}`;
			}
			results.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: output,
			});
		}
		messages.push({ role: "user", content: results });
	}
	return {
		score: 0,
		justification: "judge did not record a score within iteration budget",
	};
}

/** One scored rubric line, generic over the caller's criterion keys. */
export interface JudgedCriterion {
	criterion: string;
	samples: { score: number; justification: string }[];
	median: number;
	justification: string;
}

export interface JudgeRunOptions {
	model: string;
	blindWorkspaceDir: string;
	samples?: number;
	maxIterationsPerSample?: number;
	apiKey?: string;
	/** Rubric the caller supplies; defaults to the code-quality rubric. */
	criteria?: JudgeCriterion[];
	/** Judge system prompt; defaults to the code-quality prompt. */
	system?: string;
	/** Criteria already scored in a prior interrupted run. */
	preScored?: JudgedCriterion[];
	client?: Anthropic;
}

/**
 * Parameterized judge core: pinned model, temperature 0, tool access, N
 * independent samples per criterion, median taken. Callers supply the rubric
 * (criteria + system prompt) — the code-quality judge and the spec-quality
 * judge share this loop rather than cloning it.
 */
export async function judgeCriteria(
	opts: JudgeRunOptions,
): Promise<{ judgeModel: string; criteria: JudgedCriterion[] }> {
	const client =
		opts.client ??
		new Anthropic(
			process.env.ANTHROPIC_AUTH_TOKEN
				? { authToken: process.env.ANTHROPIC_AUTH_TOKEN }
				: { apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY },
		);
	const samples = opts.samples ?? 3;
	const criteria: JudgedCriterion[] = [...(opts.preScored ?? [])];
	const done = new Set(criteria.map((c) => c.criterion));
	for (const criterion of opts.criteria ?? CRITERIA) {
		if (done.has(criterion.key)) continue;
		const runs: { score: number; justification: string }[] = [];
		for (let s = 0; s < samples; s++) {
			runs.push(
				await judgeOneSample(
					client,
					{
						model: opts.model,
						blindWorkspaceDir: opts.blindWorkspaceDir,
						system: opts.system ?? JUDGE_SYSTEM,
						maxIterationsPerSample: opts.maxIterationsPerSample,
					},
					criterion,
				),
			);
		}
		const scores = runs.map((r) => r.score);
		const med = median(scores);
		const medianRun = runs.find((r) => r.score === med) ?? runs[0];
		criteria.push({
			criterion: criterion.key,
			samples: runs,
			median: med,
			justification: medianRun?.justification ?? "",
		});
	}
	return { judgeModel: opts.model, criteria };
}

/**
 * Code-quality judge (task 6.5): pinned non-worker model, temperature 0,
 * tool access, 3 independent samples per criterion, median taken
 * (grading-rubric spec). Operates only on the scrubbed blind workspace.
 */
export async function judgeQuality(opts: JudgeOptions): Promise<QualityResult> {
	const preScored: JudgedCriterion[] = (opts.preScored ?? []).map((c) => ({
		criterion: c.criterion,
		samples: c.samples.map((score) => ({
			score,
			justification: c.justification,
		})),
		median: c.score,
		justification: c.justification,
	}));
	const run = await judgeCriteria({
		...opts,
		criteria: CRITERIA,
		system: JUDGE_SYSTEM,
		preScored,
	});
	const done = new Set(preScored.map((c) => c.criterion));
	const criteria: CriterionScore[] = run.criteria.map((c) => ({
		criterion: c.criterion as QualityCriterion,
		samples: c.samples.map((s) => s.score),
		score: c.median,
		justification: c.justification,
	}));
	for (const c of criteria) if (!done.has(c.criterion)) opts.onCriterion?.(c);
	const mean = criteria.reduce((a, c) => a + c.score, 0) / criteria.length;
	return {
		judgeModel: run.judgeModel,
		criteria,
		score: Math.round(mean * 10 * 100) / 100, // 0-10 mean → 0-100
	};
}
