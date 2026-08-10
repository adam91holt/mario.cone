// Explain the backtick-in-a-CSS-template-literal trap.
//
// Most of the UI here is a several-hundred-line `const CSS_X = ` … template
// literal written in the same prose-commented style as the rest of the project.
// A backtick inside one *closes* it. Because these comments quote identifiers in
// pairs, the literal reopens on the second backtick, the count stays even, the
// file looks balanced — and everything between them is parsed as TypeScript.
//
// **This tool does not detect the bug. `tsc` already does that perfectly.** What
// tsc does badly is explain it: you get two or three TS1005 "',' expected"
// errors pointing at a line of CSS that is obviously fine, which is about as
// misleading as a compiler message gets, and the actual cause is a comment
// somewhere above. It has cost this project two green builds and it is already
// golden rule 7 in ARCHITECTURE.md, so prose alone has been tried and has failed
// twice.
//
// A first attempt at this flagged every block comment containing a backtick in
// any file that also held a CSS literal. That found 96 "offences", of which
// almost all were ordinary JSDoc outside the literal, where a backtick is
// completely legal. A linter that cries wolf 90 times is worse than no linter,
// so this one says nothing at all unless the compiler is already unhappy.
//
//   node tools/lintcss.mjs     # silent and exit 0 unless tsc reports a syntax error

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

/** Syntax-level codes. A type error is a different problem with honest wording. */
const SYNTAX = new Set(['TS1005', 'TS1109', 'TS1128', 'TS1434', 'TS1136', 'TS1002']);

let out = '';
try {
  const r = await run('npx', ['tsc', '--noEmit'], { cwd: ROOT, maxBuffer: 1 << 24 });
  out = r.stdout;
} catch (err) {
  out = String(err.stdout ?? '');
}

const errors = [];
for (const line of out.split('\n')) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
  if (m && SYNTAX.has(m[4])) errors.push({ file: m[1], line: Number(m[2]), code: m[4], msg: m[5] });
}

if (!errors.length) {
  console.log('  no syntax errors — nothing to explain');
  process.exit(0);
}

// Group by file and explain each file once, from its earliest error.
const byFile = new Map();
for (const e of errors) {
  if (!byFile.has(e.file) || e.line < byFile.get(e.file).line) byFile.set(e.file, e);
}

let explained = 0;
for (const [file, first] of byFile) {
  const src = await readFile(path.join(ROOT, file), 'utf8').catch(() => null);
  if (src === null) continue;
  const lines = src.split('\n');

  // Walk back from the first syntax error for a block comment holding a backtick.
  let culprit = null;
  for (let i = Math.min(first.line - 1, lines.length - 1); i >= 0 && i > first.line - 400; i--) {
    if (!lines[i].includes('`')) continue;
    // Is this line inside a block comment? Scan back for /* with no */ between.
    let open = -1;
    for (let j = i; j >= 0 && j > i - 60; j--) {
      if (lines[j].includes('*/') && j < i) break;
      if (lines[j].includes('/*')) { open = j; break; }
    }
    if (open >= 0) { culprit = { line: i + 1, text: lines[i].trim(), comment: open + 1 }; break; }
  }

  console.log(`\n  ${file}:${first.line}  ${first.code}: ${first.msg}`);
  if (culprit) {
    explained++;
    console.log(`  └─ likely cause: backtick inside a block comment at line ${culprit.line}`);
    console.log(`     ${culprit.text.slice(0, 96)}`);
    console.log('     Inside a CSS template literal, quote with " not `. ARCHITECTURE.md rule 7.');
  } else {
    console.log('  └─ no backtick-in-comment found above it; this is an ordinary syntax error.');
  }
}

console.log(
  `\n  ${byFile.size} file(s) with syntax errors, ${explained} explained by the backtick trap.`,
);
process.exit(1);
