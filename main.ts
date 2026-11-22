// mend: one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. The
// model may write it as a unified diff (often with wrong line numbers), as
// SEARCH/REPLACE blocks, as a V4A patch, or as JSON text-editor tool calls.
// mend reads the patch in whichever format it holds, finds the lines each
// edit names at the first of three matching tiers (exact, trailing
// whitespace, then leading and trailing whitespace with re-indentation),
// and writes every change or none at all.
//
// SPEC.md is the whole contract. Node 22, standard library only; run as:
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with exactly one stdout line. */
class Reject extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed; the tree is left exactly as it was for that edit. */
class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlySpacesTabs = (s: string): boolean => /^[ \t]*$/.test(s);
const leadingSpacesTabs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, and no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** One file's lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** The tree as the edits leave it: paths changed in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One line of the new text: either a context line (written from the file) or a fresh line. */
interface NewLine {
  text: string;
  context: boolean;
  /** Index into O of the matching context line, for context lines. */
  oIndex: number;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position at or after `from` where `old` occurs in `lines` at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `old` occurs at least once. */
function firstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/**
 * The lines that replace a match: context lines are the file's own matched
 * lines; at tier 2 every other non-blank line is re-indented, its leading
 * whitespace P (from O's first line) replaced by F (from the file's first
 * matched line); at tiers 0 and 1 fresh lines are written as they are.
 * With an empty O there is no matched line, so fresh lines are as they are.
 */
function buildNew(nl: NewLine[], old: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && old.length > 0) {
    const f = leadingSpacesTabs(fileLines[pos]!);
    const p = leadingSpacesTabs(old[0]!);
    for (const n of nl) {
      if (n.context) {
        out.push(fileLines[pos + n.oIndex]!);
        continue;
      }
      const t = n.text;
      if (t !== '' && !onlySpacesTabs(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
    return out;
  }
  for (const n of nl) out.push(n.context ? fileLines[pos + n.oIndex]! : n.text);
  return out;
}

/** A file with `old` lines at `pos` replaced by `built`, keeping its line break and final break. */
function spliceLines(st: FileState, pos: number, oldLen: number, built: string[]): FileState {
  return {
    lines: [...st.lines.slice(0, pos), ...built, ...st.lines.slice(pos + oldLen)],
    br: st.br,
    finalBreak: st.finalBreak,
  };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
    if (!isSafe(p)) throw new EditError('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditError('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditError('unsafe', p);
      if (tree.get(p) !== null) throw new EditError('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', p);
      if (count > 1) throw new EditError('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const st = readState(before);
      if (line < 0 || line > st.lines.length) throw new EditError('no-match', p);
      const lines = [...st.lines.slice(0, line), ...add, ...st.lines.slice(line)];
      tree.now.set(p, writeState({ lines, br: st.br, finalBreak: st.finalBreak }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Reject('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Reject(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Reject(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Reject(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Reject(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  /** Old start line A (1-based, as written). */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines: context and `+` lines, in body order. */
  n: NewLine[];
  /** A `\` line follows this hunk's last context or `+` line. */
  ctxNoEol: boolean;
  /** A `\` line follows this hunk's last `+` line. */
  plusNoEol: boolean;
}

interface RawSection {
  /** undefined: not named; null: named /dev/null (no file); string: the path. */
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renFrom: string | null | undefined;
  renTo: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path; `/dev/null` becomes null (no file). */
function cleanPath(raw: string | null): string | null {
  if (raw === null) return null;
  const p = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
  return p === '/dev/null' ? null : p;
}

/** A path named bare (rename lines, `diff --git` paths): `/dev/null` is no file, no prefix is removed. */
function barePath(raw: string): string | null {
  return raw === '/dev/null' ? null : raw;
}

/** The first of the three sources that named a path, in SPEC.md's order: `---`/`+++`, rename, `diff --git`. */
function pickPath(a: string | null | undefined, b: string | null | undefined, c: string | null | undefined): string | null {
  if (a !== undefined) return a;
  if (b !== undefined) return b;
  if (c !== undefined) return c;
  return null;
}

function parseHunkBody(lines: string[], head: number): { hunk: Hunk; next: number } {
  const n = lines.length;
  const body: string[] = [];
  let j = head + 1;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const nl: NewLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      nl.push({ text: t, context: true, oIndex: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l === '') {
      o.push('');
      nl.push({ text: '', context: true, oIndex: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      nl.push({ text: l.slice(1), context: false, oIndex: -1 });
      lastCtxOrPlus = k;
      lastPlus = k;
    }
  }
  const follows = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  const m = HUNK_HEAD.exec(lines[head]!);
  return {
    hunk: { a: Number(m![1]), o, n: nl, ctxNoEol: follows(lastCtxOrPlus), plusNoEol: follows(lastPlus) },
    next: j,
  };
}

function parseUnified(lines: string[]): RawSection[] {
  const n = lines.length;
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  const start = (gitOld: string | null | undefined, gitNew: string | null | undefined): void => {
    cur = { dashOld: undefined, dashNew: undefined, renFrom: undefined, renTo: undefined, gitOld, gitNew, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Reject(`error: parse ${i + 1}`);
      start(barePath(m[1]!), barePath(m[2]!));
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Reject(`error: parse ${i + 2}`);
        cur.dashOld = cleanPath(headerPath(line));
        cur.dashNew = cleanPath(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        start(undefined, undefined);
        cur!.dashOld = cleanPath(headerPath(line));
        cur!.dashNew = cleanPath(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader) cur.dashNew = cleanPath(headerPath(line));
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Reject(`error: parse ${i + 1}`);
      if (!HUNK_HEAD.test(line)) throw new Reject(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renFrom = barePath(line.slice('rename from '.length).trim());
      else if (line.startsWith('rename to ')) cur.renTo = barePath(line.slice('rename to '.length).trim());
      else if (/^new file mode( |$)/.test(line)) cur.isCreate = true;
      else if (/^deleted file mode( |$)/.test(line)) cur.isDelete = true;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdit(s: RawSection, strict: boolean): Edit {
  const oldP = pickPath(s.dashOld, s.renFrom, s.gitOld);
  const newP = pickPath(s.dashNew, s.renTo, s.gitNew);
  const create = s.isCreate || oldP === null;
  const del = !create && (s.isDelete || newP === null);
  const move = !create && !del && oldP !== null && newP !== null && oldP !== newP;
  const path = oldP ?? '';
  const dest = newP ?? '';

  if (create) {
    return (tree) => {
      if (!isSafe(dest)) throw new EditError('unsafe', dest);
      if (tree.get(dest) !== null) throw new EditError('exists', dest);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (const x of h.n) {
          if (x.context) continue;
          plus.push(x.text);
        }
      }
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.n.some((x) => !x.context)) {
          noEol = h.plusNoEol;
          break;
        }
      }
      tree.now.set(dest, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (del) {
    return (tree) => {
      if (!isSafe(path)) throw new EditError('unsafe', path);
      if (tree.get(path) === null) throw new EditError('missing', path);
      tree.now.set(path, null);
    };
  }
  return (tree, moves) => {
    if (!isSafe(path)) throw new EditError('unsafe', path);
    if (move && !isSafe(dest)) throw new EditError('unsafe', dest);
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    if (move && tree.get(dest) !== null) throw new EditError('exists', dest);
    let st = readState(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), st.lines.length);
        const built = h.n.map((x) => x.text);
        const finalBreak = at === st.lines.length ? !h.ctxNoEol : st.finalBreak;
        st = { lines: [...st.lines.slice(0, at), ...built, ...st.lines.slice(at)], br: st.br, finalBreak };
        d += h.n.length;
        continue;
      }
      const found = firstTier(st.lines, h.o, strict);
      if (found === null) throw new EditError('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          pos = p;
          best = dist;
        }
      }
      const built = buildNew(h.n, h.o, st.lines, pos, found.tier);
      const finalBreak = pos + h.o.length === st.lines.length ? !h.ctxNoEol : st.finalBreak;
      st = spliceLines({ ...st, finalBreak }, pos, h.o.length, built);
      d += h.n.length - h.o.length;
    }
    const out = writeState(st);
    if (move) {
      tree.now.set(path, null);
      tree.now.set(dest, out);
      moves.push([path, dest]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplace; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Reject(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = searchLine + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Reject(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Reject(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Reject('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!isSafe(path)) throw new EditError('unsafe', path);
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!isSafe(path)) throw new EditError('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    const st = readState(before);
    const found = firstTier(st.lines, oldLines, strict);
    if (found === null) throw new EditError('no-match', path);
    if (found.at.length > 1) throw new EditError('ambiguous', path);
    const pos = found.at[0]!;
    const nl: NewLine[] = newLines.map((t) => ({ text: t, context: false, oIndex: -1 }));
    const built = buildNew(nl, oldLines, st.lines, pos, found.tier);
    tree.now.set(path, writeState(spliceLines(st, pos, oldLines.length, built)));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

interface SectionLine {
  text: string;
  no: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Reject('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Reject(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Reject(`error: parse ${n + 1}`);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  /** A section's raw lines (with their 1-based numbers), trailing blank lines stripped. */
  const collect = (from: number): { raw: SectionLine[]; next: number } => {
    const raw: SectionLine[] = [];
    let j = from;
    while (j < last) {
      const l = lines[j]!;
      if (isSectionStart(l)) break;
      raw.push({ text: l, no: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    return { raw, next: j };
  };

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { raw, next } = collect(i + 1);
      const fileLines: string[] = [];
      for (const sl of raw) {
        if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else if (sl.text === '') fileLines.push('');
        else throw new Reject(`error: parse ${sl.no}`);
      }
      edits.push((tree) => {
        if (!isSafe(path)) throw new EditError('unsafe', path);
        if (tree.get(path) !== null) throw new EditError('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { raw, next } = collect(i + 1);
      if (raw.length > 0) throw new Reject(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!isSafe(path)) throw new EditError('unsafe', path);
        if (tree.get(path) === null) throw new EditError('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const headerNo = i + 1;
      const { raw, next } = collect(i + 1);
      edits.push(updateEdit(path, raw, headerNo, strict));
      i = next;
      continue;
    }
    throw new Reject(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Reject('error: parse 1');
  return edits;
}

function updateEdit(path: string, raw: SectionLine[], headerNo: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let started = false;
  const open = (anchor: string | null): void => {
    cur = { anchor, eof: false, o: [], n: [] };
    chunks.push(cur);
    started = true;
  };
  while (idx < raw.length) {
    const sl = raw[idx]!;
    const text = sl.text;
    if (text.startsWith('@@')) {
      open(text.slice(2).trim() === '' ? null : text.slice(2).trim());
      idx += 1;
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (cur === null) throw new Reject(`error: parse ${sl.no}`);
      cur.eof = true;
      cur = null;
      idx += 1;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (started) throw new Reject(`error: parse ${sl.no}`);
        open(null);
      }
      const c = cur!;
      if (text.startsWith(' ')) {
        const t = text.slice(1);
        c.o.push(t);
        c.n.push({ text: t, context: true, oIndex: c.o.length - 1 });
      } else if (text.startsWith('-')) {
        c.o.push(text.slice(1));
      } else if (text.startsWith('+')) {
        c.n.push({ text: text.slice(1), context: false, oIndex: -1 });
      } else {
        c.o.push('');
        c.n.push({ text: '', context: true, oIndex: c.o.length - 1 });
      }
      idx += 1;
      continue;
    }
    throw new Reject(`error: parse ${sl.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Reject(`error: parse ${headerNo}`);

  return (tree, moves) => {
    if (!isSafe(path)) throw new EditError('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditError('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditError('exists', moveTo);
    let st = readState(before);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        for (const t of tiers) {
          foundAt = null;
          for (let k = cursor; k < st.lines.length; k++) {
            if (lineEq(st.lines[k]!, ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new EditError('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        const built = ch.n.map((x) => x.text);
        st = { lines: [...st.lines.slice(0, at), ...built, ...st.lines.slice(at)], br: st.br, finalBreak: st.finalBreak };
        cursor = at + built.length;
        continue;
      }
      let pos: number | null = null;
      let tier = 0;
      for (const t of tiers) {
        const at = occurrences(st.lines, ch.o, t, cursor).filter((p) => !ch.eof || p + ch.o.length === st.lines.length);
        if (at.length > 0) {
          pos = at[0]!;
          tier = t;
          break;
        }
      }
      if (pos === null) throw new EditError('no-match', path);
      const built = buildNew(ch.n, ch.o, st.lines, pos, tier);
      st = spliceLines(st, pos, ch.o.length, built);
      cursor = pos + built.length;
    }
    const out = writeState(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new Reject('error: parse 1');
      edits = sections.map((s) => unifiedEdit(s, strict));
    } else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Reject('error: parse 1');
  } catch (e) {
    if (e instanceof Reject) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: EditError[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const mlen = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      moves.length = mlen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const changed = new Map<string, string | null>();
  const aSet = new Set<string>();
  const dSet = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, now);
    if (was === null) aSet.add(p);
    if (now === null) dSet.add(p);
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of moves) {
    if (dSet.has(oldP) && aSet.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      dSet.delete(oldP);
      aSet.delete(newP);
    }
  }
  for (const p of changed.keys()) {
    const was = tree.original(p);
    const now = changed.get(p)!;
    if (was === null && aSet.has(p)) rows.push({ key: p, line: `A ${p}` });
    else if (now === null && dSet.has(p)) rows.push({ key: p, line: `D ${p}` });
    else if (was !== null && now !== null) rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed.keys()) {
      const now = changed.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
