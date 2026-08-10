// Publish the Claude Code session that is building this game.
//
// The prompts are, in a real sense, this project's source code: nobody typed
// any of the TypeScript. So they belong in the repo alongside it.
//
// Two artefacts, because one file cannot be both things:
//
//   docs/session/prompts.md   the conversation as prose — every human turn and
//                             every reply, in order. This is the readable one.
//   docs/session/session.jsonl  the full record with structure intact: every
//                             message, tool call and tool result, in the order
//                             it happened.
//
// **Why the raw file is not committed as-is.** It is 29MB and two thirds of that
// is a handful of enormous tool results — capture logs, whole-file reads, agent
// reports — none of which is a prompt. Committed hourly that is a repository
// growing by tens of megabytes a day to carry the same conversation. So long
// strings are truncated with a marker that says how much was cut. Prompts are
// never truncated: no human turn in this session comes close to the limit, and
// the limit is checked against them rather than assumed.
//
// Gzipping instead was the obvious alternative and is worse: compressed output
// changes wholesale on every append, so git can only store a new blob each time,
// while an append-only text file deltas almost perfectly.
//
//   node tools/session.mjs [--limit 2000]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/session');
const SRC =
  process.env.CLAUDE_SESSION_FILE ??
  '/root/.claude/projects/-home-user-mario-cone/e9fc5037-5a81-535b-8c48-d7c7034e82f9.jsonl';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const LIMIT = Number(opt('limit', 2000));

/** Anything that looks like a credential never reaches the repo. */
const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
const scrub = (s) => s.replace(SECRET, '[REDACTED]');

const raw = await readFile(SRC, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());

/** Recursively shorten long strings, leaving structure and short text alone. */
function trim(value) {
  if (typeof value === 'string') {
    const s = scrub(value);
    if (s.length <= LIMIT) return s;
    return `${s.slice(0, LIMIT)}\n…[truncated ${s.length - LIMIT} chars]`;
  }
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = trim(v);
    return out;
  }
  return value;
}

/**
 * A conversation record, with the prompt kept whole and only the machinery
 * around it trimmed.
 *
 * The first version of this ran `trim` over the entire record, which is wrong in
 * the one way that matters: a blanket limit cannot tell a 9,000-character
 * capture log from a 16,851-character prompt, and this session contains both. It
 * cut the prompt. The tool's own warning caught it, which is the only reason
 * this comment exists rather than a quietly mangled archive.
 *
 * So text blocks — what a person or the model actually said — are never
 * truncated at any length. Everything else in the message, meaning tool inputs
 * and tool results, still is.
 */
function trimMessage(record) {
  const out = { ...record };
  const msg = record.message;
  if (!msg) return trim(out);

  const content = msg.content;
  let kept;
  if (typeof content === 'string') {
    kept = scrub(content);
  } else if (Array.isArray(content)) {
    kept = content.map((b) => (b?.type === 'text' ? { ...b, text: scrub(b.text ?? '') } : trim(b)));
  } else {
    kept = trim(content);
  }

  // Trim the record's own metadata, then restore the untouched message.
  const shell = trim({ ...out, message: undefined });
  return { ...shell, message: { ...trim({ ...msg, content: undefined }), content: kept } };
}

/** Pull the plain text out of a message body of either shape. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const records = [];
const turns = [];
let longestPrompt = 0;

for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  // queue-operation is scheduler bookkeeping, not conversation.
  if (e.type === 'queue-operation') continue;
  records.push(e.type === 'user' || e.type === 'assistant' ? trimMessage(e) : trim(e));

  const when = e.timestamp ? e.timestamp.replace('T', ' ').slice(0, 16) : '';

  if (e.type === 'user') {
    const c = e.message?.content;
    const isToolResult = Array.isArray(c) && c.some((b) => b.type === 'tool_result');
    if (isToolResult) continue;
    const t = textOf(c).trim();
    if (!t) continue;
    longestPrompt = Math.max(longestPrompt, t.length);
    turns.push({ role: 'user', when, text: t });
  } else if (e.type === 'assistant') {
    const t = textOf(e.message?.content).trim();
    if (!t) continue;
    turns.push({ role: 'assistant', when, text: t });
  }
}

await mkdir(OUT, { recursive: true });

// ── the raw record ──────────────────────────────────────────────────────────
await writeFile(
  path.join(OUT, 'session.jsonl'),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n',
);

// ── the readable one ────────────────────────────────────────────────────────
const md = [];
md.push('# The session that built this game');
md.push('');
md.push('Every prompt and reply, in order. Nobody hand-wrote the TypeScript in');
md.push('this repository — it was built by agents working from these turns, so');
md.push('this file is closer to the source than `src/` is.');
md.push('');
md.push('Regenerated by `node tools/session.mjs`. Tool calls and their output are');
md.push('not here — they are in `session.jsonl` beside this file, with long');
md.push('results truncated. Many of the messages below are the build loop waking');
md.push('itself on a schedule rather than a person typing.');
md.push('');
md.push('---');
md.push('');

for (const t of turns) {
  md.push(`### ${t.role === 'user' ? '🧑 Prompt' : '🤖 Claude'}${t.when ? ` — ${t.when} UTC` : ''}`);
  md.push('');
  md.push(scrub(t.text));
  md.push('');
}

await writeFile(path.join(OUT, 'prompts.md'), md.join('\n'));

const size = (p) => readFile(path.join(OUT, p)).then((b) => (b.length / 1048576).toFixed(1));
console.log(`  prompts.md     ${await size('prompts.md')} MB  (${turns.length} turns)`);
console.log(`  session.jsonl  ${await size('session.jsonl')} MB  (${records.length} records)`);
console.log(`  longest single prompt: ${longestPrompt} chars, kept whole`);

// The claim above is checked rather than asserted: find the longest prompt in
// the *output* and confirm nothing truncated it on the way through.
const cut = records.some((r) => {
  if (r.type !== 'user' && r.type !== 'assistant') return false;
  const c = r.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  return blocks.some((b) => b?.type === 'text' && /…\[truncated \d+ chars\]$/.test(b.text ?? ''));
});
if (cut) {
  console.error('  FAIL: a message body was truncated. Prompts must survive whole.');
  process.exitCode = 1;
}
