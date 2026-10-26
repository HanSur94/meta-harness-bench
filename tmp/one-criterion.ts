import { judgeCriteria } from "../src/grading/judge";
import { loadRegistry } from "../src/registry";
import { scrubWorkspace } from "../src/grading/scrub";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reg = loadRegistry("config/registry.yaml");
const cand = reg.candidates.find((c) => c.id === "egm")!;
const ws = "runs/run-2026-10-26T18-51-38-193Z/trials/egm-t1/workspace";
const blind = mkdtempSync(join(tmpdir(), "blind-"));
scrubWorkspace(ws, blind, reg.candidates);
const t0 = Date.now();
const r = await judgeCriteria({
	model: "kimi-k3.1-pro",
	blindWorkspaceDir: blind,
	markerPaths: cand.markerPaths ?? [],
	samples: 1,
	criteria: [{ key: "tests", prompt: "Do the tests cover the behaviour that matters?", samples: 1 } as never],
});
console.log("elapsed", Date.now() - t0, "ms");
console.log(JSON.stringify(r, null, 2).slice(0, 800));
