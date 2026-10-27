import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CandidateEntry } from "../types";

/**
 * Produce a blind copy of a workspace for code-quality judging (task 6.4):
 * registered framework marker paths are removed so the judge cannot identify
 * which framework produced the artifact (grading-rubric spec: judge
 * independence). ALL registered markers across ALL candidates are scrubbed
 * from every workspace, so absence of a marker is not itself a signal.
 *
 * INVARIANT (no functional change): scrubbing applies to the CODE-judge copy
 * only. The spec-quality judge (spec-judge.ts) reads the RAW markerPaths
 * artifacts from the archived workspace — never this blind copy — because
 * framework identity is the spec instrument's subject, not a bias to remove.
 */
export function scrubWorkspace(
	workspaceDir: string,
	blindDir: string,
	allCandidates: CandidateEntry[],
): string[] {
	rmSync(blindDir, { recursive: true, force: true });
	// Skip installed dependencies and VCS history: the judge reads source, and
	// copying them made every judged trial cost dollars (2026-10-26 pilot).
	const SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__"]);
	cpSync(workspaceDir, blindDir, {
		recursive: true,
		filter: (src) => !SKIP.has(src.split("/").pop() ?? ""),
	});
	const removed: string[] = [];
	const markers = new Set<string>([
		...allCandidates.flatMap((c) => c.markerPaths),
		// Harness-level traces that could identify tooling, not just framework:
		".claude/",
		"CLAUDE.md",
		".planning/",
	]);
	for (const marker of markers) {
		const target = join(blindDir, marker.replace(/\/$/, ""));
		if (existsSync(target)) {
			rmSync(target, { recursive: true, force: true });
			removed.push(marker);
		}
	}
	return removed;
}
