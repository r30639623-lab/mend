# mend: one patch tool for every AI edit format

mend applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and mend reads them all: a unified diff (often
with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. It finds the lines each edit names at the
first of three matching tiers — exact, trailing whitespace, then leading and
trailing whitespace with re-indentation — and writes every change or none
at all.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/r30639623-lab/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/r30639623-lab/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the [mend bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on make.fun. `SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Options and PATCH may come in any order. `--` ends the options.

## Output and exit codes

Exit 0: the tree is written. One line for each path whose state changed,
in byte order of the paths, then `ok: <n> files` (or `ok: 1 file`):

- `A <path>` a file that did not exist and now does;
- `D <path>` a file that existed and now does not;
- `M <path>` a file that existed and still does, with other bytes;
- `R <old> -> <new>` a file moved by a move edit that succeeded; it
  replaces that pair's `D` and `A` lines and sorts by `<new>`.

A file whose bytes after the patch are its bytes before it is not listed.
A patch that changes nothing prints only `ok: 0 files`.

Exit 1, nothing written: one line `error: <code> <path>` for each edit
that failed, in the patch's order, then `failed: <k> of <n> edits`. The
codes are `no-match`, `ambiguous`, `missing`, `exists` and `unsafe`.
Edits after a failed one still run, so every failure is reported, and
when any edit failed no file is written.

Exit 2, nothing written, exactly one line: `error: usage`,
`error: no-patch`, `error: format`, or `error: parse <N>` with the
1-based number of the patch line at fault. They are tried in that order:
a usage error wins over everything, and a parse error is reported before
any file is looked at.

## The four formats

- **Unified diffs** (SPEC.md section 6): sections, hunks, creation,
  deletion, moves and changes; hunks apply in order with the running
  offset `d`, each taking the occurrence nearest to `A - 1 + d` (ties to
  the earlier one); empty `O` inserts after the first `A + d` lines;
  `\ No newline at end of file` decides the final line break.
- **SEARCH/REPLACE blocks** (section 7): the path is the nearest
  non-blank, non-fence line before the block, falling back to the
  previous block's path; an empty old side creates the file; otherwise
  the old lines must occur at their tier exactly once.
- **V4A patches** (section 8): `Add File`, `Delete File` and `Update
  File` sections, `Move to`, chunks with anchors and a cursor,
  `*** End of File` anchoring a chunk to the end of the file.
- **JSON edits** (section 9): one JSON array of edit objects, or JSON
  Lines; `create` writes `file_text` byte for byte, `str_replace`
  replaces an exact single occurrence (CRLF-aware), `insert` inserts
  after a line number.

## Matching (section 5)

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines `O`
that are replaced by new lines `N`. `O` is found at the first of three
tiers at which it occurs at least once: tier 0, every line equal; tier 1,
every line equal once trailing spaces and tabs are removed from both;
tier 2, every line equal once leading and trailing spaces and tabs are
removed from both. A context line is written as the file's own matched
line, never the patch's. At tier 2 every other line of `N` is
re-indented: its leading whitespace `P` (from `O`'s first line) is
replaced by `F` (from the file's first matched line).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the
  env, runs `node main.ts` on each one in a fresh directory, and posts
  what it did.
- `check.ts`: the practice set on your own machine. The kit carries it
  at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score. This entry passes 100 of 100.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Safety

A path is safe when it is not empty, does not start with `/`, holds no
`\`, and none of its `/`-separated segments is empty, `.` or `..`.
Every path an edit names is checked for safety before anything else
about it. Directories are created as files need them. A changed file is
written back with its own line break (CRLF or LF) and its final line
break as it was, unless a unified hunk says otherwise; a file an edit
creates is written with LF breaks.
