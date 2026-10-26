import { useEffect, useState } from "react";
import { composite } from "../../grading/scoring";
import type { CandidateScore, ModelRef, Weights } from "../../types";

export interface RunSummary {
	runId: string;
	dir: string;
	supported: boolean;
	schemaVersion?: number;
	error?: string;
	/** Built-but-ungraded trials remain → can be resumed-graded without rebuild. */
	regradable?: boolean;
	summary?: {
		config: {
			harness: string;
			model: string;
			judgeModel: string;
			provider: string;
			trialsPerCandidate: number;
		};
		weights: Weights;
		scores: CandidateScore[];
		inconclusive: boolean;
		startedAt: string;
		prdSha256: string;
		/** Which app/PRD this run built (resolved by content hash), or null. */
		target?: { name: string; title: string } | null;
		testPlanSha256: string | null;
		workerModel?: ModelRef;
		judgeModelRef?: ModelRef;
		crossVendorJudge?: boolean;
		costSource?: string;
		/** Total run cost (sum of per-trial telemetry), or undefined if untracked. */
		costUsd?: number;
	};
}

export const DIM_LABELS: Record<keyof Weights, string> = {
	prdAdherence: "PRD adherence",
	codeQuality: "Code quality",
	specQuality: "Spec quality",
	speed: "Speed*",
	tokenSpend: "Token spend*",
};

export const DEFAULT_WEIGHTS: Weights = {
	prdAdherence: 0.35,
	codeQuality: 0.2,
	specQuality: 0.15,
	speed: 0.15,
	tokenSpend: 0.15,
};

export const HELP: Record<string, string> = {
	Composite:
		"Weighted sum of the five dimension scores using the weights in the panel above (defaults: PRD adherence 35%, code quality 20%, spec quality 15%, speed 15%, token spend 15%). Recomputed live when you move the sliders.",
	"PRD adherence":
		"Graded Score, 0–100 (ViBench methodology): an evaluator agent executes the frozen, spec-derived test plan against the BUILT artifact — running it against mock services and recording evidence per step. Weighted partial credit over non-bonus steps; fatal cold-start failures zero the remainder. Absolute scale, comparable across runs.",
	"Code quality":
		"Blind LLM-judge score, 0–100: five criteria (tests, architecture, error handling, dead code, documentation), each scored 0–10 three times by a pinned judge model (never the worker model) on a framework-marker-scrubbed copy; per-criterion medians averaged ×10. Absolute scale.",
	"Speed*":
		"Agent working time (sandbox setup and grading excluded), min-max normalized within THIS run's candidate set — fastest = 100, slowest = 0. Not comparable across runs.",
	"Token spend*":
		"Total cost across sessions (harness-reported USD; tokens when pricing is unavailable), min-max normalized within THIS run's candidate set — cheapest = 100, priciest = 0. Not comparable across runs.",
};

/** Tiny fetch hook (read-only review data). */
export function useFetch<T>(url: string): T | undefined {
	const [data, setData] = useState<T>();
	useEffect(() => {
		let live = true;
		fetch(url)
			.then((r) => r.json())
			.then((d) => live && setData(d as T))
			.catch(() => live && setData(undefined));
		return () => {
			live = false;
		};
	}, [url]);
	return data;
}

/** Recompute composites from stored per-dimension scores via the SAME shared
 *  module the CLI uses (re-weighting parity). */
export function reweight(
	scores: CandidateScore[],
	w: Weights,
): (CandidateScore & { rw: number })[] {
	return scores
		.map((s) => ({ ...s, rw: composite(s.dimensions, w) }))
		.sort((a, b) => b.rw - a.rw);
}
