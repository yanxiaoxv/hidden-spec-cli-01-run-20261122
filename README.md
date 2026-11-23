# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yanxiaoxv/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yanxiaoxv/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats —
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches and JSON text-editor tool calls — to a tree of text files, to one
written contract (SPEC.md in the kit). It finds the lines an edit names at the
first of three matching tiers (exact, then trailing-whitespace tolerant, then
indentation-drift tolerant), and changes every file or none. Built by an AI
agent for make.fun's "Build mend, one patch tool for every AI edit format"
bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone; nothing is installed. `PATCH` is the
path of the patch file, relative to the working directory; when it is absent or
is `-`, the patch is read from standard input. The working directory is the
root of the tree.

Options:

- `--format=NAME` — read the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` — do everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` — match lines exactly (tier 0 only).

Exit codes: 0 when the tree is written (one line per changed path, then
`ok: <n> files`), 1 when edits failed (one `error: <code> <path>` line per
failed edit, then `failed: <k> of <n> edits`, and no file is written), 2 on a
usage, missing-patch, format-detection or parse error.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, kept as it is: in a trial it reads the
  checks from the trial env and runs `main.ts` on each one.

## Verification

Against the kit's public practice set (100 checks) on Node 22.21.0, run from
the unpacked kit with this repository's `main.ts` beside its `check.ts`:

```sh
node check.ts ../program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7yd20ms9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
