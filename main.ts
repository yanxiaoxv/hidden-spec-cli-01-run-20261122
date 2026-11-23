// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a tree
// of text files, as SPEC.md (version 1) in the kit specifies. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// How it is built: the command line, output and exit codes, safe paths, format
// detection, JSON edits and the all-or-nothing write follow SPEC.md sections 1
// to 4, 9 and 10; line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8)
// are implemented here. In a trial the grader runs `node /bot/main.ts` with
// MAKEFUN_ENV_URL set, and this file hands over to runner.ts (the last lines
// below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines under SPEC.md section 3: its break, its lines, whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every position where O occurs in lines at a tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAtEOF: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (endAtEOF && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier with an occurrence, and the occurrence nearest to `near` (ties: earlier). */
function locateNearest(lines: string[], o: string[], strict: boolean, near: number, path: string): { pos: number; tier: number } {
  for (const t of tiers(strict)) {
    const ps = occurrences(lines, o, t, 0, false);
    if (ps.length > 0) {
      let best = ps[0]!;
      for (const p of ps) {
        if (Math.abs(p - near) < Math.abs(best - near)) best = p;
      }
      return { pos: best, tier: t };
    }
  }
  throw new Fail('no-match', path);
}

/** First tier with an occurrence, and its first occurrence at or after `from`. */
function locateFirst(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  endAtEOF: boolean,
  path: string,
): { pos: number; tier: number } {
  for (const t of tiers(strict)) {
    const ps = occurrences(lines, o, t, from, endAtEOF);
    if (ps.length > 0) return { pos: ps[0]!, tier: t };
  }
  throw new Fail('no-match', path);
}

/** First tier with an occurrence; exactly one occurrence there, else ambiguous. */
function locateUnique(lines: string[], o: string[], strict: boolean, path: string): { pos: number; tier: number } {
  for (const t of tiers(strict)) {
    const ps = occurrences(lines, o, t, 0, false);
    if (ps.length === 1) return { pos: ps[0]!, tier: t };
    if (ps.length > 1) throw new Fail('ambiguous', path);
  }
  throw new Fail('no-match', path);
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines N becomes when it replaces O matched at `at`: a context line is
 * written as the file's own matched line, never the patch's; at tier 2 every
 * other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's (SPEC.md section 5).
 */
function buildNew(n: NLine[], fileLines: string[], at: number, tier: number, o: string[]): string[] {
  const f = leadST(fileLines[at] ?? '');
  const p = o.length > 0 ? leadST(o[0]!) : '';
  return n.map((item) => {
    if (item.ctx >= 0) return fileLines[at + item.ctx]!;
    if (tier === 2 && o.length > 0) {
      const t = item.text;
      if (t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return item.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

/** One body line of a hunk: `blank` marks a patch line that was empty. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noNL: boolean;
  blank: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string, n: number): { old: string; next: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return { old: m[1]!, next: m[2]! };
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function parseHeaderPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed; `/dev/null` means no file. */
function toPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function finishHunk(a: number, body: BodyLine[]): Hunk {
  while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      n.push({ text: e.text, ctx: o.length });
      o.push(e.text);
    } else if (e.kind === '-') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: -1 });
    }
  }
  let noNL = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const e = body[k]!;
    if (e.kind === ' ' || e.kind === '+') {
      noNL = e.noNL;
      break;
    }
  }
  return { a, body, o, n, noNL };
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  let j = i + 1;
  const body: BodyLine[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith(' ')) {
      body.push({ kind: ' ', text: l.slice(1), noNL: false, blank: false });
      j++;
      continue;
    }
    if (l.startsWith('-')) {
      body.push({ kind: '-', text: l.slice(1), noNL: false, blank: false });
      j++;
      continue;
    }
    if (l.startsWith('+')) {
      body.push({ kind: '+', text: l.slice(1), noNL: false, blank: false });
      j++;
      continue;
    }
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.noNL = true;
      j++;
      continue;
    }
    if (l === '') {
      body.push({ kind: ' ', text: '', noNL: false, blank: true });
      j++;
      continue;
    }
    break;
  }
  return { hunk: finishHunk(a, body), next: j };
}

function parseUniSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null): { section: UniSection; next: number } {
  let i = start;
  let oldP: string | null | undefined;
  let newP: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let newFile = false;
  let deletedFile = false;
  let seenPair = false;
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (seenPair) break;
        oldP = toPath(parseHeaderPath(l));
        newP = toPath(parseHeaderPath(lines[i + 1]!));
        seenPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length);
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length);
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      newFile = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const h = parseHunk(lines, i);
      hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  const oldPath = oldP !== undefined ? oldP : renameFrom !== undefined ? renameFrom : gitOld;
  const newPath = newP !== undefined ? newP : renameTo !== undefined ? renameTo : gitNew;
  return { section: { oldPath: oldPath ?? null, newPath: newPath ?? null, newFile, deletedFile, hunks }, next: i };
}

/** The hunks of a section, in order, each on the result of the ones before it. */
function applyUniHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = st;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const { pos, tier } = locateNearest(cur.lines, h.o, strict, h.a - 1 + d, path);
      const newLines = buildNew(h.n, cur.lines, pos, tier, h.o);
      const fin = pos + h.o.length === cur.lines.length ? !h.noNL : cur.final;
      cur = { lines: [...cur.lines.slice(0, pos), ...newLines, ...cur.lines.slice(pos + h.o.length)], br: cur.br, final: fin };
    } else {
      const at = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const newLines = h.n.map((x) => x.text);
      const fin = at === cur.lines.length ? !h.noNL : cur.final;
      cur = { lines: [...cur.lines.slice(0, at), ...newLines, ...cur.lines.slice(at)], br: cur.br, final: fin };
    }
    d += h.n.length - h.o.length;
  }
  return cur;
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (newP === null) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP === null || sec.newFile) {
      const p = newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: { text: string; noNL: boolean }[] = [];
      for (const h of sec.hunks) for (const e of h.body) if (e.kind === '+') plus.push({ text: e.text, noNL: e.noNL });
      const content = plus.length === 0 ? '' : plus.map((x) => x.text).join('\n') + (plus[plus.length - 1]!.noNL ? '' : '\n');
      tree.now.set(p, content);
      return;
    }
    if (sec.deletedFile) {
      const p = oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const done = applyUniHunks(splitFile(text), sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(done));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const done = applyUniHunks(splitFile(text), sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(done));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = parseDiffGit(l, i + 1);
      const sec = parseUniSection(lines, i + 1, g.old, g.next);
      sections.push(sec.section);
      i = sec.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = parseUniSection(lines, i, null, null);
      sections.push(sec.section);
      i = sec.next;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let lastEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const old = lines.slice(s + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = s - 1; j >= lastEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, old, nw });
    prevPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const st = splitFile(text);
    const { pos, tier } = locateUnique(st.lines, b.old, strict, p);
    const n: NLine[] = b.nw.map((t) => ({ text: t, ctx: -1 }));
    const newLines = buildNew(n, st.lines, pos, tier, b.old);
    const out: FileState = {
      lines: [...st.lines.slice(0, pos), ...newLines, ...st.lines.slice(pos + b.old.length)],
      br: st.br,
      final: st.final,
    };
    tree.now.set(p, joinFile(out));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface VBodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  blank: boolean;
}

function finishVChunk(anchor: string | null, body: VBodyLine[], eof: boolean): VChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      n.push({ text: e.text, ctx: o.length });
      o.push(e.text);
    } else if (e.kind === '-') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: -1 });
    }
  }
  return { anchor, o, n, eof };
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let cur = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = locateFirst(cur.lines, [ch.anchor], strict, cursor, false, p);
        cursor = found.pos + 1;
      }
      if (ch.o.length > 0) {
        const { pos, tier } = locateFirst(cur.lines, ch.o, strict, cursor, ch.eof, p);
        const newLines = buildNew(ch.n, cur.lines, pos, tier, ch.o);
        cur = { lines: [...cur.lines.slice(0, pos), ...newLines, ...cur.lines.slice(pos + ch.o.length)], br: cur.br, final: cur.final };
        cursor = pos + newLines.length;
      } else {
        const at = ch.eof ? cur.lines.length : cursor;
        const newLines = ch.n.map((x) => x.text);
        cur = { lines: [...cur.lines.slice(0, at), ...newLines, ...cur.lines.slice(at)], br: cur.br, final: cur.final };
        cursor = at + newLines.length;
      }
    }
    const out = joinFile(cur);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: { text: string; blank: boolean }[] = [];
      while (i < last && !isStart(lines[i]!) && lines[i] !== '*** End Patch') {
        const cl = lines[i]!;
        if (cl.startsWith('+')) raw.push({ text: cl.slice(1), blank: false });
        else if (cl === '') raw.push({ text: '', blank: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.blank) raw.pop();
      edits.push(v4aAddEdit(p, raw.map((r) => r.text)));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    const p = l.slice('*** Update File: '.length).trim();
    const updateLine = i + 1;
    i++;
    while (i < last && blank(lines[i]!)) i++;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: VChunk[] = [];
    let cur: { anchor: string | null; body: VBodyLine[]; eof: boolean } | null = null;
    let seenChunk = false;
    while (i < last) {
      const cl = lines[i]!;
      if (isStart(cl) || cl === '*** End Patch') break;
      if (blank(cl)) {
        if (cur !== null) cur.body.push({ kind: ' ', text: '', blank: true });
        i++;
        continue;
      }
      if (cl.startsWith('@@')) {
        if (cur !== null) {
          chunks.push(finishVChunk(cur.anchor, cur.body, cur.eof));
          cur = null;
        }
        const anchor = cl.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        seenChunk = true;
        i++;
        continue;
      }
      if (cl === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        chunks.push(finishVChunk(cur.anchor, cur.body, cur.eof));
        cur = null;
        i++;
        continue;
      }
      if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
        if (cur === null) {
          if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, body: [], eof: false };
          seenChunk = true;
        }
        cur.body.push({ kind: cl[0] as ' ' | '-' | '+', text: cl.slice(1), blank: false });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur !== null) {
      while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.blank) cur.body.pop();
      chunks.push(finishVChunk(cur.anchor, cur.body, cur.eof));
      cur = null;
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()]
    .filter((p) => tree.original(p) !== tree.now.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rowText = new Map<string, string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowText.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [old, nw] of tree.moves) {
    const d = rowText.get(old);
    const a = rowText.get(nw);
    if (d !== undefined && d.startsWith('D ') && a !== undefined && a.startsWith('A ')) {
      rowText.delete(old);
      rowText.delete(nw);
      rowText.set(nw, `R ${old} -> ${nw}`);
    }
  }
  const rows = [...rowText.entries()]
    .sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
    .map(([, t]) => t);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
