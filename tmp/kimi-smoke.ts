import { judgeSpec } from "../src/grading/spec-judge";
import { loadRegistry } from "../src/registry";

const reg = loadRegistry("config/registry.yaml");
const cand = reg.candidates.find((c) => c.id === "egm");
if (!cand) throw new Error("no egm candidate");
const score = await judgeSpec({
	model: "kimi-k3.1-pro",
	workspaceDir:
		"runs/run-2026-10-26T18-51-38-193Z/trials/egm-t1/workspace",
	markerPaths: cand.markerPaths ?? [],
	samples: 1,
});
console.log(JSON.stringify(score, null, 2));
