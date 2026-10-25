# Contributing

## Setup

```sh
bun install
bun run check   # tsc + biome
bun test        # ./tests
```

## Rules

1. One capability per PR.
2. Tests required for new logic.
3. Never pin a framework to `latest` — commit SHA or released version only.
4. Registry entries must pass `bun run cli.ts validate`.
5. Adding a harness/framework: read `docs/HARNESS-ONBOARDING.md` first.
6. Phase order for this fork: see `docs/designs/meta-harness-bench.md`, Detailed Implementation (hygiene → registry → grading → modes → site → pilot).
