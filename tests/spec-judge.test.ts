import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { parse } from "yaml";
import { judgeQuality } from "../src/grading/judge";
import { scrubWorkspace } from "../src/grading/scrub";
import {
	SPEC_CRITERIA,
	SPEC_SAMPLE_TOKEN_BUDGET,
	collectSpecArtifacts,
	judgeSpec,
} from "../src/grading/spec-judge";
import type { CandidateEntry } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "he-specjudge-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Workspace with a marker-path spec artifact, as a framework leaves it. */
function workspace(name: string, spec = "# Design\nFRAMEWORK-MARKER spec content."): string {
	const dir = join(tmp, name);
	mkdirSync(join(dir, "docs", "designs"), { recursive: true });
	writeFileSync(join(dir, "docs", "designs", "feature.md"), spec);
	return dir;
}

/**
 * Fake Anthropic transport: cycles 2/6/10 per criterion so the median is 6 and
 * the mean-of-medians is 60. Optionally inspects the judge's SPEC.md.
 */
function mockClient(onJudge?: (dir: string) => void): Anthropic {
	let call = 0;
	const scores = [2, 6, 10];
	return {
		messages: {
			create: async (req: { messages: { content: string }[] }) => {
				const content = req.messages[0]?.content ?? "";
				const dir = /Workspace: (.+)$/m.exec(content)?.[1];
				if (dir && onJudge) onJudge(dir);
				const score = scores[call % scores.length] as number;
				call++;
				return {
					content: [
						{
							type: "tool_use",
							id: `call-${call}`,
							name: "record_score",
							input: { score, justification: `sample ${call}` },
						},
					],
				};
			},
		},
	} as unknown as Anthropic;
}

const judgeModel = "claude-sonnet-4-6";

describe("spec-quality judge (rubric math, scrub bypass, empty input, judge pin)", () => {
	test("median per criterion, overall = mean of the five medians", async () => {
		const spec = await judgeSpec({
			model: judgeModel,
			workspaceDir: workspace("rubric"),
			markerPaths: ["docs/designs/"],
			client: mockClient(),
		});
		expect(spec.criterionScores).toHaveLength(5);
		expect(spec.criterionScores.map((c) => c.criterion as string)).toEqual(
			SPEC_CRITERIA.map((c) => c.key),
		);
		for (const c of spec.criterionScores) {
			expect(c.samples.map((s) => s.score)).toEqual([2, 6, 10]);
			expect(c.median).toBe(6);
			expect(c.samples[0]?.justification).toContain("sample");
		}
		for (const median of Object.values(spec.criterionMedians)) {
			expect(median).toBe(6);
		}
		expect(spec.overall).toBe(6);
		expect(spec.note).toBeNull();
	});

	test("scrub-bypass invariant: raw markerPaths are the spec judge's input", async () => {
		const dir = workspace("bypass", "# Spec\nDO-NOT-SCRUB-ME");
		const entry = {
			id: "egm",
			name: "EGM",
			repo: "https://example.com/x",
			pinnedVersion: "abc",
			markerPaths: ["docs/designs/"],
			harnesses: {},
		} as unknown as CandidateEntry;
		const blind = join(tmp, "bypass-blind");
		const removed = scrubWorkspace(dir, blind, [entry]);
		expect(removed).toContain("docs/designs/");
		expect(existsSync(join(blind, "docs", "designs"))).toBe(false);

		// The judge reads the RAW workspace, so the marker survives.
		const raw = collectSpecArtifacts(dir, ["docs/designs/"]);
		expect(raw.files).toEqual([join("docs", "designs", "feature.md")]);
		expect(raw.text).toContain("DO-NOT-SCRUB-ME");

		let seen = "";
		await judgeSpec({
			model: judgeModel,
			workspaceDir: dir,
			markerPaths: ["docs/designs/"],
			client: mockClient((specDir) => {
				seen = readFileSync(join(specDir, "SPEC.md"), "utf8");
			}),
		});
		expect(seen).toContain("DO-NOT-SCRUB-ME");
	});

	test("sample input is length-normalized to the fixed token budget", () => {
		const big = workspace("big", "x".repeat(50_000));
		const { text } = collectSpecArtifacts(big, ["docs/designs/"]);
		expect(text.length).toBeLessThanOrEqual(SPEC_SAMPLE_TOKEN_BUDGET * 4);
	});

	test("zero artifacts → overall 0 with a note, no judge call", async () => {
		const empty = join(tmp, "empty");
		mkdirSync(empty, { recursive: true });
		const throwing = {
			messages: {
				create: async () => {
					throw new Error("judge must not be called with no artifacts");
				},
			},
		} as unknown as Anthropic;
		const spec = await judgeSpec({
			model: judgeModel,
			workspaceDir: empty,
			markerPaths: ["docs/designs/"],
			client: throwing,
		});
		expect(spec.overall).toBe(0);
		expect(spec.note).toContain("no spec artifacts");
		expect(spec.criterionMedians.prdCoverage).toBe(0);
	});

	test("judge model is the pinned judgeModel profile, never the worker", async () => {
		const defaults = parse(readFileSync("config/run.defaults.yaml", "utf8")) as {
			model: string;
			judgeModel: string;
		};
		expect(defaults.judgeModel).not.toBe(defaults.model);
		const spec = await judgeSpec({
			model: defaults.judgeModel,
			workspaceDir: workspace("pin"),
			markerPaths: ["docs/designs/"],
			client: mockClient(),
		});
		expect(spec.judgeModel).toBe(defaults.judgeModel);
		expect(spec.judgeModel).not.toBe(defaults.model);
	});

	test("code-quality judge keeps its own rubric (parameterized, not cloned)", async () => {
		// The code judge still uses the QualityCriterion keys, not the spec rubric.
		const quality = await judgeQuality({
			model: judgeModel,
			blindWorkspaceDir: workspace("code"),
			client: mockClient(),
		});
		expect(quality.criteria.map((c) => c.criterion)).toEqual([
			"tests",
			"architecture",
			"errorHandling",
			"deadCode",
			"documentation",
		]);
		expect(quality.score).toBe(60);
	});
});
