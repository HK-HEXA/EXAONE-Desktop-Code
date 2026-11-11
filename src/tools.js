'use strict';
// 에이전트 모드용 도구: 작업 폴더 안에서 파일 읽기/쓰기/검색, 명령 실행, 웹 가져오기.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.idea', '.vs', '.next', '.cache']);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARS = 60000;
const MAX_OUTPUT_CHARS = 30000;

const fn = (name, category, description, properties, required) => ({
  category,
  def: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: required || [] } } },
});

const TOOLS = [
  fn('list_dir', 'read', 'List files and folders in a directory of the workspace.', {
    path: { type: 'string', description: 'Directory path relative to the workspace. Defaults to ".".' },
  }),
  fn('read_file', 'read', 'Read a text file from the workspace. Long files are returned in ranges; use offset/limit to read more.', {
    path: { type: 'string', description: 'File path relative to the workspace.' },
    offset: { type: 'integer', description: '1-based line number to start from. Default 1.' },
    limit: { type: 'integer', description: 'Maximum number of lines to return. Default 800.' },
  }, ['path']),
  fn('find_files', 'read', 'Find files in the workspace by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py".', {
    pattern: { type: 'string', description: 'Glob pattern.' },
  }, ['pattern']),
  fn('search_files', 'read', 'Search file contents in the workspace with a regular expression. Returns matching lines as path:line: text.', {
    pattern: { type: 'string', description: 'JavaScript regular expression.' },
    path: { type: 'string', description: 'Directory or file to search in. Defaults to the whole workspace.' },
    glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js".' },
    ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
  }, ['pattern']),
  fn('update_plan', 'read', 'Show or update a short step-by-step plan for the current task. Call it before multi-step work and whenever a step changes status.', {
    steps: {
      type: 'array',
      description: 'All steps of the plan, in order.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
        required: ['title', 'status'],
      },
    },
  }, ['steps']),
  fn('write_file', 'write', 'Create a new file or completely overwrite an existing file in the workspace. Parent folders are created automatically.', {
    path: { type: 'string', description: 'File path relative to the workspace.' },
    content: { type: 'string', description: 'Full file content.' },
  }, ['path', 'content']),
  fn('edit_file', 'write', 'Edit an existing file by replacing an exact string. old_string must match the file content exactly (including whitespace) and be unique unless replace_all is true.', {
    path: { type: 'string', description: 'File path relative to the workspace.' },
    old_string: { type: 'string', description: 'Exact text to replace.' },
    new_string: { type: 'string', description: 'Replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
  }, ['path', 'old_string', 'new_string']),
  fn('run_command', 'exec', 'Run a shell command in the workspace directory and return its combined stdout/stderr and exit code.', {
    command: { type: 'string', description: 'Command line to run.' },
    timeout_sec: { type: 'integer', description: 'Timeout in seconds. Default 120, maximum 600.' },
  }, ['command']),
  fn('web_fetch', 'net', 'Fetch a web page or text resource over HTTP(S) and return its text content.', {
    url: { type: 'string', description: 'Absolute http(s) URL.' },
  }, ['url']),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.def.function.name, t]));

function definitions() {
  return TOOLS.map((t) => ({ name: t.def.function.name, category: t.category, def: t.def }));
}

// ---------- 사용자에게 질문하기 (ask_user) ----------
// 실행은 화면 쪽(데스크톱 앱의 질문 카드, 터미널의 선택 상자)에서 하고, 여기에는 정의와 공통 처리만 둔다.
const ASK_USER_DEF = { type: 'function', function: {
  name: 'ask_user',
  description: 'Ask the user one to three multiple-choice questions and wait for the answers. Call it BEFORE starting work whenever you are not sure exactly what to build: the request is ambiguous or leaves out something that changes the result (what to make, scope, format, tech stack, which files), or the decision is genuinely the user\'s to make. Do not ask about things you can find out by reading files, and do not ask to confirm a request that is already clear. The user can always type their own answer instead of picking an option. Write the questions and options in the user\'s language.',
  parameters: { type: 'object', properties: {
    questions: { type: 'array', description: '1 to 3 questions. Ask everything you need in one call.', items: { type: 'object', properties: {
      question: { type: 'string', description: 'The full question, ending with a question mark.' },
      header: { type: 'string', description: 'Very short label for the question (a few words).' },
      options: { type: 'array', description: '2 to 4 concrete, mutually exclusive choices. Put the one you recommend first.', items: { type: 'object', properties: {
        label: { type: 'string', description: 'Short choice text.' },
        description: { type: 'string', description: 'What choosing it means.' },
      }, required: ['label'] } },
      multi_select: { type: 'boolean', description: 'true if several options can be chosen together.' },
    }, required: ['question', 'options'] } },
  }, required: ['questions'] },
} };
const ASK_USER_PROMPT = '- If you are not sure exactly what to build — the request is ambiguous or leaves out something that changes the result (what to make, scope, format, tech stack, which files) — call ask_user FIRST and start working only after you have the answers. Ask everything in one call: up to 3 questions, each with 2–4 concrete options, the one you recommend first. Never ask about things you can find out by reading the workspace, and do not ask to confirm a request that is already clear.';

/** 모델이 준 인자를 [{question, header, options: [{label, description}], multi}] 로 정리한다 (옛 형식 {question, options: [문자열]} 도 받는다). */
function askNormalize(args) {
  const a = args && typeof args === 'object' ? args : {};
  const list = Array.isArray(a.questions) ? a.questions : (a.question ? [a] : []);
  const out = [];
  for (const q of list.slice(0, 4)) {
    if (!q || typeof q !== 'object' || !String(q.question || '').trim()) continue;
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => (o && typeof o === 'object'
      ? { label: String(o.label || o.title || o.value || '').trim(), description: String(o.description || '').trim() }
      : { label: String(o == null ? '' : o).trim(), description: '' })).filter((o) => o.label);
    out.push({ question: String(q.question).trim(), header: String(q.header || '').trim(), options, multi: !!(q.multi_select || q.multiSelect) });
  }
  return out;
}
/** 답을 모델에게 돌려줄 글로 만든다. answers[i] 는 i 번째 질문의 답(문자열). */
function askFormat(questions, answers) {
  return 'The user answered:\n' + questions.map((q, i) => `- ${q.question} → ${String((answers || [])[i] || '').trim() || '(no answer)'}`).join('\n')
    + '\nProceed according to these answers.';
}
const askUser = { def: ASK_USER_DEF, prompt: ASK_USER_PROMPT, normalize: askNormalize, format: askFormat,
  skipped: 'The user skipped the questions without answering. Proceed with the most reasonable defaults and state the assumptions you made in your reply.' };

// ---------- 경로 ----------
function resolveIn(workspace, p) {
  if (!workspace) throw new Error('작업 폴더가 설정되지 않았습니다.');
  const root = path.resolve(workspace);
  const abs = path.resolve(root, String(p == null || p === '' ? '.' : p));
  const rel = path.relative(root, abs);
  if (rel === '') return abs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('작업 폴더 밖의 경로는 사용할 수 없습니다: ' + p);
  return abs;
}
const toRel = (workspace, abs) => path.relative(path.resolve(workspace), abs).split(path.sep).join('/') || '.';

// ---------- 텍스트 ----------
function decodeText(buf) {
  if (buf.subarray(0, 8192).includes(0)) throw new Error('바이너리 파일은 읽을 수 없습니다.');
  let text = buf.toString('utf8');
  const bad = (text.match(/�/g) || []).length;
  if (bad > 0 && bad > text.length / 200) {
    try { text = new TextDecoder('euc-kr').decode(buf); } catch { /* ICU 없음 */ }
  }
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function clip(s, max) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) + `\n\n… [${s.length - max}자 생략] …\n\n` + s.slice(s.length - tail);
}

function globToRegex(glob) {
  let g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) { re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'; i = end; } else re += '\\{';
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function* walk(root, start, budget) {
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(abs); }
      else if (e.isFile()) {
        if (budget.n-- <= 0) { budget.exceeded = true; return; }
        yield abs;
      }
    }
  }
}

// ---------- diff ----------
function lineDiff(aText, bText, ctx = 3, maxLines = 400) {
  const split = (t) => { if (t === '') return []; const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  const a = split(aText);
  const b = split(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  let ops = []; // [' '|'-'|'+', line]
  if (am.length * bm.length > 4e6) {
    ops = am.map((l) => ['-', l]).concat(bm.map((l) => ['+', l]));
  } else {
    const n = am.length, m = bm.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push([' ', am[i]]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(['-', am[i++]]);
      else ops.push(['+', bm[j++]]);
    }
    while (i < n) ops.push(['-', am[i++]]);
    while (j < m) ops.push(['+', bm[j++]]);
  }
  const all = a.slice(0, pre).map((l) => [' ', l]).concat(ops, a.slice(a.length - suf).map((l) => [' ', l]));
  let added = 0, removed = 0;
  for (const [t] of all) { if (t === '+') added++; else if (t === '-') removed++; }
  const keep = new Uint8Array(all.length);
  all.forEach(([t], idx) => {
    if (t === ' ') return;
    for (let k = Math.max(0, idx - ctx); k <= Math.min(all.length - 1, idx + ctx); k++) keep[k] = 1;
  });
  const out = [];
  let aNo = 1, bNo = 1, last = -2;
  for (let idx = 0; idx < all.length; idx++) {
    const [t, l] = all[idx];
    if (keep[idx]) {
      if (last !== idx - 1) out.push(`@@ -${aNo} +${bNo} @@`);
      out.push(t + l);
      last = idx;
    }
    if (t !== '+') aNo++;
    if (t !== '-') bNo++;
  }
  const truncated = out.length > maxLines;
  return { added, removed, text: (truncated ? out.slice(0, maxLines) : out).join('\n'), truncated };
}

// ---------- 도구 구현 ----------
async function listDir(ws, args) {
  const abs = resolveIn(ws, args.path);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const rows = [];
  for (const e of entries) {
    if (e.isDirectory()) rows.push({ dir: true, name: e.name });
    else {
      let size = 0;
      try { size = (await fsp.stat(path.join(abs, e.name))).size; } catch { /* 접근 불가 */ }
      rows.push({ dir: false, name: e.name, size });
    }
  }
  rows.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
  const shown = rows.slice(0, 500);
  const lines = shown.map((r) => r.dir ? `${r.name}/` : `${r.name}  (${fmtSize(r.size)})`);
  if (rows.length > shown.length) lines.push(`… 외 ${rows.length - shown.length}개`);
  return { ok: true, content: `${toRel(ws, abs)}/ — ${rows.length}개 항목\n` + (lines.join('\n') || '(비어 있음)'), meta: { count: rows.length } };
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function readFile(ws, args) {
  const abs = resolveIn(ws, args.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('폴더입니다. list_dir 를 사용하세요.');
  if (st.size > MAX_READ_BYTES) throw new Error(`파일이 너무 큽니다 (${fmtSize(st.size)}). search_files 로 필요한 부분을 찾으세요.`);
  const text = decodeText(await fsp.readFile(abs));
  const lines = text.split('\n');
  const offset = Math.max(1, parseInt(args.offset, 10) || 1);
  const limit = Math.max(1, parseInt(args.limit, 10) || 800);
  let slice = lines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join('\n');
  let end = offset - 1 + slice.length;
  if (body.length > MAX_READ_CHARS) {
    let acc = 0, k = 0;
    while (k < slice.length && acc + slice[k].length + 1 <= MAX_READ_CHARS) { acc += slice[k].length + 1; k++; }
    k = Math.max(1, k);
    slice = slice.slice(0, k);
    body = slice.join('\n').slice(0, MAX_READ_CHARS);
    end = offset - 1 + k;
  }
  const partial = offset > 1 || end < lines.length;
  const head = partial ? `[${toRel(ws, abs)} — ${offset}~${end}행 / 전체 ${lines.length}행. 이어서 읽으려면 offset=${end + 1}]\n` : '';
  return { ok: true, content: head + body, meta: { lines: lines.length, from: offset, to: end } };
}

async function findFiles(ws, args) {
  const root = resolveIn(ws, '.');
  const pattern = String(args.pattern || '');
  if (!pattern) throw new Error('pattern 이 필요합니다.');
  const re = globToRegex(pattern);
  const byName = !pattern.replace(/\\/g, '/').includes('/');
  const budget = { n: 20000 };
  const hits = [];
  for await (const abs of walk(root, root, budget)) {
    const rel = toRel(ws, abs);
    if (re.test(byName ? path.basename(abs) : rel)) { hits.push(rel); if (hits.length >= 300) break; }
  }
  const note = hits.length >= 300 ? '\n… (300개에서 중단)' : budget.exceeded ? '\n… (파일이 너무 많아 일부만 탐색)' : '';
  return { ok: true, content: hits.length ? hits.join('\n') + note : '일치하는 파일이 없습니다.', meta: { count: hits.length } };
}

async function searchFiles(ws, args) {
  const start = resolveIn(ws, args.path);
  let re;
  try { re = new RegExp(String(args.pattern), args.ignore_case ? 'i' : ''); } catch (e) { throw new Error('정규식 오류: ' + e.message); }
  const globRe = args.glob ? globToRegex(args.glob) : null;
  const globByName = args.glob ? !String(args.glob).replace(/\\/g, '/').includes('/') : true;
  const st = await fsp.stat(start);
  const budget = { n: 20000 };
  const files = st.isFile() ? (async function* () { yield start; })() : walk(resolveIn(ws, '.'), start, budget);
  const out = [];
  let fileCount = 0;
  for await (const abs of files) {
    const rel = toRel(ws, abs);
    if (globRe && !globRe.test(globByName ? path.basename(abs) : rel)) continue;
    let text;
    try {
      const s = await fsp.stat(abs);
      if (s.size > MAX_READ_BYTES) continue;
      text = decodeText(await fsp.readFile(abs));
    } catch { continue; }
    const lines = text.split('\n');
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hit = true;
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        if (out.length >= 200) break;
      }
    }
    if (hit) fileCount++;
    if (out.length >= 200) break;
  }
  const note = out.length >= 200 ? '\n… (200건에서 중단 — 패턴을 좁혀 보세요)' : '';
  return { ok: true, content: out.length ? out.join('\n') + note : '일치하는 내용이 없습니다.', meta: { matches: out.length, files: fileCount } };
}

async function readIfExists(abs) {
  try { return decodeText(await fsp.readFile(abs)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function writeFile(ws, args, ctx) {
  const abs = resolveIn(ws, args.path);
  if (typeof args.content !== 'string') throw new Error('content 는 문자열이어야 합니다.');
  const before = await readIfExists(abs);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, args.content, 'utf8');
  const d = lineDiff(before || '', args.content);
  const rel = toRel(ws, abs);
  if (ctx && ctx.onChange) ctx.onChange({ path: rel, before, after: args.content, tool: 'write_file' });
  return {
    ok: true,
    content: `${before == null ? '새 파일 작성' : '파일 덮어씀'}: ${rel} (+${d.added} −${d.removed}, ${args.content.replace(/\n$/, '').split('\n').length}행)`,
    meta: { path: rel, created: before == null, added: d.added, removed: d.removed, diff: d.text, diffTruncated: d.truncated },
  };
}

async function editFile(ws, args, ctx) {
  const abs = resolveIn(ws, args.path);
  const before = await readIfExists(abs);
  if (before == null) throw new Error('파일이 없습니다. 새 파일은 write_file 을 사용하세요.');
  let oldS = String(args.old_string == null ? '' : args.old_string);
  let newS = String(args.new_string == null ? '' : args.new_string);
  if (!oldS) throw new Error('old_string 이 비어 있습니다.');
  if (oldS === newS) throw new Error('old_string 과 new_string 이 같습니다.');
  if (!before.includes(oldS) && before.includes('\r\n')) {
    // CRLF 파일: 모델이 LF 로 보낸 문자열을 맞춰 준다.
    const o2 = oldS.replace(/\r?\n/g, '\r\n');
    if (before.includes(o2)) { oldS = o2; newS = newS.replace(/\r?\n/g, '\r\n'); }
  }
  const count = before.split(oldS).length - 1;
  if (count === 0) throw new Error('old_string 을 파일에서 찾지 못했습니다. read_file 로 정확한 내용(공백·들여쓰기 포함)을 확인하세요.');
  if (count > 1 && !args.replace_all) throw new Error(`old_string 이 ${count}곳에서 발견됩니다. 앞뒤 문맥을 더 포함하거나 replace_all=true 를 사용하세요.`);
  const after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
  await fsp.writeFile(abs, after, 'utf8');
  const d = lineDiff(before, after);
  const rel = toRel(ws, abs);
  if (ctx && ctx.onChange) ctx.onChange({ path: rel, before, after, tool: 'edit_file' });
  return {
    ok: true,
    content: `수정 완료: ${rel} (${args.replace_all ? count + '곳, ' : ''}+${d.added} −${d.removed})`,
    meta: { path: rel, added: d.added, removed: d.removed, diff: d.text, diffTruncated: d.truncated },
  };
}

const running = new Map(); // callId -> { kill() }

function shellFor(pref) {
  if (process.platform === 'win32') {
    if (pref === 'powershell') return { name: 'powershell', file: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + c] };
    return { name: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: (c) => ['/d', '/s', '/c', '"chcp 65001>nul & ' + c + '"'], verbatim: true };
  }
  const sh = process.env.SHELL && /(ba|z)?sh$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  return { name: path.basename(sh), file: sh, args: (c) => ['-c', c] };
}

function runCommand(ws, args, ctx) {
  const cwd = resolveIn(ws, '.');
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command 가 비어 있습니다.');
  const timeoutSec = Math.min(600, Math.max(1, parseInt(args.timeout_sec, 10) || ctx.commandTimeout || 120));
  const sh = shellFor(ctx.shell);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let killed = null;
    let child;
    try {
      child = spawn(sh.file, sh.args(command), {
        cwd, windowsHide: true, windowsVerbatimArguments: !!sh.verbatim,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        detached: process.platform !== 'win32',
      });
    } catch (e) { return resolve({ ok: false, content: '명령을 시작하지 못했습니다: ' + e.message, meta: {} }); }
    const kill = (why) => {
      if (killed) return;
      killed = why;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
    };
    const timer = setTimeout(() => kill('timeout'), timeoutSec * 1000);
    if (ctx.callId) running.set(ctx.callId, { kill: () => kill('cancel') });
    const onData = (d) => {
      const s = d.toString('utf8');
      if (out.length < 400000) out += s;
      if (ctx.onOutput) ctx.onOutput(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (code, errMsg) => {
      clearTimeout(timer);
      if (ctx.callId) running.delete(ctx.callId);
      const ms = Date.now() - t0;
      const body = clip(out.replace(/\r\n/g, '\n').trimEnd(), MAX_OUTPUT_CHARS);
      let status;
      if (killed === 'timeout') status = `[시간 초과 ${timeoutSec}초 — 프로세스 종료됨]`;
      else if (killed === 'cancel') status = '[사용자가 중단함]';
      else if (errMsg) status = `[실행 오류: ${errMsg}]`;
      else status = `[exit code ${code}]`;
      resolve({
        ok: !killed && !errMsg && code === 0,
        content: (body ? body + '\n' : '') + status,
        meta: { exitCode: code, ms, shell: sh.name, killed },
      });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function webFetch(args, ctx) {
  let u;
  try { u = new URL(String(args.url)); } catch { throw new Error('URL 형식이 올바르지 않습니다.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http(s) URL 만 가능합니다.');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  if (ctx.callId) running.set(ctx.callId, { kill: () => ac.abort() });
  try {
    const res = await ctx.fetchImpl(u.href, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'EXAONE-Desktop/0.1', 'Accept': 'text/html,application/json,text/*;q=0.9,*/*;q=0.5' } });
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !/text|json|xml|javascript|csv/.test(ctype)) {
      return { ok: false, content: `텍스트가 아닌 응답입니다 (${ctype}, HTTP ${res.status}).`, meta: { status: res.status } };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.subarray(0, 3 * 1024 * 1024).toString('utf8');
    if (ctype.includes('html') || /^\s*<(!doctype|html)/i.test(text)) {
      const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      text = (title ? `제목: ${title.trim()}\n\n` : '') + htmlToText(text);
    }
    return { ok: res.ok, content: `URL: ${res.url || u.href}\nHTTP ${res.status}\n\n` + clip(text, MAX_OUTPUT_CHARS), meta: { status: res.status, chars: text.length } };
  } catch (e) {
    return { ok: false, content: '가져오기 실패: ' + (ac.signal.aborted ? '시간 초과 또는 중단' : e.message), meta: {} };
  } finally {
    clearTimeout(timer);
    if (ctx.callId) running.delete(ctx.callId);
  }
}

function updatePlan(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) throw new Error('steps 가 비어 있습니다.');
  return { ok: true, content: '계획을 갱신했습니다.', meta: { steps: steps.length } };
}

/** ctx: { workspace, callId, shell, commandTimeout, fetchImpl, onOutput, onChange } */
async function run(name, args, ctx) {
  if (!BY_NAME.has(name)) return { ok: false, content: `알 수 없는 도구: ${name}`, meta: {} };
  const a = args && typeof args === 'object' ? args : {};
  const ws = ctx.workspace;
  try {
    switch (name) {
      case 'list_dir': return await listDir(ws, a);
      case 'read_file': return await readFile(ws, a);
      case 'find_files': return await findFiles(ws, a);
      case 'search_files': return await searchFiles(ws, a);
      case 'update_plan': return updatePlan(a);
      case 'write_file': return await writeFile(ws, a, ctx);
      case 'edit_file': return await editFile(ws, a, ctx);
      case 'run_command': return await runCommand(ws, a, ctx);
      case 'web_fetch': return await webFetch(a, ctx);
      default: return { ok: false, content: `알 수 없는 도구: ${name}`, meta: {} };
    }
  } catch (e) {
    const msg = e && e.code === 'ENOENT' ? '경로를 찾을 수 없습니다: ' + (a.path || '') : (e && e.message) || String(e);
    return { ok: false, content: '오류: ' + msg, meta: {} };
  }
}

function cancel(callId) {
  const r = running.get(callId);
  if (r) r.kill();
}
function cancelAll() { for (const r of running.values()) r.kill(); }

module.exports = { askUser, definitions, run, cancel, cancelAll, shellFor, lineDiff, globToRegex, resolveIn, decodeText };
