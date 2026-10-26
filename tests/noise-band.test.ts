import { describe, expect, test } from "bun:test";
import { noiseBand, rankGaps } from "../src/grading/scoring";
import type { CandidateScore, Dimension, DimensionStats } from "../src/types";

const zero: DimensionStats = { mean: 0, min: 0, max: 0, stddev: 0 };
const dims = (): Record<Dimension, number> => ({
	prdAdherence: 0,
	codeQuality: 0,
	specQuality: 0,
	speed: 0,
	tokenSpend: 0,
});

function score(
	candidate: string,
	composite: number,
	stddev: number,
	trialsCounted: number,
): CandidateScore {
	return {
		candidate,
		harness: "claude-code",
		model: "m",
		dimensions: dims(),
		stats: {
			prdAdherence: zero,
			codeQuality: zero,
			specQuality: zero,
			speed: zero,
			tokenSpend: zero,
		},
		composite,
		compositeStats: {
			mean: composite,
			min: composite - stddev,
			max: composite + stddev,
			stddev,
		},
		trialsCounted,
		rightCensored: false,
	};
}

describe("noise band (Definitions: pooled stddev, config floor, pairwise rule)", () => {
	test("pooled sample stddev across candidates (n-1)", () => {
		// A: population sd 2 over n=3 → sample var 6; B: sd 4 over n=3 → sample var 24.
		// pooled var = (6*2 + 24*2) / 4 = 15 → sqrt(15).
		const band = noiseBand([score("a", 80, 2, 3), score("b", 60, 4, 3)]);
		expect(band).toBeCloseTo(Math.sqrt(15), 6);
	});

	test("configured value is a floor, never a ceiling", () => {
		const scores = [score("a", 80, 2, 3), score("b", 60, 4, 3)];
		expect(noiseBand(scores, 5)).toBe(5); // floor above computed
		expect(noiseBand(scores, 1)).toBeCloseTo(Math.sqrt(15), 6); // floor below computed
		expect(noiseBand(scores, 0)).toBeCloseTo(Math.sqrt(15), 6); // 0 = no floor
	});

	test("candidates with <2 trials carry no variance; floor still applies", () => {
		const singletons = [score("a", 90, 0, 1), score("b", 70, 0, 1)];
		expect(noiseBand(singletons)).toBe(0);
		expect(noiseBand(singletons, 2)).toBe(2);
		expect(noiseBand([], 3)).toBe(3);
	});

	test("pairwise rule down the ranked order; gap == band is not significant", () => {
		const scores = [score("a", 90, 0, 3), score("b", 85, 0, 3), score("c", 60, 0, 3)];
		const gaps = rankGaps(scores, 5);
		expect(gaps).toEqual([
			{ a: "a", b: "b", gap: 5, significant: false }, // ≤ band → no significant difference
			{ a: "b", b: "c", gap: 25, significant: true },
		]);
	});

	test("single candidate has no adjacent pairs", () => {
		expect(rankGaps([score("a", 90, 1, 3)], 2)).toEqual([]);
	});
});
