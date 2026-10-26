import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
	SpecCriterion,
	SpecCriterionScore,
	SpecScore,
} from "../types";
import { SpecScore as SpecScoreSchema } from "../types";
import { type JudgeCriterion, judgeCriteria } from "./judge";

/**
 * Spec-quality judge — the third grading instrument (design item 12).
 *
 * Reads the RAW markerPaths artifacts (never the scrubbed blind copy the code
 * judge sees), scores five rubric criteria with anchors, takes the median of 3
 * samples per criterion, and averages the medians. Higher is better on every
 * criterion; ambiguity is penalized through the clarity criterion.
 */

export const SPEC_JUDGE_SYSTEM = `You are a senior architect reviewing a framework's design and specification artifacts for a software build task. The artifacts are concatenated at SPEC.md in this directory; each section is headed by its original relative path.

Score ONE rubric criterion from 0-10. Anchors: 0 = the criterion is absent; 10 = fully satisfied. Intermediate values by severity of the gaps. All criteria are higher-is-better. Judge only what the spec says — do not reward length, verbosity, or formatting. Do not assume intent that is not written down. NEVER modify the artifacts.

Score as an implementer who must build from this spec alone: a gap an implementer would have to guess about is a real gap.

When done, call record_score exactly once with {score: 0-10, justification: "<evidence-citing rationale, quoting the artifact>"}.`;

const ANCHOR = "0 = criterion absent, 10 = fully satisfied; intermediate values by severity of gaps.";

export const SPEC_CRITERIA: JudgeCriterion[] = [
	{
		key: "prdCoverage",
		prompt: `PRD coverage: every REQUIRED item of the target PRD is addressed by the spec. ${ANCHOR} Penalize missing requirements; do not reward OPTIONAL extras.`,
	},
	{
		key: "implementability",
		prompt: `Implementability: an implementer can code from this spec without making new design decisions. ${ANCHOR} Penalize open questions, "TBD" placeholders, and choices left to the implementer.`,
	},
	{
		key: "concreteness",
		prompt: `Concreteness: schemas, endpoints, file paths, and error cases are explicit rather than vague. ${ANCHOR} Reward named files, typed shapes, and stated failure behavior; penalize prose that could mean several things.`,
	},
	{
		key: "decisionCapture",
		prompt: `Decision capture: design choices and the reasons behind them are recorded. ${ANCHOR} Reward alternatives considered, trade-offs, and rationale; penalize unexplained choices.`,
	},
	{
		key: "clarity",
		prompt: `Clarity: no undefined terms and no ambiguous sentences. ${ANCHOR} Ambiguity, contradictions, and undefined jargon are penalized in proportion to how much they would mislead an implementer.`,
	},
];

/** Fixed sample budget: at most 600 tokens of artifact text per sample (≈4 chars/token). */
export const SPEC_SAMPLE_TOKEN_BUDGET = 600;
const CHARS_PER_TOKEN = 4;

/** Text-ish artifacts; binaries in markerPaths are not spec input. */
const TEXT_FILE =
	/\.(md|markdown|txt|ya?ml|json|jsonc|toml|rst|adoc|html?|csv|ts|tsx|js|jsx|py|go|rs|sh)$/i;

export interface SpecArtifacts {
	/** Concatenated artifact text, truncated to the sample budget. */
	text: string;
	/** Paths (relative to the workspace) that contributed. */
	files: string[];
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (TEXT_FILE.test(entry.name)) out.push(path);
	}
}

/**
 * Collect the raw spec artifacts at `markerPaths` (files or directories).
 * INVARIANT: callers pass the raw workspace, never `workspace-blind` — the
 * spec judge must see the framework's markers; scrubbing is for the code judge.
 */
export function collectSpecArtifacts(
	workspaceDir: string,
	markerPaths: string[],
): SpecArtifacts {
	const paths: string[] = [];
	for (const marker of markerPaths) {
		const target = join(workspaceDir, marker.replace(/\/$/, ""));
		if (!existsSync(target)) continue;
		if (statSync(target).isDirectory()) walk(target, paths);
		else paths.push(target);
	}
	paths.sort();
	const text = paths
		.map((path) => {
			let body = "";
			try {
				body = readFileSync(path, "utf8");
			} catch {
				// unreadable artifact: contributes nothing
			}
			return `--- ${relative(workspaceDir, path)} ---\n${body}`;
		})
		.join("\n\n")
		.slice(0, SPEC_SAMPLE_TOKEN_BUDGET * CHARS_PER_TOKEN);
	return { text, files: paths.map((path) => relative(workspaceDir, path)) };
}

/** Zero score with an explanatory note (zero artifacts, empty spec, judge off). */
export function zeroSpecScore(
	judgeModel: string,
	note: string,
): SpecScore {
	const criterionScores: SpecCriterionScore[] = SPEC_CRITERIA.map((c) => ({
		criterion: c.key as SpecCriterion,
		samples: [{ score: 0, justification: note }],
		median: 0,
	}));
	const criterionMedians = Object.fromEntries(
		SPEC_CRITERIA.map((c) => [c.key, 0]),
	) as Record<SpecCriterion, number>;
	return SpecScoreSchema.parse({
		judgeModel,
		criterionScores,
		criterionMedians,
		overall: 0,
		note,
	});
}

export interface SpecJudgeOptions {
	/** Judge model profile id — the pinned judgeModel, never the worker model. */
	model: string;
	/** RAW workspace (the trial's archived workspace, not the blind copy). */
	workspaceDir: string;
	/** Registry markerPaths for this candidate. */
	markerPaths: string[];
	samples?: number;
	/** Injectable transport for tests. */
	client?: Anthropic;
}

/**
 * Score the design/spec artifacts. Zero artifacts collected → overall 0 with a
 * note (the trial still completes; spec quality is simply not observable).
 */
export async function judgeSpec(opts: SpecJudgeOptions): Promise<SpecScore> {
	const artifacts = collectSpecArtifacts(opts.workspaceDir, opts.markerPaths);
	if (artifacts.files.length === 0) {
		return zeroSpecScore(
			opts.model,
			"no spec artifacts collected at markerPaths — spec quality not observable",
		);
	}
	if (!artifacts.text.trim()) {
		return zeroSpecScore(opts.model, "spec artifacts collected but empty");
	}

	// The judge sees ONLY the length-normalized spec: a temp dir holding the
	// truncated concatenation, so it cannot grade worker code as spec.
	const dir = mkdtempSync(join(tmpdir(), "he-spec-"));
	try {
		writeFileSync(join(dir, "SPEC.md"), artifacts.text);
		const run = await judgeCriteria({
			model: opts.model,
			blindWorkspaceDir: dir,
			criteria: SPEC_CRITERIA,
			system: SPEC_JUDGE_SYSTEM,
			samples: opts.samples ?? 3,
			client: opts.client,
		});
		const medians = run.criteria.map((c) => c.median);
		return SpecScoreSchema.parse({
			judgeModel: run.judgeModel,
			criterionScores: run.criteria.map((c) => ({
				criterion: c.criterion as SpecCriterion,
				samples: c.samples,
				median: c.median,
			})),
			criterionMedians: Object.fromEntries(
				run.criteria.map((c) => [c.criterion, c.median]),
			),
			overall:
				Math.round((medians.reduce((a, b) => a + b, 0) / medians.length) * 100) /
				100,
			note: null,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
