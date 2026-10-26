import { afterAll, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DIM_LABELS, HELP } from "../src/dashboard/app";
import { loadRunIndex, targetForRun } from "../src/dashboard/data";
import { EVAL_CLASS_LABEL, EVAL_CLASS_HELP } from "../src/dashboard/app";
import { composite } from "../src/grading/scoring";
import { buildResults } from "../src/report/results";
import { RunConfig, RunResults } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "he-dash-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("dashboard run index (tasks 1.1/1.2)", () => {
	test("loads real combined run; unsupported schema gated; junk tolerated", () => {
		const runsDir = join(tmp, "runs");
		mkdirSync(join(runsDir, "run-bad"), { recursive: true });
		writeFileSync(
			join(runsDir, "run-bad", "results.json"),
			JSON.stringify({ schemaVersion: 99, runId: "run-bad" }),
		);
		mkdirSync(join(runsDir, "run-junk"), { recursive: true });
		writeFileSync(join(runsDir, "run-junk", "results.json"), "not json");
		// Committed synthetic fixture (not gitignored runs/), so this is portable
		// across fresh clones and CI.
		cpSync("tests/fixtures/combined-n1", join(runsDir, "combined-n1"), {
			recursive: true,
		});

		const index = loadRunIndex(runsDir);
		expect(index).toHaveLength(3);
		const bad = index.find((e) => e.runId === "run-bad");
		expect(bad?.supported).toBe(false);
		expect(bad?.error).toContain("unsupported schemaVersion 99");
		const junk = index.find((e) => e.runId === "run-junk");
		expect(junk?.supported).toBe(false);
		const good = index.find((e) => e.runId?.startsWith("combined"));
		expect(good?.supported).toBe(true);
		expect(good?.results?.scores.length).toBeGreaterThanOrEqual(3);
	});

	test("re-weighting parity: dashboard composite === CLI composite (task 1.1)", () => {
		const index = loadRunIndex("tests/fixtures");
		const real = index.find(
			(e) => e.supported && e.results && e.results.scores.length > 0,
		);
		if (!real?.results)
			throw new Error("no supported run found for parity test");
		for (const s of real.results.scores) {
			// Same shared module the CLI used to produce the stored composite.
			expect(composite(s.dimensions, real.results.weights)).toBe(s.composite);
		}
	});
});

describe("bench task naming (dashboard tasks 1 + 5)", () => {
	test("config.target defaults to symphony-daemon and accepts a target", () => {
		expect(RunConfig.parse({ candidates: ["x"] }).target).toBe(
			"symphony-daemon",
		);
		expect(
			RunConfig.parse({ candidates: ["x"], target: "kanban" }).target,
		).toBe("kanban");
	});

	test("legacy run without config.target still names its task", () => {
		const index = loadRunIndex("tests/fixtures");
		const run = index.find((e) => e.runId === "combined-n1");
		expect(run?.target).toBe("symphony-daemon");
		expect(run?.targetInfo?.name).toBe("symphony-daemon");
		expect(run?.targetInfo?.summary).toContain("daemon");
	});

	test("recorded target resolves to its manifest name + summary", () => {
		const runsDir = join(tmp, "target-runs");
		const raw = JSON.parse(
			readFileSync(
				join("tests/fixtures", "combined-n1", "results.json"),
				"utf8",
			),
		);
		raw.runId = "run-web-app";
		raw.config.target = "web-app";
		// No manifest matches this hash, so the recorded target decides.
		raw.prdSha256 = "0".repeat(64);
		mkdirSync(join(runsDir, "run-web-app"), { recursive: true });
		writeFileSync(
			join(runsDir, "run-web-app", "results.json"),
			JSON.stringify(raw),
		);

		const [entry] = loadRunIndex(runsDir);
		expect(entry?.target).toBe("web-app");
		expect(entry?.targetInfo?.name).toBe("web-app");
		expect(entry?.targetInfo?.summary).toContain("Barber-shop");
	});

	test("results.json keeps the bench task (config is serialized)", () => {
		const results = buildResults({
			runId: "run-x",
			config: RunConfig.parse({ candidates: ["a"], target: "kanban" }),
			prdSha256: "0".repeat(64),
			testPlanSha256: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
			trials: [],
		});
		const round = RunResults.parse(JSON.parse(JSON.stringify(results)));
		expect(round.config.target).toBe("kanban");
	});

	test("prdSha256 wins for runs written before the field existed", () => {
		const manifest = parse(
			readFileSync("targets/symphony-daemon/target.yaml", "utf8"),
		) as { prdSha256: string };
		const info = targetForRun("wrong-name", manifest.prdSha256);
		expect(info.name).toBe("symphony-daemon");
		expect(info.summary.length).toBeGreaterThan(0);
	});
});

describe("dashboard wording (STE labels + help)", () => {
	test("a run without results.json shows its live state (dead owner = interrupted)", () => {
		const dir = mkdtempSync(join(tmpdir(), "live-run-"));
		const run = join(dir, "run-test");
		mkdirSync(run, { recursive: true });
		const state = (pid: number) => ({
			runId: "run-test",
			kind: "live",
			status: "running",
			stage: "building egm-t1",
			candidates: ["egm", "gsd"],
			trials: {},
			costUsdSoFar: 0,
			startedAt: "2026-10-26T20:58:16.000Z",
			updatedAt: "2026-10-26T21:10:00.000Z",
			ownerPid: pid,
			error: null,
		});
		writeFileSync(
			join(run, "run-state.json"),
			JSON.stringify(state(process.pid)),
		);
		let entries = loadRunIndex(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.live?.status).toBe("running");
		expect(entries[0]?.live?.stage).toContain("egm");
		// Owner gone -> the dashboard must not claim it is still running.
		writeFileSync(
			join(run, "run-state.json"),
			JSON.stringify(state(999999)),
		);
		entries = loadRunIndex(dir);
		expect(entries[0]?.live?.status).toBe("interrupted");
		rmSync(dir, { recursive: true, force: true });
	});

	test("bench class flows from the manifest to the dashboard label", () => {
		const info = targetForRun("symphony-daemon", "0".repeat(64));
		expect(info.evalClass).toBe("hybrid");
		expect(EVAL_CLASS_LABEL[info.evalClass]).toMatch(/tests/);
		expect(EVAL_CLASS_HELP[info.evalClass]).toMatch(/tests/i);
	});

	test("every dimension has a plain label with matching help", () => {
		expect(Object.keys(DIM_LABELS)).toEqual([
			"prdAdherence",
			"codeQuality",
			"specQuality",
			"speed",
			"tokenSpend",
		]);
		expect(DIM_LABELS.prdAdherence).toBe("Meets the task spec");
		expect(DIM_LABELS.codeQuality).toBe("Code quality");
		expect(DIM_LABELS.specQuality).toBe("Design document quality");
		expect(DIM_LABELS.speed).toBe("Speed (same run)");
		expect(DIM_LABELS.tokenSpend).toBe("Cost (same run)");
		for (const label of Object.values(DIM_LABELS)) {
			expect(HELP[label]).toBeTruthy();
		}
		expect(HELP.Composite).toBeTruthy();
		expect(HELP["Bench task"]).toBeTruthy();
	});

	test("help states the range, the direction, and a limitation", () => {
		for (const label of ["Composite", ...Object.values(DIM_LABELS)]) {
			const text = HELP[label] ?? "";
			expect(text).toContain("0 to 100");
			expect(text).toContain("A higher value is better");
			expect(text).toContain("Limitation:");
		}
	});
});
