'use strict';
// 데스크톱 앱의 에이전트 작업과 EXAONE Code(터미널) 세션을 서로 골라서 이어 갈 수 있게 하는 공통 코드.
// 불러올 때는 상대 쪽 형식으로 바꾼 "복사본"을 만든다. 원본 기록은 건드리지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../cli/store');

const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const samePath = (a, b) => {
  const n = (p) => { p = path.resolve(String(p || '')).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? p.toLowerCase() : p; };
  return !!a && !!b && n(a) === n(b);
};
const SUMMARY_HEAD = '이 세션은 컨텍스트가 가득 차서 이전 대화에서 이어지는 것입니다. 아래 요약이 대화의 앞부분을 대신합니다.\n\n';
const SUMMARY_RESUME = '\n\n사용자에게 더 묻지 말고 중단된 지점에서 바로 이어서 진행하세요. 요약을 받았다는 말이나 요약의 되풀이는 하지 마세요.';

// ---------- 터미널 세션 (~/.exaone/projects/<폴더 이름>/<id>.jsonl) ----------
const projectsRoot = () => path.join(cli.HOME, 'projects');

/**
 * 세션 폴더 이름은 작업 폴더 경로에서 기호를 뺀 것이라 그대로는 경로를 되돌릴 수 없다.
 * project.json 이 없는 옛 폴더는 디스크를 따라 내려가며 같은 이름이 되는 폴더를 찾는다.
 */
function recoverCwd(slugName) {
  const piece = (name) => name.replace(/[^a-zA-Z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  const roots = [];
  if (process.platform === 'win32') {
    const m = /^([A-Za-z])(?:-(.*))?$/.exec(slugName);
    if (!m) return '';
    roots.push({ dir: m[1].toUpperCase() + ':\\', rest: m[2] || '' });
  } else roots.push({ dir: '/', rest: slugName });
  let budget = 4000; // 살펴볼 폴더 수의 상한
  const walk = (dir, rest, depth) => {
    if (!rest) return dir;
    if (depth > 24 || budget <= 0) return '';
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return ''; }
    for (const name of names) {
      budget--;
      const p = piece(name);
      if (!p) continue;
      if (rest === p) return path.join(dir, name);
      if (rest.startsWith(p + '-')) {
        const found = walk(path.join(dir, name), rest.slice(p.length + 1), depth + 1);
        if (found) return found;
      }
    }
    return '';
  };
  for (const r of roots) { const found = walk(r.dir, r.rest, 0); if (found) return found; }
  return '';
}

function cwdOfProject(slugName) {
  const dir = path.join(projectsRoot(), slugName);
  const meta = readJson(path.join(dir, 'project.json'));
  if (meta && meta.cwd) return meta.cwd;
  const cwd = recoverCwd(slugName);
  if (cwd) { try { fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ cwd }, null, 2) + '\n', 'utf8'); } catch { /* 읽기 전용이면 다음에 다시 찾는다 */ } }
  return cwd;
}

/** 모든 폴더의 터미널 세션을 최근 것부터. cwd 를 주면 그 폴더의 것만. */
function listCliSessions({ cwd, limit = 100 } = {}) {
  let slugs = [];
  try { slugs = fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const files = [];
  for (const slugName of slugs) {
    const dir = path.join(projectsRoot(), slugName);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    if (!names.length) continue;
    const projectCwd = cwdOfProject(slugName);
    if (cwd && !samePath(projectCwd, cwd)) continue;
    for (const n of names) {
      const file = path.join(dir, n);
      try { files.push({ slug: slugName, id: n.slice(0, -6), file, cwd: projectCwd, mtime: fs.statSync(file).mtimeMs }); } catch { /* 사라진 파일 */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const messages = cli.Session.read(f.file);
    if (!messages.length) continue;
    const first = messages.find((m) => m.role === 'user');
    const text = first ? String(first._display || first.content || '').replace(/\s+/g, ' ').trim() : '';
    out.push({ slug: f.slug, id: f.id, cwd: f.cwd, mtime: f.mtime, count: messages.length, title: text.slice(0, 80) || '(제목 없음)' });
  }
  return out;
}

function readCliSession(slugName, id) {
  if (!/^[\w.-]+$/.test(String(id)) || /[\\/]/.test(String(slugName))) return [];
  return cli.Session.read(path.join(projectsRoot(), slugName, id + '.jsonl'));
}

/**
 * 터미널 세션의 메시지(OpenAI 형식)를 데스크톱 앱의 대화 메시지로 바꾼다.
 * 앱이 Code 탭에서 저장한 줄에는 화면용 정보(_ui: 통계 · 도구 상태 · diff 등)가 함께 있어 그대로 되살린다.
 */
function cliToDesktop(messages) {
  const out = [];
  const names = new Map();
  let ts = Date.now() - messages.length;
  for (const m of messages) {
    ts++;
    const ui = m._ui && typeof m._ui === 'object' ? m._ui : {};
    if (m.role === 'user') {
      const shown = m._display != null ? String(m._display) : String(m.content || '');
      const msg = { id: ui.id || rid('m'), role: 'user', content: shown, attachments: [], ts: ui.ts || ts };
      // 화면에는 입력한 글만 보이고, 모델에는 @파일 내용 등이 붙은 원문이 간다.
      if (String(m.content || '') !== shown) msg.apiContent = String(m.content || '');
      out.push(msg);
    } else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls || []).map((tc) => ({ id: tc.id || rid('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '{}' }));
      for (const tc of toolCalls) names.set(tc.id, tc.name);
      const msg = { id: ui.id || rid('m'), role: 'assistant', content: String(m.content || ''), reasoning: String(m.reasoning_content || ''), toolCalls, stats: ui.stats || {}, ts: ui.ts || ts };
      for (const k of ['usage', 'error', 'aborted', 'finish', 'incomplete', 'changes']) if (ui[k] != null) msg[k] = ui[k];
      out.push(msg);
    } else if (m.role === 'tool') {
      const content = String(m.content == null ? '' : m.content);
      out.push({ id: ui.id || rid('m'), role: 'tool', toolCallId: m.tool_call_id, name: ui.name || names.get(m.tool_call_id) || '', content,
        status: ui.status || (/^\(실행되지 않음/.test(content) ? 'skipped' : /^오류[:：]/.test(content) ? 'error' : 'ok'), meta: ui.meta || {}, ts: ui.ts || ts });
    }
  }
  return out;
}

// ---------- 데스크톱 앱의 대화 (<데이터 폴더>/conversations/<id>.json) ----------
function desktopDataDir() {
  if (process.env.EXAONE_DATA_DIR) return path.resolve(process.env.EXAONE_DATA_DIR);
  const name = 'EXAONE Desktop';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

/** 데스크톱 앱에서 이 폴더(cwd)를 작업 폴더로 쓴 에이전트 작업들. */
function listDesktopTasks(cwd, dataDir = desktopDataDir()) {
  const dir = path.join(dataDir, 'conversations');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const c = readJson(path.join(dir, n));
    if (!c || c.mode !== 'agent' || !samePath(c.workspace, cwd) || !Array.isArray(c.messages)) continue;
    const count = c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    if (!count) continue;
    out.push({ id: c.id, file: path.join(dir, n), title: c.title || '새 작업', mtime: c.updatedAt || c.createdAt || 0, count });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 데스크톱 앱의 대화를 터미널 세션의 메시지(OpenAI 형식)로 바꾼다. 압축된 대화는 요약부터 이어진다. */
function desktopToCli(conv, { ui = false } = {}) {
  const keep = (obj, extra) => { if (ui) obj._ui = extra; return obj; };
  const all = Array.isArray(conv.messages) ? conv.messages : [];
  let start = 0, summary = null;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'compact' && all[i].summary) { start = i + 1; summary = all[i].summary; break; }
  const list = all.slice(start);
  const out = [];
  if (summary != null) {
    const next = list.find((m) => m.role === 'user' || (m.role === 'assistant' && (m.content || (m.toolCalls || []).length)));
    const resume = !next || next.role !== 'user';
    out.push({ role: 'user', content: SUMMARY_HEAD + summary + (resume ? SUMMARY_RESUME : ''), _display: '(이전 대화 요약)' });
    if (!resume) out.push({ role: 'assistant', content: '요약한 맥락을 확인했습니다. 이어서 진행하겠습니다.' });
  }
  for (const m of list) {
    if (m.role === 'user') {
      let content = m.apiContent != null ? String(m.apiContent) : '';
      if (m.apiContent == null) {
        for (const a of m.attachments || []) content += `<file name="${a.name}">\n${a.text}\n</file>\n\n`;
        content += m.content || '';
      }
      const msg = { role: 'user', content };
      if (content !== (m.content || '')) msg._display = m.content || '';
      out.push(keep(msg, { id: m.id, ts: m.ts }));
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls || []).filter((tc) => tc && tc.name);
      if (!m.content && !calls.length && !(ui && m.error)) continue;
      const am = { role: 'assistant', content: m.content || '' };
      if (m.reasoning) am.reasoning_content = m.reasoning;
      if (calls.length) {
        am.tool_calls = calls.map((tc) => {
          let args = tc.arguments || '{}';
          try { JSON.parse(args); } catch { args = '{}'; }
          return { id: tc.id, type: 'function', function: { name: tc.name, arguments: args } };
        });
      }
      const extra = { id: m.id, ts: m.ts, stats: m.stats || {} };
      for (const k of ['usage', 'error', 'aborted', 'finish', 'incomplete', 'changes']) if (m[k] != null) extra[k] = m[k];
      out.push(keep(am, extra));
      for (const tc of calls) {
        const tm = all.find((x) => x.role === 'tool' && x.toolCallId === tc.id);
        out.push(keep({ role: 'tool', tool_call_id: tc.id, content: tm ? String(tm.content == null ? '' : tm.content) : '(실행되지 않음: 사용자가 중단함)' },
          tm ? { id: tm.id, ts: tm.ts, name: tm.name, status: tm.status, meta: tm.meta || {} } : { status: 'skipped' }));
      }
    }
  }
  return out;
}

function readDesktopTask(id, dataDir = desktopDataDir()) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return readJson(path.join(dataDir, 'conversations', safe + '.json'));
}

// ---------- Code 탭: 앱에서 터미널 세션 파일을 그대로 읽고 쓴다 ----------
const validSid = (sid) => /^[\w.-]+$/.test(String(sid || ''));

/** 세션 id 로 파일을 찾는다 (세션 폴더가 작업 폴더마다 따로 있어서 모두 살펴본다). */
function findCliSession(sid) {
  if (!validSid(sid)) return null;
  let slugs = [];
  try { slugs = fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  for (const slugName of slugs) {
    const file = path.join(projectsRoot(), slugName, sid + '.jsonl');
    if (fs.existsSync(file)) return { slug: slugName, file, cwd: cwdOfProject(slugName) };
  }
  return null;
}

/** 터미널 세션을 앱의 대화 형태로 읽는다. 없으면 null. */
function loadCodeSession(sid) {
  const f = findCliSession(sid);
  if (!f) return null;
  const raw = cli.Session.read(f.file);
  const first = raw.find((m) => m.role === 'user');
  const st = fs.statSync(f.file);
  return {
    id: 'code:' + sid, code: { id: sid }, mode: 'agent', projectId: null, workspace: f.cwd || '',
    title: first ? String(first._display || first.content || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    createdAt: st.birthtimeMs || st.mtimeMs, updatedAt: st.mtimeMs, _mtime: st.mtimeMs, messages: cliToDesktop(raw),
  };
}

/** 앱의 Code 대화를 터미널 세션 파일로 쓴다 (터미널에서 exaone --resume 으로 그대로 이어진다). */
function saveCodeSession(conv) {
  const sid = conv && conv.code && conv.code.id;
  if (!validSid(sid)) throw new Error('세션 id 가 올바르지 않습니다');
  if (!conv.workspace) throw new Error('작업 폴더가 없습니다');
  const found = findCliSession(sid);
  const session = new cli.Session(found && found.cwd ? found.cwd : conv.workspace, sid);
  if (found) session.file = found.file;
  session.rewrite(desktopToCli(conv, { ui: true }));
  return { mtime: fs.statSync(session.file).mtimeMs };
}

function deleteCodeSession(sid) {
  const f = findCliSession(sid);
  if (!f) return false;
  fs.unlinkSync(f.file);
  // 실시간 연동용 파일(.live · .ctl)도 같이 지운다.
  for (const ext of ['.live', '.ctl']) { try { fs.unlinkSync(f.file.replace(/\.jsonl$/i, '') + ext); } catch { /* 없음 */ } }
  return true;
}

function statCodeSession(sid) {
  const f = findCliSession(sid);
  if (!f) return null;
  return { mtime: fs.statSync(f.file).mtimeMs };
}

/** 그 폴더에 적용되는 EXAONE.md 메모리 (터미널의 EXAONE Code 가 system 메시지에 넣는 것과 같은 내용) */
function codeMemory(cwd) {
  if (!cwd) return '';
  const parts = [];
  for (const f of cli.memoryFiles(cwd)) if (f.exists && f.text && f.text.trim()) parts.push(`# ${f.label} (${f.path})\n${f.text.trim().slice(0, 20000)}`);
  return parts.join('\n\n');
}

module.exports = { findCliSession, loadCodeSession, saveCodeSession, deleteCodeSession, statCodeSession, codeMemory, samePath, listCliSessions, readCliSession, cliToDesktop, desktopDataDir, listDesktopTasks, readDesktopTask, desktopToCli, recoverCwd };
