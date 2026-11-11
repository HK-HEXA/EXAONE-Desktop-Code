'use strict';
// EXAONE Code 대화형 화면: 입력 상자, 진행 표시, 권한 확인 상자, 슬래시 명령.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const { c, strWidth, charWidth, truncate, padEnd, wrapAnsi, box, Screen } = require('./term');
const md = require('./markdown');
const store = require('./store');
const tools = require('../src/tools');
const sessions = require('../src/sessions');
const live = require('../src/live');
const retry = require('../renderer/js/retry');
// 같은 세션을 보는 상대 쪽(데스크톱 앱)과 주고받는 화면 사건들
const LIVE_EVENTS = ['requestStart', 'thinkingStart', 'reasoning', 'thinkingEnd', 'contentStart', 'content', 'contentEnd', 'toolBuilding', 'toolStart', 'toolOutput', 'toolEnd', 'error', 'notice', 'retryWait', 'compactStart', 'compactEnd', 'interrupted', 'turnEnd'];
const { MODES, CTX_LIMIT, COMPACT_RESERVE, COMPACT_BUFFER, toolTitle } = require('./agent');
const pkg = require('../package.json');

const fmtNum = (n) => (n == null ? '–' : Number(n).toLocaleString('ko-KR'));
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
/** 경과 시간: 12초 / 4분 2초 / 1시간 2분 3초 */
function fmtElapsed(ms, done) {
  if (done && ms < 1000) return '1초 미만';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}시간 ${m}분 ${sec}초` : m ? `${m}분 ${sec}초` : `${sec}초`;
}
const SPIN = ['·', '✢', '✳', '∗', '✻', '✽', '✻', '∗', '✳', '✢'];
const VERBS = ['생각하는 중', '궁리하는 중', '곱씹는 중', '헤아리는 중', '가다듬는 중', '짜 맞추는 중', '살펴보는 중', '고민하는 중'];
const MODE_TEXT = {
  default: null,
  acceptEdits: () => c.accept('⏵⏵ 편집 자동 허용 켜짐') + c.dim(' (shift+tab 으로 전환)'),
  plan: () => c.plan('⏸ 계획 모드 켜짐') + c.dim(' (shift+tab 으로 전환)'),
  bypassPermissions: () => c.red('⏵⏵ 권한 확인 건너뛰기 켜짐') + c.dim(' (shift+tab 으로 전환)'),
};

// ---------- 입력 편집기 ----------
class Editor {
  constructor(history) { this.buf = ''; this.cur = 0; this.hist = history || []; this.hidx = -1; this.draft = ''; this.pastes = []; this.pasting = null; }

  set(text) { this.buf = text; this.cur = text.length; }
  clear() { this.buf = ''; this.cur = 0; this.hidx = -1; this.pastes = []; }
  insert(s) { this.buf = this.buf.slice(0, this.cur) + s + this.buf.slice(this.cur); this.cur += s.length; }
  prev(i) { if (i <= 0) return 0; const lo = this.buf.charCodeAt(i - 1); return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? i - 2 : i - 1; }
  next(i) { if (i >= this.buf.length) return this.buf.length; const hi = this.buf.charCodeAt(i); return hi >= 0xd800 && hi <= 0xdbff ? i + 2 : i + 1; }
  wordLeft() { let i = this.cur; while (i > 0 && /\s/.test(this.buf[i - 1])) i--; while (i > 0 && !/\s/.test(this.buf[i - 1])) i--; return i; }
  wordRight() { let i = this.cur; const n = this.buf.length; while (i < n && /\s/.test(this.buf[i])) i++; while (i < n && !/\s/.test(this.buf[i])) i++; return i; }

  /** 붙여넣은 긴 글은 자리표시로 줄여 보여 주고, 보낼 때 원문으로 되돌린다. */
  expanded() { return this.buf.replace(/\[붙여넣은 글 #(\d+) \+\d+줄\]/g, (m, n) => (this.pastes[n - 1] != null ? this.pastes[n - 1] : m)); }

  layout(width) {
    const rows = [];
    let row = { text: '', w: 0, start: 0 };
    let idx = 0, cr = 0, cc = 0;
    const at = () => { cr = rows.length; cc = row.w; };
    for (const ch of this.buf) {
      if (ch === '\n') { if (idx === this.cur) at(); rows.push(row); idx += 1; row = { text: '', w: 0, start: idx }; continue; }
      const cw = charWidth(ch.codePointAt(0));
      if (row.w + cw > width) { rows.push(row); row = { text: '', w: 0, start: idx }; }
      if (idx === this.cur) at();
      row.text += ch; row.w += cw; idx += ch.length;
    }
    if (idx === this.cur) at();
    rows.push(row);
    return { rows, cr, cc };
  }

  moveVertical(dir, width) {
    const { rows, cr, cc } = this.layout(width);
    const tr = cr + dir;
    if (tr < 0 || tr >= rows.length) return false;
    let w = 0, off = 0;
    for (const ch of rows[tr].text) { const cw = charWidth(ch.codePointAt(0)); if (w + cw > cc) break; w += cw; off += ch.length; }
    this.cur = rows[tr].start + off;
    return true;
  }

  historyMove(dir) {
    if (!this.hist.length) return;
    if (this.hidx === -1) { if (dir > 0) return; this.draft = this.buf; this.hidx = this.hist.length - 1; }
    else {
      this.hidx += dir;
      if (this.hidx >= this.hist.length) { this.hidx = -1; this.set(this.draft); return; }
      if (this.hidx < 0) this.hidx = 0;
    }
    this.set(this.hist[this.hidx]);
  }

  /** 편집 키 처리. 처리했으면 true. (Enter·Tab·Esc 같은 동작 키는 App 이 맡는다) */
  key(str, key, width) {
    const k = key || {};
    if (k.name === 'paste-start') { this.pasting = ''; return true; }
    if (k.name === 'paste-end') {
      const text = (this.pasting || '').replace(/\r\n?/g, '\n');
      this.pasting = null;
      const lines = text.split('\n').length;
      if (lines > 4 || text.length > 600) { this.pastes.push(text); this.insert(`[붙여넣은 글 #${this.pastes.length} +${lines}줄]`); }
      else this.insert(text);
      return true;
    }
    if (this.pasting != null) { this.pasting += k.name === 'return' || k.name === 'enter' ? '\n' : (str != null ? str : (k.sequence || '')); return true; }

    if (k.name === 'backspace') {
      if (k.meta || k.ctrl) { const i = this.wordLeft(); this.buf = this.buf.slice(0, i) + this.buf.slice(this.cur); this.cur = i; }
      else if (this.cur > 0) { const i = this.prev(this.cur); this.buf = this.buf.slice(0, i) + this.buf.slice(this.cur); this.cur = i; }
      return true;
    }
    if (k.name === 'delete') { if (this.cur < this.buf.length) this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.next(this.cur)); return true; }
    if (k.name === 'left') { this.cur = k.ctrl || k.meta ? this.wordLeft() : this.prev(this.cur); return true; }
    if (k.name === 'right') { this.cur = k.ctrl || k.meta ? this.wordRight() : this.next(this.cur); return true; }
    if (k.name === 'home' || (k.ctrl && k.name === 'a')) { const { rows, cr } = this.layout(width); this.cur = rows[cr].start; return true; }
    if (k.name === 'end' || (k.ctrl && k.name === 'e')) { const { rows, cr } = this.layout(width); this.cur = rows[cr].start + rows[cr].text.length; return true; }
    if (k.ctrl && k.name === 'u') { this.buf = this.buf.slice(this.cur); this.cur = 0; return true; }
    if (k.ctrl && k.name === 'k') { this.buf = this.buf.slice(0, this.cur); return true; }
    if (k.ctrl && k.name === 'w') { const i = this.wordLeft(); this.buf = this.buf.slice(0, i) + this.buf.slice(this.cur); this.cur = i; return true; }
    if (k.meta && k.name === 'b') { this.cur = this.wordLeft(); return true; }
    if (k.meta && k.name === 'f') { this.cur = this.wordRight(); return true; }
    if ((k.name === 'return' && k.meta) || k.name === 'enter') { this.insert('\n'); return true; } // alt+enter, ctrl+j
    if (str && !k.ctrl && !k.meta && str >= ' ' && str !== '\x7f') { this.insert(str); return true; }
    return false;
  }
}

// ---------- 선택 상자 / 입력 상자 ----------
class SelectModal {
  constructor({ title, lines, question, options, color, keys, cancel, index }) {
    Object.assign(this, { title, lines: lines || [], question, options, color: color || c.dim, keys: keys || {}, cancel: cancel == null ? -1 : cancel });
    this.idx = Math.min(Math.max(0, index || 0), options.length - 1);
    this.promise = new Promise((res) => { this.resolve = res; });
  }

  render(cols) {
    const width = Math.min(cols - 1, 110);
    const inner = width - 4;
    const body = [];
    if (this.title) body.push(c.bold(this.title), '');
    for (const l of this.lines) body.push(...(typeof l === 'string' ? wrapAnsi(l, inner) : l.raw));
    if (this.lines.length) body.push('');
    if (this.question) body.push(...wrapAnsi(this.question, inner));
    this.options.forEach((o, i) => {
      const head = (i === this.idx ? c.brand('❯ ') : '  ') + `${i + 1}. `;
      const w = wrapAnsi(o.label, inner - strWidth(head));
      w.forEach((l, j) => body.push((j ? ' '.repeat(strWidth(head)) : head) + (i === this.idx ? c.brand(l) : l)));
    });
    return { lines: box(body, width, this.color), cursor: null };
  }

  onKey(str, key) {
    const k = key || {};
    const n = this.options.length;
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) this.idx = (this.idx - 1 + n) % n;
    else if (k.name === 'down' || (k.ctrl && k.name === 'n') || (k.name === 'tab' && !k.shift)) this.idx = (this.idx + 1) % n;
    else if (k.name === 'return' || k.name === 'enter') return this.resolve(this.idx);
    else if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return this.resolve(this.cancel);
    else if (k.shift && k.name === 'tab' && this.keys.shiftTab != null) return this.resolve(this.keys.shiftTab);
    else if (str && /^[1-9]$/.test(str) && Number(str) <= n) return this.resolve(Number(str) - 1);
    return undefined;
  }
}

class InputModal {
  constructor({ title, hint, mask, initial }) {
    this.title = title; this.hint = hint; this.mask = mask;
    this.ed = new Editor([]);
    if (initial) this.ed.set(initial);
    this.promise = new Promise((res) => { this.resolve = res; });
  }

  render(cols) {
    const width = Math.min(cols - 1, 110);
    const inner = width - 6;
    const shown = this.mask ? '•'.repeat(Math.min(this.ed.buf.length, inner)) : null;
    const lay = this.ed.layout(inner);
    const rows = shown != null ? [shown] : lay.rows.map((r) => r.text);
    const body = rows.map((t, i) => (i ? '  ' : c.dim('❯ ')) + t);
    const lines = [];
    if (this.title) lines.push(c.bold(this.title));
    lines.push(...box(body, width));
    lines.push(c.dim('  ' + (this.hint || 'enter 로 확인 · esc 로 취소')));
    const base = this.title ? 2 : 1;
    return { lines, cursor: { row: base + (shown != null ? 0 : lay.cr), col: 4 + (shown != null ? strWidth(shown) : lay.cc) } };
  }

  onKey(str, key) {
    const k = key || {};
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return this.resolve(null);
    if (k.name === 'return' && !k.meta && this.ed.pasting == null) return this.resolve(this.ed.expanded());
    this.ed.key(str, key, 80);
    return undefined;
  }
}

// ---------- 도구 결과 표시 ----------
function diffLines(text, width, max) {
  const res = [];
  let a = 1, b = 1;
  const all = String(text || '').split('\n');
  for (const l of all) {
    const m = /^@@ -(\d+) \+(\d+) @@/.exec(l);
    if (m) { a = Number(m[1]); b = Number(m[2]); if (res.length) res.push(c.dim('     ⋮')); continue; }
    const sign = l[0], body = l.slice(1);
    const no = String(sign === '-' ? a : b).padStart(6);
    const line = truncate(`${no} ${sign === '+' || sign === '-' ? sign : ' '} ${body}`, width);
    res.push(sign === '+' ? c.bgAdd(padEnd(line, width)) : sign === '-' ? c.bgDel(padEnd(line, width)) : c.dim(line));
    if (sign !== '+') a++;
    if (sign !== '-') b++;
    if (max && res.length >= max) { res.push(c.dim(`     … +${all.length - res.length}줄`)); break; }
  }
  return res;
}

function todoLines(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => (s && s.status === 'done' ? c.green('☒ ') + c.dim(c.strike(String(s.title)))
    : s && s.status === 'in_progress' ? c.brand('◼ ') + c.bold(String(s.title)) : '☐ ' + String(s && s.title)));
}

function toolSummary(name, a, res) {
  const m = res.meta || {};
  const n = (s) => String(s || '').replace(/\n$/, '').split('\n').length;
  if (res.rejected) return { error: res.display || '거부함' };
  if (!res.ok) return { error: String(res.content || '').replace(/^오류:\s*/, '').split('\n').filter(Boolean).slice(-1)[0] || '실패' };
  switch (name) {
    case 'read_file': return { text: `${fmtNum((m.to || 0) - (m.from || 1) + 1)}줄 읽음` };
    case 'write_file': return { text: `${fmtNum(n(a.content))}줄을 ${a.path} 에 ${m.created ? '새로 작성' : '덮어씀'}` };
    case 'edit_file': return { text: `${a.path} 수정: ${m.added}줄 추가, ${m.removed}줄 삭제` };
    case 'run_command': { const body = String(res.content).replace(/\n?\[exit code \d+\]$/, ''); return { text: body.trim() ? `${fmtNum(n(body))}줄 출력` : '(출력 없음)' }; }
    case 'list_dir': return { text: `${fmtNum(m.count)}개 항목` };
    case 'find_files': return { text: `${fmtNum(m.count)}개 파일` };
    case 'search_files': return { text: `${fmtNum(m.matches)}건 (${fmtNum(m.files)}개 파일)` };
    case 'web_fetch': return { text: `HTTP ${m.status} · ${fmtNum(m.chars)}자` };
    case 'ask_user': return { text: (m.answer || '') };
    default: return { text: String(res.content || '').split('\n')[0].slice(0, 100) };
  }
}

function toolDetail(name, a, res, width) {
  const m = res.meta || {};
  if (name === 'write_file') return m.diff ? diffLines(m.diff, width, 200) : [];
  if (name === 'edit_file') return m.diff ? diffLines(m.diff, width, 200) : [];
  if ((name === 'read_file' && res.ok) || name === 'ask_user' || name === 'update_plan' || res.rejected) return [];
  const lines = String(res.content || '').replace(/\n+$/, '').split('\n');
  const shown = lines.slice(0, 80).map((l) => c.dim(truncate(l, width)));
  if (lines.length > 80) shown.push(c.dim(`… +${lines.length - 80}줄`));
  return shown;
}

// ---------- 앱 ----------
class App {
  constructor({ agent, cfg, cwd, keyInfo, history, settings, opt }) {
    Object.assign(this, { agent, cfg, cwd, keyInfo, history, settings, opt });
    this.screen = new Screen();
    this.screen.anchor = true; // 입력창을 터미널 맨 아래에 붙여 둔다
    this.editor = new Editor(store.loadHistory(cwd));
    this.modalObj = null;
    this.busy = false;
    this.spinner = null;       // { label, start, chars }
    this.pending = [];         // 아직 확정되지 않은 응답 미리보기
    this.running = null;       // 실행 중인 도구 { title, tail }
    this.queue = [];
    this.waiter = null;
    this.menu = null;          // { kind, items, idx }
    this.menuIdx = 0;
    this.hint = null;
    this.showHelp = false;
    this.verbose = !!opt.verbose;
    this.frame = 0;
    this.lastEsc = 0;
    this.ctrlC = 0;
    this.blockOpen = false;    // "●" 블록이 이어지는 중인지
    this.group = null;         // 접힌 보기에서 모으는 중인 도구 묶음
    this.thinkAcc = 0;         // 아직 출력하지 않은 생각 시간
    this.files = null;
    this.commands = this.buildCommands();
    this.custom = store.customCommands(cwd);
    this.tick = setInterval(() => { if (this.busy && !this.modalObj) { this.frame++; this.render(); } }, 120);
    this.tick.unref();
    // 데스크톱 앱의 Code 탭이 같은 세션에 이어 쓰면 바로 불러와 보여 준다.
    this.syncTick = setInterval(() => { try { this.syncSession(); } catch { /* 다음 번에 다시 본다 */ } }, 700);
    this.syncTick.unref();
    // 실시간 연동: 상대 쪽이 실행 중인 작업(입력한 지시 · 생각 · 답변 글자 · 도구 실행)을 그대로 따라 그린다.
    this.src = live.newSrc();
    this.remote = null;   // 상대 쪽이 실행 중인 지시 { n, last }
    this.liveOut = null;  // 우리가 실행하는 작업을 알리는 쪽
    this.liveIn = null;   // 상대 쪽 작업을 읽는 쪽
    this.liveTick = setInterval(() => { try { this.pollLive(); } catch { /* 다음 번에 다시 본다 */ } }, 90);
    this.liveTick.unref();
  }

  /** 화면에 그리는 ui() 를 감싸서, 같은 사건을 상대 쪽에도 알린다. */
  liveUi() {
    const base = this.baseUi = this.ui();
    const out = { ...base };
    for (const name of LIVE_EVENTS) out[name] = (...args) => { this.emitLive(name, args); return base[name](...args); };
    // 사용자의 확인을 기다리는 동안은 상대 쪽에 "확인 대기 중" 으로 보인다.
    for (const [name, kind] of [['permission', 'approval'], ['askUser', 'ask'], ['approvePlan', 'plan']]) {
      out[name] = async (...args) => { this.emitLive('wait', [kind]); try { return await base[name](...args); } finally { this.emitLive('waitEnd', []); } };
    }
    return out;
  }

  liveWriter() {
    const file = this.agent.session.file;
    if (!this.liveOut || this.liveOut.file !== live.liveFile(file)) {
      if (this.liveOut) this.liveOut.end();
      this.liveOut = new live.LiveWriter(file, this.src, { onStop: () => { if (this.busy && !this.remote) this.interrupt(); } });
    }
    return this.liveOut;
  }

  emitLive(name, args) {
    const w = this.liveOut;
    if (!w || !w.active) return;
    if (name === 'toolBuilding') args = [{ name: args[0] && args[0].name }];
    else if (name === 'toolStart') args = [{ id: args[0].id, name: args[0].name }, args[1]];
    else if (name === 'toolEnd') {
      const r = args[2] || {};
      args = [{ id: args[0].id, name: args[0].name }, args[1], { ok: !!r.ok, content: r.content, meta: r.meta, rejected: r.rejected, display: r.display, silent: r.silent }];
    }
    w.emit(name, ...args);
  }

  /** 상대 쪽(데스크톱 앱)이 이 세션에서 실행 중인 작업을 읽어 그대로 그린다. */
  pollLive() {
    const session = this.agent.session;
    if (!session || !this.baseUi) return;
    if (!this.liveIn || this.liveIn.file !== live.liveFile(session.file)) {
      this.liveIn = new live.LiveReader(session.file, this.src);
      // 방금 연 세션: 지금 진행 중인 작업이 아니라 지난 기록이면 건너뛴다.
      this.liveIn.skipFinished();
    }
    if (this.busy && !this.remote) { this.liveIn.poll(); return; } // 우리가 실행 중일 때 온 것은 버린다
    if (this.modalObj && !this.remote) return;                     // 선택 상자가 떠 있으면 닫힌 뒤에 이어서 읽는다
    for (const e of this.liveIn.poll()) this.applyLive(e);
    // 상대 쪽이 말없이 사라졌으면(비정상 종료) 기다리지 않는다.
    if (this.remote && Date.now() - this.remote.last > 12000) this.endRemote();
  }

  applyLive(e) {
    const ui = this.baseUi;
    const a = Array.isArray(e.a) ? e.a : [];
    if (e.t === 'turnStart') {
      if (this.remote) this.endRemote(true);
      this.remote = { n: e.n, last: Date.now() };
      this.busy = true; this.interrupted = false; this.spinner = null; this.pending = []; this.running = null;
      const text = String((a[0] || {}).display || '');
      if (text) this.echo(text);
      this.render();
      return;
    }
    if (!this.remote || e.n !== this.remote.n) return;
    this.remote.last = Date.now();
    if (e.t === 'hb' || e.t === 'waitEnd') return;
    if (e.t === 'liveEnd') { this.endRemote(); return; }
    if (e.t === 'wait') {
      this.flushSteps();
      this.spinner = { label: a[0] === 'ask' ? '데스크톱 앱에서 질문에 답하기를 기다리는 중' : '데스크톱 앱에서 승인을 기다리는 중', start: Date.now(), chars: 0 };
      this.render();
      return;
    }
    if (!LIVE_EVENTS.includes(e.t) || typeof ui[e.t] !== 'function') return;
    if (e.t === 'toolStart') ui.toolStart(a[0] || {}, a[1] || {}, toolTitle((a[0] || {}).name, a[1] || {}));
    else if (e.t === 'toolEnd') ui.toolEnd(a[0] || {}, a[1] || {}, a[2] || {}, toolTitle((a[0] || {}).name, a[1] || {}));
    else if (e.t === 'thinkingEnd') ui.thinkingEnd(Number(a[0]) || 0, String(a[1] || ''));
    else ui[e.t](...a);
  }

  /** 상대 쪽 작업이 끝났다: 화면을 정리하고, 기록 파일의 내용으로 대화를 맞춘다 (이미 화면에 보여 준 내용이라 다시 그리지 않는다). */
  endRemote(restart) {
    if (!this.remote) return;
    if (this.stream) { try { this.stream.end(); } catch { /* 무시 */ } this.stream = null; }
    this.flushSteps();
    this.remote = null;
    this.busy = false; this.spinner = null; this.pending = []; this.running = null; this.blockOpen = false;
    const session = this.agent.session;
    try { this.agent.messages = store.Session.read(session.file); this.agent.resetUsage(); session.touch(); } catch { /* 다음 확인 때 맞춘다 */ }
    this.quietSyncUntil = Date.now() + 4000; // 곧이어 기록 파일이 마저 저장되어도 같은 내용을 또 그리지 않는다
    if (restart) return;
    this.render();
    // 기다리게 해 둔 입력이 있으면 이제 보낸다.
    if (this.queue.length && this.waiter) { const w = this.waiter; this.waiter = null; w(this.queue.shift()); }
  }

  /** 다른 쪽(데스크톱 앱)이 이 세션 파일에 쓴 내용이 있으면 불러와서, 새로 붙은 부분을 화면에 이어 보여 준다. */
  syncSession() {
    const session = this.agent.session;
    if (this.busy || this.modalObj || !session || !session.changedOutside()) return false;
    // 상대 쪽이 막 작업을 시작했거나 끝낸 참이면 실시간 통로 쪽에서 처리하도록 잠깐 미룬다.
    if (this.liveIn && this.liveIn.age() < 1500 && Date.now() >= (this.quietSyncUntil || 0)) return false;
    session.touch();
    const fresh = store.Session.read(session.file);
    const old = this.agent.messages;
    const sig = (m) => `${m.role}|${m.tool_call_id || ''}|${String(m.content || '').length}|${(m.tool_calls || []).length}`;
    let same = 0;
    while (same < old.length && same < fresh.length && sig(old[same]) === sig(fresh[same])) same++;
    if (same === old.length && same === fresh.length) return false; // 내용은 그대로 (형식만 다시 쓴 경우)
    this.agent.messages = fresh;
    this.agent.resetUsage();
    if (Date.now() < (this.quietSyncUntil || 0)) return true; // 방금 실시간으로 보여 준 내용
    if (same < old.length) {
      // 앞부분까지 달라졌다 (앱에서 압축했거나 되돌린 경우): 통째로 다시 보여 준다.
      this.replay();
    } else {
      // 우리가 꺼져 있거나 다른 세션을 보던 사이에 쌓인 것: 여기서 한 것과 같은 모양으로 이어 그린다.
      let tools = 0;
      const flushTools = () => { if (tools) { this.say(c.dim(`  ⎿  도구 호출 ${tools}회`)); tools = 0; } };
      for (const m of fresh.slice(same)) {
        if (m.role === 'user') { flushTools(); this.echo(String(m._display != null ? m._display : m.content).split('\n').slice(0, 6).join('\n')); }
        else if (m.role === 'assistant') {
          tools += (m.tool_calls || []).length;
          if (m.content && m.content.trim()) { flushTools(); this.block(md.render(m.content, this.textWidth)); }
        }
      }
      flushTools();
    }
    this.render();
    return true;
  }

  get cols() { return this.screen.cols; }
  get textWidth() { return Math.max(20, this.cols - 4); }

  // ----- 출력 -----
  say(text = '') { this.screen.print(text); }
  /** "● 첫 줄 / 들여쓴 나머지 줄" 블록 */
  block(lines, bullet = c.white('●')) {
    this.say('');
    lines.forEach((l, i) => this.say((i ? '  ' : bullet + ' ') + l));
  }
  sub(lines, first = '⎿') {
    const all = lines.flatMap((l) => wrapAnsi(l, Math.max(20, this.cols - 7)));
    all.forEach((l, i) => this.say((i ? '     ' : c.dim('  ' + first + '  ')) + l));
  }

  // 접힌 보기에서는 같은 종류의 도구 호출이 이어지면 한 묶음으로 모아 한 줄로 보여 준다.
  flushGroup() {
    const g = this.group;
    this.group = null;
    if (!g || !g.items.length) return;
    const bad = g.items.filter((it) => !it.ok).length;
    const bullet = bad === g.items.length ? c.red('●') : bad ? c.warn('●') : c.green('●');
    if (g.items.length === 1) {
      const it = g.items[0];
      this.block([it.head], bullet);
      this.sub([it.error ? c.red(it.error) : it.text + (it.expandable ? c.dim(' (ctrl+o 로 펼치기)') : '')]);
      return;
    }
    this.block([c.bold(g.label) + ` ${g.items.length}회` + (bad ? c.red(` · 실패 ${bad}`) : '') + c.dim(' (ctrl+o 로 펼치기)')], bullet);
  }

  flushThinking() {
    if (!this.thinkAcc) return;
    const ms = this.thinkAcc;
    this.thinkAcc = 0;
    this.say('');
    this.say(c.dim(`∴ ${fmtElapsed(ms, true)} 동안 생각함 (ctrl+o 로 펼치기)`));
  }

  /** 모아 둔 묶음과 생각 시간을 기록 영역으로 내보낸다. */
  flushSteps() { this.flushGroup(); this.flushThinking(); }

  // ----- 화면 아래쪽 -----
  editorWidth() { return Math.max(10, Math.min(this.cols - 1, 200) - 6); }

  modeLine() {
    const f = MODE_TEXT[this.agent.mode];
    return f ? f() : '';
  }

  computeMenu() {
    const buf = this.editor.buf;
    if (buf.startsWith('/') && !/\s/.test(buf)) {
      const q = buf.toLowerCase();
      const all = this.commands.map((x) => ({ value: x.name, arg: x.arg || '', desc: x.desc })).concat(this.custom.map((x) => ({ value: x.name, arg: x.arg || '', desc: x.desc + c.dim(` (${x.source})`) })));
      const items = all.filter((x) => x.value.startsWith(q)).concat(all.filter((x) => !x.value.startsWith(q) && x.value.includes(q.slice(1))));
      return items.length ? { kind: 'slash', items } : null;
    }
    const m = /(^|\s)@([^\s]*)$/.exec(buf.slice(0, this.editor.cur));
    if (m) {
      const q = m[2].toLowerCase();
      const items = this.fileList().filter((f) => f.toLowerCase().includes(q)).sort((x, y) => x.length - y.length).slice(0, 30).map((f) => ({ value: f, desc: '' }));
      return items.length ? { kind: 'file', items, token: m[2] } : null;
    }
    return null;
  }

  fileList() {
    if (this.files && Date.now() - this.files.at < 8000) return this.files.list;
    const list = [];
    const skip = new Set(['node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv', '.idea', '.vs', '.next', 'dist', 'build']);
    const walk = (dir, rel, depth) => {
      if (list.length > 4000 || depth > 8) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) { list.push(r + '/'); walk(path.join(dir, e.name), r, depth + 1); } }
        else list.push(r);
      }
    };
    walk(this.cwd, '', 0);
    this.files = { at: Date.now(), list };
    return list;
  }

  render() {
    const cols = this.cols;
    const lines = [];
    let cursor = null;

    if (this.pending.length) {
      const tail = this.pending.slice(-8);
      tail.forEach((l, i) => lines.push((this.blockOpen || i || this.pending.length > 8 ? '  ' : c.white('●') + ' ') + l));
    }
    if (this.group && this.group.items.length) {
      const g = this.group, last = g.items[g.items.length - 1];
      lines.push('', c.dim('● ') + (g.items.length > 1 ? c.bold(g.label) + ` ${g.items.length}회` + c.dim('  최근: ') : '') + truncate(last.head, cols - 24));
    }
    if (this.running && !this.modalObj) {
      lines.push('', (this.frame % 8 < 4 ? c.dim('●') : c.white('●')) + ' ' + c.bold(this.running.title.label) + (this.running.title.arg ? `(${truncate(this.running.title.arg, cols - 20)})` : ''));
      if (this.verbose) for (const l of this.running.tail.slice(-5)) lines.push(c.dim('     ' + truncate(l, cols - 8)));
    }
    // 여기까지는 기록에 이어지는 진행 중 출력, 여기부터는 화면 맨 아래에 붙는 부분(진행 표시 · 입력창)
    const split = lines.length;
    lines.push('');
    if (this.busy && this.spinner && !this.modalObj) {
      const sp = this.spinner;
      if (sp.retry) {
        // ⎿  API 오류 (연결 오류) · 4초 후 다시 시도… (시도 2/10) · esc 로 중단
        lines.push(c.dim('  ⎿  ') + c.red(retry.label(sp.retry, sp.until - Date.now())) + c.dim(' · esc 로 중단'));
      } else {
        const bits = [fmtElapsed(Date.now() - sp.start)];
        if (sp.chars) bits.push(`↓ ${fmtK(sp.chars / 2.2)} 토큰`);
        bits.push('esc 로 중단');
        lines.push(c.brand(SPIN[this.frame % SPIN.length]) + ' ' + c.brand(sp.label + '…') + c.dim(` (${bits.join(' · ')})`));
      }
    }
    for (const q of this.queue) lines.push(c.dim('  ⏵ 대기 중: ' + truncate(q.replace(/\s+/g, ' '), cols - 16)));

    if (this.modalObj) {
      const r = this.modalObj.render(cols);
      if (r.cursor) cursor = { row: lines.length + r.cursor.row, col: r.cursor.col };
      lines.push(...r.lines);
      this.screen.draw(lines, cursor, split);
      return;
    }

    // 입력창: 가로줄 두 개 사이에 "> 입력". 윗줄 오른쪽에는 추론 강도를 보여 준다.
    const ed = this.editor;
    const width = cols - 1;
    const inner = Math.max(10, width - 3);
    const lay = ed.layout(inner);
    const bashMode = ed.buf.startsWith('!'), memMode = ed.buf.startsWith('#');
    const color = bashMode ? c.bash : memMode ? c.memory : c.dim;
    const maxRows = Math.max(3, this.screen.height - lines.length - 9);
    let from = 0;
    if (lay.rows.length > maxRows) from = Math.min(Math.max(0, lay.cr - maxRows + 1), lay.rows.length - maxRows);
    const rows = lay.rows.slice(from, from + maxRows);
    const mark = bashMode ? c.bash('!') : memMode ? c.memory('#') : '❯';
    // bash·메모리 모드에서는 맨 앞의 ! · # 가 프롬프트 기호 자리로 옮겨 간 것처럼 보이게 한다.
    const lead = bashMode || memMode ? 1 : 0;
    const body = rows.map((r, i) => (i + from === 0 ? mark + ' ' : '  ') + ((i + from === 0 ? r.text.slice(lead) : r.text) || (i + from === 0 && !ed.buf ? c.dim(this.busy ? '입력하면 지금 작업이 끝난 뒤 이어서 보냅니다' : this.placeholder()) : '')));
    // 명령만 입력한 상태면 커서 뒤에 인자 예시를 흐리게 보여 준다: /effort [low|medium|high|max]
    const hint = lay.rows.length === 1 ? this.argHint() : '';
    if (hint) body[0] += c.dim(truncate(hint, Math.max(0, width - 4 - strWidth(rows[0].text))));
    if (lines.length > split + 1) lines.push('');
    // 자동완성 목록(/ 명령 · @ 파일)은 입력 줄 위쪽에 띄운다. 입력창이 맨 아래에 붙어 있어 목록은 위로 자란다.
    this.menu = this.menuOff ? null : this.computeMenu();
    if (this.menu) {
      const items = this.menu.items;
      this.menuIdx = Math.min(this.menuIdx, items.length - 1);
      const start = Math.max(0, Math.min(this.menuIdx - 3, items.length - 7));
      // 명령 이름 옆에 인자 예시를 같이 보여 준다: /effort [low|medium|high|max]
      const label = (x) => x.value + (x.arg ? ' ' + x.arg : '');
      const nameW = Math.min(40, Math.max(...items.map((x) => strWidth(label(x)))) + 2);
      items.slice(start, start + 7).forEach((it, i) => {
        const on = i + start === this.menuIdx;
        const name = truncate(it.value, nameW);
        const arg = it.arg ? ' ' + truncate(it.arg, Math.max(0, nameW - strWidth(name) - 1)) : '';
        const pad = ' '.repeat(Math.max(0, nameW - strWidth(name) - strWidth(arg)));
        const desc = truncate(it.desc || '', Math.max(0, cols - nameW - 8));
        lines.push(on ? '  ' + c.brand(name) + c.dim(arg) + pad + '  ' + c.brand(desc) : c.dim('  ' + name + arg + pad + '  ' + desc));
      });
    } else {
      const eff = `● ${this.agent.cfg.effort}` + c.dim(' · /effort');
      lines.push(' '.repeat(Math.max(0, width - 3 - strWidth(eff))) + c.dim(eff));
    }
    const rule = color('─'.repeat(width));
    lines.push(rule);
    const top = lines.length;
    lines.push(...body, rule);
    cursor = { row: top + (lay.cr - from), col: 2 + Math.max(0, lay.cc - (lay.cr === 0 ? lead : 0)) };

    // 입력 줄 아래: 단축키 안내 또는 상태 줄
    if (this.showHelp && !this.menu) {
      lines.push(c.dim('  ! bash 모드            / 명령어             esc 중단 · esc 두 번 입력 지우기'));
      lines.push(c.dim('  # 메모리에 추가         @ 파일 경로          shift+tab 권한 모드 전환'));
      lines.push(c.dim('  \\⏎ · alt+⏎ 줄바꿈      ctrl+o 자세히 보기    ctrl+c 지우기 · 두 번 종료   ctrl+l 화면 정리'));
    } else {
      // 입력창 아래 한 줄: 왼쪽에 권한 모드(기본 모드에서는 단축키 안내), 오른쪽에 그 밖의 상태
      const left = this.hint || (bashMode ? c.bash('! bash 모드') : memMode ? c.memory('# 메모리에 추가') : (this.modeLine() || c.dim('? 단축키 보기')));
      const pct = this.agent.contextPct();
      const leftPct = this.agent.compactLeftPct();
      const ctx = leftPct != null && leftPct <= 20 ? c.warn(`자동 압축까지 컨텍스트 ${leftPct.toFixed(0)}% 남음`) : pct >= 50 ? c.dim(`컨텍스트 ${pct.toFixed(0)}% 사용`) : '';
      const right = [this.verbose ? c.dim('자세히 보기 켜짐') : '', ctx].filter(Boolean).join(c.dim(' · '));
      const gap = Math.max(2, width - 5 - strWidth(left) - strWidth(right));
      lines.push('  ' + left + ' '.repeat(gap) + right);
    }
    this.screen.draw(lines, cursor, split);
  }

  /** 화면과 스크롤 기록을 지우고 커서를 맨 위로 옮긴다. */
  clearScreen() {
    process.stdout.write('\x1b[H\x1b[2J\x1b[3J');
    this.screen.reset();
  }

  placeholder() {
    return this.agent.messages.length ? '' : '예: "이 폴더가 어떤 프로젝트인지 설명해줘"';
  }

  // ----- 모달 -----
  async modal(m) {
    const prev = this.modalObj;
    this.modalObj = m;
    this.render();
    const v = await m.promise;
    this.modalObj = prev;
    this.render();
    return v;
  }
  select(opts) { return this.modal(new SelectModal(opts)); }
  input(opts) { return this.modal(new InputModal(opts)); }

  // ----- 키 -----
  onKey(str, key) {
    const k = key || {};
    if (this.modalObj) { this.modalObj.onKey(str, key); if (this.modalObj) this.render(); return; }
    this.hint = null;
    const ed = this.editor;

    if (k.ctrl && k.name === 'c') {
      if (this.busy) { this.interrupt(); }
      else if (ed.buf) { ed.clear(); this.ctrlC = 0; }
      else if (Date.now() - this.ctrlC < 2000) return this.exit();
      else { this.ctrlC = Date.now(); this.hint = c.dim('종료하려면 ctrl+c 를 한 번 더 누르세요'); }
      return this.render();
    }
    if (k.ctrl && k.name === 'd') { if (!ed.buf) return this.exit(); return this.render(); }
    if (k.ctrl && k.name === 'l') { this.clearScreen(); return this.render(); }
    if (k.ctrl && k.name === 'o') { this.toggleVerbose(); return this.render(); }
    if (k.shift && k.name === 'tab') { this.cycleMode(); return this.render(); }
    if (k.name === 'escape') {
      if (this.menu) this.menuOff = true;
      else if (this.busy) this.interrupt();
      else if (ed.buf) { if (Date.now() - this.lastEsc < 800) ed.clear(); else { this.lastEsc = Date.now(); this.hint = c.dim('esc 를 한 번 더 누르면 입력을 지웁니다'); } }
      this.showHelp = false;
      return this.render();
    }

    const pasting = ed.pasting != null || k.name === 'paste-start' || k.name === 'paste-end';
    if (!pasting && this.menu) {
      const n = this.menu.items.length;
      if (k.name === 'up') { this.menuIdx = (this.menuIdx - 1 + n) % n; return this.render(); }
      if (k.name === 'down') { this.menuIdx = (this.menuIdx + 1) % n; return this.render(); }
      if (k.name === 'tab' || (k.name === 'return' && !k.meta)) {
        const it = this.menu.items[this.menuIdx];
        if (this.menu.kind === 'file') {
          const before = ed.buf.slice(0, ed.cur).replace(/@([^\s]*)$/, '@' + it.value + (it.value.endsWith('/') ? '' : ' '));
          ed.buf = before + ed.buf.slice(ed.cur); ed.cur = before.length;
          return this.render();
        }
        const exact = ed.buf === it.value;
        ed.set(it.value + ' ');
        this.menuIdx = 0;
        if (k.name === 'return' && (exact || !this.needsArg(it.value))) return this.submit();
        return this.render();
      }
    }
    if (!pasting && k.name === 'return' && !k.meta) {
      if (ed.buf.endsWith('\\')) { ed.buf = ed.buf.slice(0, -1); ed.cur = Math.min(ed.cur, ed.buf.length); ed.insert('\n'); return this.render(); }
      return this.submit();
    }
    if (!pasting && k.name === 'up') { if (!ed.moveVertical(-1, this.editorWidth())) ed.historyMove(-1); return this.render(); }
    if (!pasting && k.name === 'down') { if (!ed.moveVertical(1, this.editorWidth())) ed.historyMove(1); return this.render(); }
    if (!pasting && str === '?' && !ed.buf) { this.showHelp = !this.showHelp; return this.render(); }
    if (ed.key(str, key, this.editorWidth())) { this.menuIdx = 0; this.showHelp = false; this.menuOff = false; }
    return this.render();
  }

  /** 명령만 입력한 상태(/effort 또는 "/effort ")면 그 명령의 인자 예시. 입력 줄에서 커서 뒤에 흐리게 보여 준다. */
  argHint() {
    const ed = this.editor;
    const m = /^(\/\S+)\s*$/.exec(ed.buf);
    if (!m || ed.cur !== ed.buf.length) return '';
    const name = m[1].toLowerCase();
    const cmd = this.commands.find((x) => x.name === name) || this.custom.find((x) => x.name === name);
    if (!cmd || !cmd.arg) return '';
    const spaced = /\s$/.test(ed.buf);
    if (!spaced && !this.menuOff) return ''; // 목록이 떠 있는 동안에는 목록의 그 줄에 예시가 보인다
    return (spaced ? '' : ' ') + cmd.arg;
  }

  needsArg(name) { const cmd = this.commands.find((x) => x.name === name); return !!(cmd && cmd.arg); }

  submit() {
    const text = this.editor.expanded().trim();
    if (!text) return this.render();
    this.editor.hist.push(this.editor.buf.trim());
    store.appendHistory(this.cwd, this.editor.buf.trim());
    this.editor.clear();
    this.showHelp = false;
    // 상대 쪽(데스크톱 앱)이 작업 중일 때 넣은 입력은 그 작업이 끝난 뒤에 보낸다.
    if (this.waiter && !this.remote) { const w = this.waiter; this.waiter = null; w(text); }
    else this.queue.push(text);
    return this.render();
  }

  nextInput() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((res) => { this.waiter = res; });
  }

  interrupt() {
    // 상대 쪽(데스크톱 앱)이 실행 중인 작업이면 그쪽에 중단을 요청한다.
    if (this.remote) { if (this.liveIn) this.liveIn.requestStop(); return; }
    if (this.busy) { this.interrupted = true; this.agent.abort(); }
  }

  cycleMode() {
    const order = ['default', 'acceptEdits', 'plan'].concat(this.opt.allowBypass ? ['bypassPermissions'] : []);
    const i = order.indexOf(this.agent.mode);
    this.agent.cfg.mode = order[(i + 1) % order.length];
  }

  toggleVerbose() {
    this.verbose = !this.verbose;
    if (this.verbose) this.printDetails();
    else this.hint = c.dim('자세히 보기를 껐습니다 (ctrl+o 로 다시 켜기)');
  }

  /** 마지막 지시의 추론 내용과 도구 출력 원문을 펼쳐서 보여 준다. */
  printDetails() {
    const items = this.agent.turnDetails || [];
    if (!items.length) { this.hint = c.dim('자세히 보기를 켰습니다 — 다음 작업부터 추론과 도구 출력을 펼쳐서 보여 줍니다'); return; }
    this.say('');
    this.say(c.dim('─── 직전 작업 자세히 보기 ' + '─'.repeat(Math.max(4, this.cols - 30))));
    for (const it of items) {
      if (it.kind === 'thinking') { this.say(c.dim('∴ 추론' + (it.ms ? ` · ${fmtElapsed(it.ms, true)}` : ''))); for (const l of wrapAnsi(it.content.trim(), this.textWidth)) this.say(c.dim(c.italic('  ' + l))); }
      else {
        this.say(c.bold(it.title.label) + (it.title.arg ? `(${truncate(it.title.arg, this.cols - 16)})` : ''));
        if (it.meta && it.meta.diff) for (const l of diffLines(it.meta.diff, Math.max(20, this.cols - 6), 200)) this.say('  ' + l);
        else for (const l of String(it.content).replace(/\n+$/, '').split('\n').slice(0, 200)) this.say(c.dim('  ' + truncate(l, this.cols - 4)));
      }
    }
    this.say(c.dim('─'.repeat(Math.max(10, this.cols - 4))));
  }

  // ----- 에이전트 → 화면 -----
  ui() {
    const app = this;
    const spin = (label) => { const chars = app.spinner ? app.spinner.chars : 0; app.spinner = { label, start: app.spinner ? app.spinner.start : Date.now(), chars }; };
    return {
      requestStart() { if (!app.spinner) app.spinner = { label: '응답 기다리는 중', start: Date.now(), chars: 0 }; else spin('응답 기다리는 중'); app.render(); },
      thinkingStart() { spin(VERBS[Math.floor(Math.random() * VERBS.length)]); },
      reasoning(d) { if (app.spinner) app.spinner.chars += d.length; },
      thinkingEnd(ms, text) {
        app.blockOpen = false;
        if (!app.verbose) { app.thinkAcc = (app.thinkAcc || 0) + ms; return; } // 접힌 보기: 시간만 모아 둔다
        app.say('');
        app.say(c.dim(`∴ ${fmtElapsed(ms, true)} 동안 생각함`));
        for (const l of wrapAnsi(text.trim(), app.textWidth)) app.say(c.dim(c.italic('  ' + l)));
      },
      contentStart() {
        app.flushSteps();
        let first = true;
        app.say('');
        app.stream = new md.MdStream((l) => { app.say((first ? c.white('●') + ' ' : '  ') + l); first = false; app.blockOpen = true; }, () => app.textWidth);
        app.blockOpen = false;
        spin('답변 쓰는 중');
      },
      content(d) { if (app.spinner) app.spinner.chars += d.length; app.stream.push(d); app.pending = app.stream.pending(); app.render(); },
      contentEnd() { if (app.stream) { app.stream.end(); app.stream = null; } app.pending = []; app.blockOpen = false; app.render(); },
      toolBuilding(tc) { spin(`${toolTitle(tc.name, {}).label} 호출 준비 중`); if (app.spinner) app.spinner.chars = (app.spinner.chars || 0) + 8; },
      toolStart(tc, a, title) { app.running = { title, tail: [] }; spin(`${title.label} 실행 중`); app.render(); },
      toolOutput(chunk) { if (!app.running) return; const t = app.running.tail; t.push(...String(chunk).replace(/\r/g, '').split('\n').filter(Boolean)); if (t.length > 40) t.splice(0, t.length - 40); },
      toolEnd(tc, a, res, title) {
        app.running = null;
        if (res.silent) return;
        const s = toolSummary(tc.name, a, res);
        const head = c.bold(title.label) + (title.arg ? `(${truncate(title.arg, Math.max(20, app.cols - strWidth(title.label) - 8))})` : '');
        const detail0 = toolDetail(tc.name, a, res, Math.max(20, app.cols - 8));
        if (!app.verbose && tc.name !== 'update_plan' && tc.name !== 'ask_user') {
          // 접힌 보기: 같은 도구가 이어지면 한 묶음으로
          if (app.group && app.group.name !== tc.name) app.flushGroup();
          if (!app.group) app.group = { name: tc.name, label: title.label, items: [] };
          app.group.items.push({ head, ok: !!res.ok, text: s.text, error: s.error, expandable: detail0.length > 0 });
          return app.render();
        }
        app.flushSteps();
        app.block([head], res.ok ? c.green('●') : c.red('●'));
        if (tc.name === 'update_plan' && res.ok) app.sub(todoLines(a.steps));
        else if (s.error) app.sub([c.red(truncate(s.error, app.cols - 8))]);
        else {
          const detail = toolDetail(tc.name, a, res, Math.max(20, app.cols - 8));
          const canExpand = detail.length > 0;
          app.sub([s.text + (canExpand && !app.verbose ? c.dim(' (ctrl+o 로 펼치기)') : '')]);
          if (app.verbose) for (const l of detail) app.say('     ' + l);
        }
        app.render();
      },
      async permission({ tc, a, def, title, prefix }) {
        const w = Math.min(app.cols - 1, 110) - 4;
        let m;
        if (def.category === 'write') {
          const isNew = tc.name === 'write_file';
          const preview = isNew
            ? diffLines(String(a.content || '').replace(/\n$/, '').split('\n').map((l) => '+' + l).join('\n'), w, 14)
            : diffLines(String(a.old_string || '').split('\n').map((l) => '-' + l).concat(String(a.new_string || '').split('\n').map((l) => '+' + l)).join('\n'), w, 18);
          m = new SelectModal({
            title: isNew ? '파일 작성' : '파일 수정', color: c.accept, lines: [c.bold(String(a.path || '')), { raw: preview }],
            question: `${a.path} 을(를) 이렇게 ${isNew ? '작성' : '수정'}할까요?`,
            options: [{ label: '예' }, { label: '예, 이 세션에서는 파일 편집을 모두 허용 ' + c.dim('(shift+tab)') }, { label: '아니오, 어떻게 할지 알려 주기 ' + c.dim('(esc)') }],
            keys: { shiftTab: 1 }, cancel: 3,
          });
        } else if (def.category === 'exec') {
          m = new SelectModal({
            title: 'Bash 명령', color: c.bash, lines: ['  ' + String(a.command || '')],
            question: '이 명령을 실행할까요?',
            options: [{ label: '예' }, { label: `예, 이 폴더에서 ${c.bold(prefix)} 명령은 다시 묻지 않기` }, { label: '아니오, 어떻게 할지 알려 주기 ' + c.dim('(esc)') }],
            cancel: 3,
          });
        } else {
          let host = '';
          try { host = new URL(a.url).hostname; } catch { /* 형식 오류 */ }
          m = new SelectModal({
            title: '웹 요청', color: c.plan, lines: ['  ' + String(a.url || '')],
            question: '이 주소의 내용을 가져올까요?',
            options: [{ label: '예' }, { label: `예, ${c.bold(host || '이 사이트')} 는 다시 묻지 않기` }, { label: '아니오, 어떻게 할지 알려 주기 ' + c.dim('(esc)') }],
            cancel: 3,
          });
        }
        const v = await app.modal(m);
        if (v === 0) return { decision: 'allow' };
        if (v === 1) return { decision: 'always' };
        if (v === 2) {
          const text = await app.input({ title: 'EXAONE 에게 전할 말', hint: 'enter 로 전달 · 비워 두거나 esc 를 누르면 그냥 거부' });
          return { decision: 'deny', feedback: text && text.trim() ? text.trim() : null };
        }
        return { decision: 'deny' };
      },
      /** 사용자에게 질문하기: 질문을 하나씩 선택 상자로 보여 주고 답을 모은다. 닫으면 null. */
      async askUser(questions) {
        app.flushSteps();
        const answers = [];
        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi];
          const n = q.options.length;
          const title = (questions.length > 1 ? `질문 ${qi + 1}/${questions.length}` : '질문') + (q.header ? ' · ' + q.header : '');
          const label = (o) => o.label + (o.description ? c.dim(' — ' + o.description) : '');
          let answer = null;
          if (!q.multi) {
            const v = await app.select({ title, color: c.brand, question: q.question, options: q.options.map((o) => ({ label: label(o) })).concat([{ label: c.dim('직접 입력…') }]), cancel: -1 });
            if (v === -1) return null;
            if (v === n) { const t = await app.input({ title: q.question }); if (!t || !t.trim()) return null; answer = t.trim(); }
            else answer = q.options[v].label;
          } else {
            // 여러 개 고르기: 누를 때마다 표시를 바꾸고 "선택 완료" 로 끝낸다.
            const picked = new Set();
            let custom = '', at = 0;
            for (;;) {
              const opts = q.options.map((o, i) => ({ label: (picked.has(i) ? '☒ ' : '☐ ') + label(o) }))
                .concat([{ label: c.dim(custom ? `직접 입력: ${custom}` : '직접 입력…') }, { label: c.bold('선택 완료') }]);
              const v = await app.select({ title, color: c.brand, question: q.question + c.dim(' (여러 개 선택 가능)'), options: opts, cancel: -1, index: at });
              if (v === -1) return null;
              at = v;
              if (v < n) { if (picked.has(v)) picked.delete(v); else picked.add(v); }
              else if (v === n) { const t = await app.input({ title: q.question, initial: custom }); custom = t ? t.trim() : ''; }
              else if (picked.size || custom) break;
            }
            answer = [...picked].sort((x, y) => x - y).map((i) => q.options[i].label).concat(custom ? [custom] : []).join(', ');
          }
          answers.push(answer);
        }
        return answers;
      },
      async approvePlan(plan) {
        app.flushSteps();
        app.say('');
        app.say(c.plan('● ') + c.bold('계획'));
        for (const l of md.render(plan, app.textWidth - 2)) app.say('  ' + c.dim('│ ') + l);
        const v = await app.select({
          title: '계획대로 진행할까요?', color: c.plan,
          options: [{ label: '예, 파일 편집은 자동으로 허용' }, { label: '예, 편집할 때마다 확인' }, { label: '아니오, 계획을 더 다듬기' }], cancel: 2,
        });
        return v === 0 ? 'accept' : v === 1 ? 'ask' : 'keep';
      },
      error(msg) { app.flushSteps(); app.block(wrapAnsi(c.red(msg), app.textWidth), c.red('●')); },
      notice(msg) { app.flushSteps(); app.say(c.warn('  ⎿  ' + msg)); },
      // 요청 한도에 걸려 다시 시도할 때: 남은 시간을 진행 표시 줄에서 줄여 가며 보여 준다.
      // 네트워크 문제·요청 한도 등으로 다시 시도할 때: Claude Code 처럼 원인과 남은 시간, 몇 번째 시도인지를 진행 표시 줄에서 줄여 가며 보여 준다.
      retryWait(ms, info) {
        if (app.stream) { try { app.stream.end(); } catch { /* 무시 */ } app.stream = null; }
        app.flushSteps(); app.pending = []; app.running = null;
        app.spinner = { retry: info || { reason: '요청 한도 초과', attempt: 1, max: 1 }, start: Date.now(), chars: 0, until: Date.now() + ms };
        app.render();
      },
      compactStart() { app.flushSteps(); app.pending = []; app.running = null; app.spinner = { label: '대화가 길어져 이전 내용을 압축하는 중', start: Date.now(), chars: 0 }; app.render(); },
      compactEnd(r) {
        app.spinner = null;
        if (r && r.error) app.say(c.warn('  ⎿  대화 압축 실패: ' + r.error + (r.gaveUp ? ' — 연달아 실패해 자동 압축을 멈춥니다 (/compact 로 직접 실행 가능)' : '')));
        else if (r) { app.block([`이전 대화 ${r.before}개 메시지를 요약으로 압축했습니다 ${c.dim('(컨텍스트 한도에 가까워져 자동 압축)')}`], c.green('●')); app.blockOpen = false; }
        app.render();
      },
      interrupted() { app.flushSteps(); app.say(c.red('  ⎿  사용자가 중단했습니다')); },
      modeChanged() { app.render(); },
      turnEnd(st) {
        app.flushSteps();
        const at = new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
        const bits = [`${fmtElapsed(st.ms, true)} 동안 작업`, `입력 ${fmtK(st.prompt || 0)}`, `출력 ${fmtK(st.completion || 0)}` + (st.reasoning ? ` (추론 ${fmtK(st.reasoning)})` : ''), at];
        app.say('');
        app.say(c.dim('✻ ' + bits.join(' · ')));
      },
    };
  }

  // ----- 한 번의 입력 처리 -----
  async handle(text) {
    if (text.startsWith('/')) return this.command(text);
    if (text.startsWith('!')) return this.bash(text.slice(1).trim());
    if (text.startsWith('#')) return this.remember(text.slice(1).trim());
    return this.prompt(text);
  }

  /** 사용자가 입력한 글: 화면 폭을 채운 회색 바탕 줄에 "❯ 글" 로 또렷하게 남긴다. */
  echo(text) {
    const w = this.cols - 1;
    this.say('');
    wrapAnsi(text, Math.max(10, w - 3)).forEach((l, i) => this.say(c.bgUser(c.bold(c.white(padEnd((i ? '  ' : '❯ ') + l, w))))));
  }

  /** 등록된 토큰을 다시 읽어 온다 (데스크톱 앱에서 방금 등록했을 수 있다). */
  refreshKey() {
    this.keyInfo = store.findKey(this.cwd);
    this.agent.key = this.keyInfo.key;
    return !!this.keyInfo.key;
  }

  /**
   * 토큰 등록으로 이끈다: 데스크톱 앱에서 등록하거나 여기서 바로 입력한다. 어느 쪽이든 앱과 터미널이 함께 쓴다.
   * change 가 참이면 이미 등록돼 있어도 바꿀 수 있게 묻는다. 등록된 토큰이 있으면 true.
   */
  async ensureKey({ change = false } = {}) {
    if (this.refreshKey() && !change) return true;
    const v = await this.select({
      title: 'EXAONE 토큰 등록', color: c.brand,
      lines: [this.keyInfo.key ? '등록된 토큰을 바꿉니다.' : 'EXAONE Code 를 쓰려면 토큰(API 키)을 먼저 등록해야 합니다.', c.dim('한 번 등록하면 데스크톱 앱과 터미널이 함께 씁니다.')],
      options: [{ label: '데스크톱 앱에서 등록 ' + c.dim('(앱의 토큰 등록 화면을 엽니다)') }, { label: '여기서 바로 입력' }, { label: '나중에' }], cancel: 2,
    });
    if (v === 0) return this.registerViaDesktop();
    if (v === 1) {
      const k = await this.input({ title: 'EXAONE 토큰(API 키) 입력', mask: true, hint: '붙여넣고 enter · 데스크톱 앱에도 함께 적용됩니다 · esc 로 취소' });
      if (!k || !k.trim()) return !!this.keyInfo.key;
      store.saveKey(k.trim().split(/\s+/)[0]);
      this.refreshKey();
      this.say('');
      this.say(c.green('  ✔ ') + '토큰을 등록했습니다. 데스크톱 앱에서도 바로 쓸 수 있습니다.');
      return true;
    }
    if (!this.keyInfo.key) { this.say(''); this.say(c.dim('  토큰을 등록하지 않았습니다. ') + c.code('/login') + c.dim(' 으로 언제든 등록할 수 있습니다.')); }
    return !!this.keyInfo.key;
  }

  /** 데스크톱 앱의 토큰 등록 화면을 띄우고, 등록될 때까지 기다린다 (esc 로 그만둘 수 있다). */
  async registerViaDesktop() {
    const before = this.keyInfo.key;
    const r = store.openDesktopApp(['--register-token']);
    this.say('');
    if (r.ok) this.say(c.dim('  데스크톱 앱을 열었습니다. 앱에 뜬 "EXAONE 토큰 등록" 창에 토큰을 넣고 등록하세요.'));
    else this.say(c.warn('  데스크톱 앱을 자동으로 열지 못했습니다: ' + r.reason) + c.dim('\n  앱을 직접 실행해 설정 → 연결에서 토큰을 등록하면 여기서 이어집니다.'));
    let cancelled = false;
    this.busy = true; this.interrupted = false;
    this.spinner = { label: '데스크톱 앱에서 토큰 등록을 기다리는 중', start: Date.now(), chars: 0 };
    this.agent.current = { abort: () => { cancelled = true; } };
    this.render();
    while (!cancelled) {
      const k = store.findKey(this.cwd).key;
      if (k && k !== before) break;
      await new Promise((res) => setTimeout(res, 700));
    }
    this.agent.current = null; this.agent.aborted = false;
    this.busy = false; this.spinner = null;
    const ok = this.refreshKey() && this.keyInfo.key !== before;
    this.say(ok ? c.green('  ✔ ') + '토큰이 등록되었습니다.' : c.dim('  토큰 등록을 기다리다 그만두었습니다. ') + c.code('/login') + c.dim(' 으로 다시 할 수 있습니다.'));
    this.render();
    return !!this.keyInfo.key;
  }

  async prompt(text, shown) {
    this.syncSession(); // 방금 데스크톱 앱에서 이어 쓴 것이 있으면 먼저 불러온다
    // 토큰이 없으면 보내기 전에 등록부터 하게 한다.
    if (!this.agent.key && !(await this.ensureKey())) return;
    this.echo(shown || text);
    // @파일 언급은 내용을 붙여서 보낸다.
    let full = text;
    const seen = new Set();
    for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
      const rel = m[1].replace(/[.,;:!?)]+$/, '');
      if (seen.has(rel)) continue;
      seen.add(rel);
      try {
        const abs = tools.resolveIn(this.cwd, rel);
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          const names = fs.readdirSync(abs).slice(0, 200);
          full += `\n\n<directory path="${rel}">\n${names.join('\n')}\n</directory>`;
          this.sub([`${rel} 목록 (${names.length}개 항목)`]);
        } else if (st.size <= 400 * 1024) {
          const body = tools.decodeText(fs.readFileSync(abs));
          full += `\n\n<file path="${rel}">\n${body}\n</file>`;
          this.sub([`${rel} 읽음 (${fmtNum(body.split('\n').length)}줄)`]);
        } else this.sub([c.warn(`${rel} 은(는) 너무 커서 첨부하지 않았습니다`)]);
      } catch { /* 파일이 아니면 그냥 글자로 둔다 */ }
    }
    this.busy = true; this.interrupted = false; this.spinner = null;
    this.render();
    this.liveWriter().begin({ display: shown || text, base: this.agent.messages.length });
    try { await this.agent.turn(full, { display: shown || text }); }
    catch (e) { this.block([c.red(String(e && e.message || e))], c.red('●')); }
    if (this.liveOut) this.liveOut.end();
    this.busy = false; this.spinner = null; this.pending = []; this.running = null;
    this.render();
  }

  async bash(cmd) {
    if (!cmd) return;
    this.say('');
    this.say(c.bash('! ') + cmd);
    this.busy = true; this.spinner = { label: '명령 실행 중', start: Date.now(), chars: 0 };
    this.render();
    const id = 'bash_' + Date.now();
    this.agent.current = { abort: () => tools.cancel(id) };
    const res = await tools.run('run_command', { command: cmd }, { workspace: this.cwd, callId: id, shell: 'auto', commandTimeout: 300, fetchImpl: fetch });
    this.agent.current = null;
    this.busy = false; this.spinner = null;
    const lines = String(res.content).replace(/\n+$/, '').split('\n');
    this.sub(lines.slice(0, 40).map((l) => truncate(l, this.cols - 8)));
    if (lines.length > 40) this.say(c.dim(`     … +${lines.length - 40}줄`));
    // 모델도 결과를 알 수 있게 대화에 남긴다.
    this.agent.push({ role: 'user', content: `<bash-input>${cmd}</bash-input>\n<bash-output>\n${res.content}\n</bash-output>`, _display: '! ' + cmd });
    this.agent.push({ role: 'assistant', content: '(명령 결과를 확인했습니다.)' });
  }

  async remember(text) {
    if (!text) return;
    const files = store.memoryFiles(this.cwd).filter((f) => f.scope !== 'parent');
    const v = await this.select({
      title: '어디에 기억할까요?', color: c.memory,
      options: files.map((f) => ({ label: `${f.label}  ${c.dim(f.path)}` })), cancel: -1,
    });
    if (v < 0) return;
    store.appendMemory(files[v].path, text);
    this.say('');
    this.say(c.memory('# ') + text);
    this.sub([`${files[v].label}에 저장했습니다 ${c.dim('(' + files[v].path + ')')}`]);
  }

  async doCompact(instructions) {
    this.busy = true; this.spinner = { label: '대화 압축 중', start: Date.now(), chars: 0 };
    this.render();
    const r = await this.agent.compact(instructions);
    this.busy = false; this.spinner = null;
    if (!r) this.say(c.dim('  압축할 대화가 없습니다.'));
    else if (r.error) this.say(c.red('  압축 실패: ' + r.error));
    else { this.block([`대화 ${r.before}개 메시지를 요약으로 압축했습니다 ${this.verbose ? '' : c.dim('(ctrl+o 로 요약 보기)')}`], c.green('●')); this.agent.turnDetails = [{ kind: 'thinking', content: r.summary }]; }
    this.render();
  }

  // ----- 슬래시 명령 -----
  buildCommands() {
    const app = this;
    const agent = () => app.agent;
    const info = (lines) => { app.say(''); for (const l of lines) app.say('  ' + l); };
    return [
      { name: '/help', desc: '도움말과 명령 목록', run() {
        info([c.bold(`EXAONE Code v${pkg.version}`), '',
          c.bold('입력'), '  / 명령 · @ 파일 언급 · ! 셸 명령 바로 실행 · # 메모리에 추가',
          '  \\⏎ 또는 alt+⏎ 줄바꿈 · ↑↓ 이전 입력 · esc 중단 · shift+tab 권한 모드 · ctrl+o 자세히 보기', '',
          c.bold('명령'),
          ...app.commands.map((x) => '  ' + padEnd(c.brand(x.name) + (x.arg ? c.dim(' ' + x.arg) : ''), 30) + c.dim(x.desc)),
          ...(app.custom.length ? ['', c.bold('사용자 정의 명령'), ...app.custom.map((x) => '  ' + padEnd(c.brand(x.name), 30) + c.dim(x.desc))] : [])]);
      } },
      { name: '/clear', desc: '대화를 비우고 새 세션 시작', run() {
        agent().messages = []; agent().todos = null; agent().resetUsage(); agent().turnDetails = [];
        agent().session = new store.Session(app.cwd);
        app.clearScreen();
        app.banner();
      } },
      { name: '/compact', arg: '[추가 지시]', desc: '대화를 요약으로 압축해 컨텍스트 확보', run: (arg) => app.doCompact(arg) },
      { name: '/config', desc: '설정 보기·바꾸기', async run() {
        for (;;) {
          const items = [
            ['추론 강도', agent().cfg.effort],
            ['기본 권한 모드', app.settings.permissions.defaultMode || 'default'],
            ['자세히 보기 (추론·도구 출력 펼침)', app.verbose ? '켜짐' : '꺼짐'],
            ['긴 대화 자동 압축', agent().cfg.autoCompact !== false ? '켜짐' : '꺼짐'],
          ];
          const v = await app.select({ title: '설정', options: items.map(([k, val]) => ({ label: `${padEnd(k, 34)} ${c.brand(val)}` })).concat([{ label: '닫기' }]), cancel: items.length });
          if (v === 0) { const e = ['low', 'medium', 'high', 'max']; const i = await app.select({ title: '추론 강도', options: e.map((x) => ({ label: x })), cancel: -1 }); if (i >= 0) { agent().cfg.effort = e[i]; store.saveUserSetting('effort', e[i]); } }
          else if (v === 1) { const m = ['default', 'acceptEdits', 'plan']; const i = await app.select({ title: '시작할 때의 권한 모드', options: [{ label: 'default — 편집·명령마다 확인' }, { label: 'acceptEdits — 파일 편집은 자동 허용' }, { label: 'plan — 계획부터 세우기' }], cancel: -1 }); if (i >= 0) { app.settings.permissions.defaultMode = m[i]; const s = store.readJson(store.settingsFiles(app.cwd).user, {}); s.permissions = { ...(s.permissions || {}), defaultMode: m[i] }; store.writeJson(store.settingsFiles(app.cwd).user, s); } }
          else if (v === 2) { app.verbose = !app.verbose; store.saveUserSetting('verbose', app.verbose); }
          else if (v === 3) { agent().cfg.autoCompact = agent().cfg.autoCompact === false; store.saveUserSetting('autoCompact', agent().cfg.autoCompact); }
          else break;
        }
      } },
      { name: '/context', desc: '컨텍스트 사용량', run() {
        const used = agent().totals.lastPrompt, pct = used / CTX_LIMIT * 100;
        const n = 40, fill = Math.round(Math.min(100, pct) / 100 * n);
        const sys = Math.round(agent().systemPrompt().length / 2.5), tl = Math.round(JSON.stringify(agent().toolDefs()).length / 3.5);
        info([c.bold('컨텍스트 사용량'), '', '  ' + c.brand('█'.repeat(fill)) + c.dim('░'.repeat(n - fill)) + `  ${fmtNum(used)} / ${fmtNum(CTX_LIMIT)} 토큰 (${pct.toFixed(1)}%)`, '',
          c.dim(`  시스템 프롬프트·메모리 약 ${fmtNum(sys)} 토큰 · 도구 정의 약 ${fmtNum(tl)} 토큰 · 메시지 ${agent().messages.length}개`),
          c.dim(used ? '  (마지막 요청의 실제 사용량 기준)' : '  (아직 요청 전이라 실제 사용량이 없습니다)'),
          c.dim(agent().cfg.autoCompact !== false
            ? `  자동 압축 기준 ${fmtNum(agent().compactThreshold())} 토큰 (창 ${fmtNum(CTX_LIMIT)} − 요약용 ${fmtNum(COMPACT_RESERVE)} − 여유 ${fmtNum(COMPACT_BUFFER)}) · 남은 여유 ${agent().compactLeftPct().toFixed(0)}%`
            : '  자동 압축 꺼짐 (/config 에서 켜기, /compact 로 직접 실행)')]);
      } },
      { name: '/cost', desc: '이 세션의 토큰·요청·시간', run() {
        const t = agent().totals, r = agent().rate || {};
        info([c.bold('세션 사용량'), `  요청 ${fmtNum(t.requests)}회 · API 시간 ${fmtElapsed(t.apiMs)}`, `  출력 ${fmtNum(t.completion)} 토큰 (추론 ${fmtNum(t.reasoning)}) · 마지막 요청 컨텍스트 ${fmtNum(t.lastPrompt)} 토큰`,
          r['x-day-rate-limit'] ? `  오늘 남은 요청 ${r['x-day-rate-limit-remaining']} / ${r['x-day-rate-limit']} · 분당 ${r['x-minute-rate-limit-remaining']} / ${r['x-minute-rate-limit']}` : c.dim('  요청 한도는 첫 응답 뒤에 표시됩니다'),
          c.dim('  현재 EXAONE API 는 무료로 제공되어 금액은 계산하지 않습니다')]);
      } },
      { name: '/diff', desc: '이 세션에서 바뀐 파일과 변경 내용', run() {
        const files = app.history.summary(agent().session.id, app.cwd).files.filter((f) => f.status !== 'unchanged');
        if (!files.length) return info([c.dim('이 세션에서 바뀐 파일이 없습니다.')]);
        for (const f of files) {
          app.block([c.bold(f.path) + '  ' + c.dim({ added: '새 파일', modified: '수정', deleted: '삭제' }[f.status]) + '  ' + c.green('+' + f.added) + ' ' + c.red('−' + f.removed)], c.dim('●'));
          for (const l of diffLines(app.history.diff(agent().session.id, app.cwd, f.path, 0, 'disk').text, Math.max(20, app.cols - 8), 80)) app.say('     ' + l);
        }
      } },
      { name: '/doctor', desc: '설치·연결 상태 점검', async run() {
        const lines = [c.bold('점검')];
        const ok = (b, t) => lines.push((b ? c.green('  ✔ ') : c.red('  ✘ ')) + t);
        const major = Number(process.versions.node.split('.')[0]);
        ok(major >= 22, `Node.js ${process.versions.node}` + (major >= 22 ? '' : ' — 22 이상이 필요합니다'));
        ok(app.refreshKey(), app.keyInfo.key ? `토큰: ${app.keyInfo.source}` : '토큰이 등록되어 있지 않습니다 — /login 으로 등록하세요');
        try { const r = await fetch(agent().cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) }); ok(r.status < 500, `API 서버 응답: HTTP ${r.status} (${agent().cfg.baseUrl}) — 키 없이 보낸 점검 요청이라 401 이 정상입니다`); }
        catch (e) { ok(false, `API 서버에 연결하지 못했습니다 (${agent().cfg.baseUrl}): ${e.cause && e.cause.code || e.message}`); }
        ok(true, `셸: ${agent().shell} · 터미널 ${app.cols}×${app.screen.height}`);
        ok(true, `설정 폴더: ${store.HOME}`);
        const f = store.settingsFiles(app.cwd);
        for (const [k, p] of Object.entries(f)) lines.push(c.dim(`    ${k} 설정: ${p}${fs.existsSync(p) ? '' : ' (없음)'}`));
        info(lines);
      } },
      { name: '/effort', arg: '[low|medium|high|max]', desc: '추론 강도', async run(arg) {
        const e = ['low', 'medium', 'high', 'max'];
        let v = arg.toLowerCase();
        if (!e.includes(v)) { const i = await app.select({ title: `추론 강도 (현재 ${agent().cfg.effort})`, options: [{ label: 'low — 빠른 응답' }, { label: 'medium — 에이전트 권장' }, { label: 'high — 수학·코딩' }, { label: 'max — 정확도 우선, 가장 느림' }], cancel: -1 }); if (i < 0) return; v = e[i]; }
        agent().cfg.effort = v;
        info([c.dim('추론 강도: ') + v]);
      } },
      { name: '/exit', desc: '종료', run: () => app.exit() },
      { name: '/export', arg: '[파일 이름]', desc: '대화를 Markdown 파일로 저장', run(arg) {
        const file = path.resolve(app.cwd, arg || `exaone-${agent().session.id}.md`);
        const out = [`# EXAONE Code 대화`, '', `- 폴더: ${app.cwd}`, `- 세션: ${agent().session.id}`, ''];
        for (const m of agent().messages) {
          if (m.role === 'user') out.push('## 사용자', '', m._display || m.content, '');
          else if (m.role === 'assistant') { out.push('## EXAONE', ''); if (m.content) out.push(m.content, ''); for (const tc of m.tool_calls || []) out.push('```json', `${tc.function.name} ${tc.function.arguments}`, '```', ''); }
          else if (m.role === 'tool') out.push('```text', String(m.content).slice(0, 4000), '```', '');
        }
        fs.writeFileSync(file, out.join('\n'), 'utf8');
        info([`저장했습니다: ${file}`]);
      } },
      { name: '/init', desc: '코드베이스를 살펴보고 EXAONE.md 작성', run: () => app.prompt('이 폴더의 코드베이스를 살펴보고 EXAONE.md 를 작성해 주세요. 앞으로 이 저장소에서 일하는 에이전트가 읽을 지침입니다. 빌드·실행·테스트 명령, 폴더 구조와 핵심 모듈, 코드 규칙과 주의할 점을 실제 파일에서 확인한 내용만 간결하게 담으세요. 이미 EXAONE.md 가 있으면 읽고 개선하세요.', '/init') },
      { name: '/login', desc: '토큰(API 키) 등록 · 바꾸기 — 데스크톱 앱과 함께 씁니다', async run() { await app.ensureKey({ change: true }); } },
      { name: '/logout', desc: '등록된 토큰 지우기 (데스크톱 앱에서도 지워집니다)', async run() {
        if (!app.refreshKey()) return info([c.dim('등록된 토큰이 없습니다.')]);
        const v = await app.select({ title: '등록된 토큰을 지울까요?', lines: [c.dim('데스크톱 앱과 터미널이 함께 쓰는 토큰이라 양쪽 모두에서 지워집니다.')], options: [{ label: '예, 지우기' }, { label: '아니오' }], cancel: 1 });
        if (v !== 0) return undefined;
        store.removeKey(); app.refreshKey();
        return info(['등록된 토큰을 지웠습니다.']);
      } },
      { name: '/memory', desc: '메모리 파일(EXAONE.md) 보기·편집', async run() {
        const files = store.memoryFiles(app.cwd);
        const v = await app.select({ title: '메모리 파일', lines: [c.dim('대화마다 system 메시지에 포함됩니다. 고르면 편집기로 엽니다.')], options: files.map((f) => ({ label: `${padEnd(f.label, 26)} ${c.dim(f.path)}${f.exists ? '' : c.dim(' (없음)')}` })), cancel: -1 });
        if (v < 0) return;
        const f = files[v];
        if (!f.exists) { store.ensure(path.dirname(f.path)); fs.writeFileSync(f.path, `# ${f.label}\n\n`, 'utf8'); }
        const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : null);
        if (!editor) return info([`편집기를 찾지 못했습니다. 직접 열어 주세요: ${f.path}`]);
        try { spawn(editor, [f.path], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref(); info([`${editor} 로 열었습니다: ${f.path}`]); }
        catch (e) { info([c.red('열지 못했습니다: ' + e.message), f.path]); }
      } },
      { name: '/model', desc: '모델·추론 강도 보기', run() { info([`모델 ${c.brand(agent().cfg.model)} · 추론 강도 ${c.brand(agent().cfg.effort)}`, c.dim('추론 강도는 /effort, 모델 ID 는 --model 옵션이나 환경 변수 EXAONE_MODEL 로 바꿉니다')]); } },
      { name: '/permissions', desc: '권한 모드와 허용·거부 규칙', async run() {
        const lines = [c.dim('허용 규칙: ') + (agent().allow.length ? agent().allow.join(', ') : '없음'), c.dim('거부 규칙: ') + (agent().deny.length ? agent().deny.join(', ') : '없음'), c.dim('규칙 파일: ' + store.settingsFiles(app.cwd).local)];
        const modes = ['default', 'acceptEdits', 'plan'].concat(app.opt.allowBypass ? ['bypassPermissions'] : []);
        const labels = { default: '기본 — 편집·명령·웹 요청마다 확인', acceptEdits: '편집 자동 허용 — 명령·웹 요청만 확인', plan: '계획 모드 — 읽기만 하고 계획부터', bypassPermissions: '권한 확인 건너뛰기' };
        const v = await app.select({ title: `권한 (현재: ${agent().mode})`, lines, options: modes.map((m) => ({ label: labels[m] })), cancel: -1 });
        if (v >= 0) agent().cfg.mode = modes[v];
      } },
      { name: '/plan', desc: '계획 모드 켜기·끄기', run() { agent().cfg.mode = agent().mode === 'plan' ? 'default' : 'plan'; info([agent().mode === 'plan' ? c.plan('⏸ 계획 모드: 읽기만 하고, 계획을 세운 뒤 승인을 받습니다') : '계획 모드를 껐습니다']); } },
      { name: '/resume', desc: '이전 세션 이어서 하기 (터미널 세션 · 데스크톱 앱의 작업)', async run() {
        const list = app.resumable().slice(0, 20);
        if (!list.length) return info([c.dim('이 폴더에서 이어서 할 세션이 없습니다.')]);
        const when = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const v = await app.select({ title: '이어서 할 세션', options: list.map((s) => ({ label: `${when(s.mtime)}  ${c.dim(`메시지 ${s.count}개`)}  ${s.desktop ? c.accept('데스크톱 앱') + '  ' : ''}${truncate(s.title, Math.max(20, app.cols - 46))}` })), cancel: -1 });
        if (v < 0) return;
        const picked = list[v];
        if (picked.desktop) {
          // 데스크톱 앱의 작업은 복사본으로 새 터미널 세션을 만들어 이어 간다 (앱 쪽 기록은 그대로).
          const conv = sessions.readDesktopTask(picked.id);
          if (!conv) return info([c.red('데스크톱 앱의 작업을 읽지 못했습니다.')]);
          const messages = sessions.desktopToCli(conv);
          const session = new store.Session(app.cwd);
          session.rewrite(messages);
          agent().session = session; agent().messages = messages;
        } else {
          const { session, messages } = store.Session.load(app.cwd, picked.id);
          agent().session = session; agent().messages = messages;
        }
        agent().resetUsage();
        app.replay();
      } },
      { name: '/rewind', desc: '이 세션에서 바꾼 파일을 모두 되돌리기', async run() {
        const files = app.history.summary(agent().session.id, app.cwd).files.filter((f) => f.status !== 'unchanged');
        if (!files.length) return info([c.dim('되돌릴 변경이 없습니다.')]);
        const v = await app.select({ title: `파일 ${files.length}개를 세션 시작 전 내용으로 되돌릴까요?`, lines: files.slice(0, 12).map((f) => `  ${f.path}  ${c.green('+' + f.added)} ${c.red('−' + f.removed)}`), options: [{ label: '예, 모두 되돌리기' }, { label: '아니오' }], cancel: 1 });
        if (v !== 0) return;
        const n = app.history.restoreAll(agent().session.id, app.cwd);
        info([c.warn(`${n}개 파일을 되돌렸습니다.`)]);
        agent().push({ role: 'user', content: '(참고: 사용자가 이 세션에서 바뀐 파일을 모두 세션 시작 전 상태로 되돌렸습니다.)', _display: '/rewind' });
        agent().push({ role: 'assistant', content: '확인했습니다.' });
      } },
      { name: '/status', desc: '버전·모델·키·세션 정보', run() {
        const mem = store.memoryFiles(app.cwd).filter((f) => f.exists);
        info([c.bold(`EXAONE Code v${pkg.version}`), `폴더  ${app.cwd}`, `세션  ${agent().session.id}`, `모델  ${agent().cfg.model} · 추론 ${agent().cfg.effort} · 권한 ${agent().mode}`,
          `API   ${agent().cfg.baseUrl}`, `토큰  ${app.keyInfo.key ? app.keyInfo.source : c.red('등록되지 않음 (/login)')}`, `메모리 ${mem.length ? mem.map((f) => f.path).join(', ') : c.dim('없음 (/init 으로 만들 수 있음)')}`]);
      } },
      { name: '/todos', desc: '현재 할 일 목록', run() { const t = agent().todos; if (!t || !t.length) return info([c.dim('할 일 목록이 없습니다.')]); app.say(''); for (const l of todoLines(t)) app.say('  ' + l); } },
      { name: '/verbose', desc: '추론·도구 출력을 펼쳐서 보기 (ctrl+o)', run() { app.toggleVerbose(); } },
    ];
  }

  async command(line) {
    const sp = line.search(/\s/);
    const name = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    const alias = { '/quit': '/exit', '/q': '/exit', '/new': '/clear', '/undo': '/rewind', '/mode': '/permissions', '/usage': '/cost', '/?': '/help' };
    const cmd = this.commands.find((x) => x.name === (alias[name] || name));
    if (cmd) { this.echo(line); try { await cmd.run(arg); } catch (e) { this.say(c.red('  ' + (e && e.message || e))); } return; }
    const cu = this.custom.find((x) => x.name === name);
    if (cu) return this.prompt(cu.body.includes('$ARGUMENTS') ? cu.body.replace(/\$ARGUMENTS/g, arg) : cu.body + (arg ? '\n\n' + arg : ''), line);
    this.echo(line);
    this.say(c.dim(`  알 수 없는 명령입니다: ${name}  (/help 로 목록 보기)`));
  }

  /** 불러온 세션의 최근 대화를 간략히 다시 보여 준다. */
  replay() {
    const msgs = this.agent.messages;
    this.say('');
    this.say(c.dim(`─── 이전 세션을 이어갑니다 (메시지 ${msgs.length}개) ` + '─'.repeat(10)));
    const turns = [];
    for (const m of msgs) {
      if (m.role === 'user') turns.push({ user: m._display || m.content, text: '', toolCount: 0 });
      else if (m.role === 'assistant' && turns.length) { const t = turns[turns.length - 1]; if (m.content) t.text = m.content; t.toolCount += (m.tool_calls || []).length; }
    }
    for (const t of turns.slice(-3)) {
      this.echo(String(t.user).split('\n')[0].slice(0, 200));
      if (t.toolCount) this.say(c.dim(`  ⎿  도구 호출 ${t.toolCount}회`));
      if (t.text) { const ls = md.render(t.text, this.textWidth); this.block(ls.slice(0, 12)); if (ls.length > 12) this.say(c.dim(`  … +${ls.length - 12}줄`)); }
    }
  }

  /** 이 폴더에서 이어서 할 수 있는 것들: 터미널 세션과, 데스크톱 앱에서 같은 폴더로 한 에이전트 작업. 최근 것부터. */
  resumable() {
    const mine = this.agent.session && this.agent.session.id;
    const cliList = store.Session.list(this.cwd).filter((s) => s.id !== mine).map((s) => ({ id: s.id, mtime: s.mtime, count: s.count, title: s.first || '(제목 없음)', desktop: false }));
    let desk = [];
    try { desk = sessions.listDesktopTasks(this.cwd).map((t) => ({ id: t.id, mtime: t.mtime, count: t.count, title: t.title, desktop: true })); } catch { /* 앱을 쓰지 않는 환경 */ }
    return cliList.concat(desk).sort((a, b) => b.mtime - a.mtime);
  }

  /** 시작 화면: 얇은 터미널 프레임 안에 이름·버전 / 모델·추론 강도 / 작업 폴더. */
  banner() {
    const cfg = this.agent.cfg;
    let host = cfg.baseUrl;
    try { host = new URL(cfg.baseUrl).host; } catch { /* 그대로 */ }
    const frameWidth = Math.min(78, this.cols - 2);
    const w = Math.max(1, frameWidth - 4);
    const info = [
      c.bold('EXAONE') + ' ' + c.brand('Code') + c.dim(` v${pkg.version}`),
      c.dim(truncate(`${cfg.model} with ${cfg.effort} effort · ${host}`, w)),
      c.dim(truncate(this.cwd, w)),
    ];
    this.say('');
    box(info, frameWidth, c.brand).forEach(line => this.say(' ' + line));
    this.say('');
    const tip = `${c.code('/help')} 로 명령어, ${c.code('@')} 로 파일, ${c.code('!')} 로 셸 명령을 쓸 수 있습니다. 추론 강도는 ${c.code('/effort')}, 권한 모드는 shift+tab 으로 바꿉니다.`;
    for (const l of wrapAnsi(tip, this.cols - 5)) this.say('  ' + l);
    if (store.memoryFiles(this.cwd).some((f) => f.exists)) this.say(c.dim('  EXAONE.md 메모리 적용 중'));
    if (!this.agent.messages.length) {
      const prev = this.resumable();
      const desk = prev.filter((s) => s.desktop).length;
      if (prev.length) this.say(c.dim(`  이 폴더에 이어서 할 수 있는 세션 ${prev.length}개` + (desk ? ` (데스크톱 앱의 작업 ${desk}개 포함)` : '') + ' · ') + c.code('/resume'));
    }
    if (!this.keyInfo.key) this.say(c.warn('  토큰이 등록되어 있지 않습니다. 먼저 토큰을 등록해야 쓸 수 있습니다.'));
  }

  exit(code = 0) {
    clearInterval(this.tick);
    this.screen.clear();
    process.stdout.write('\x1b[?2004l\x1b[?25h');
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* 이미 닫힘 */ }
    const s = this.agent.session;
    if (s && s.started && this.agent.messages.length) process.stdout.write(c.dim(`이어서 하려면: exaone --resume ${s.id}  (또는 exaone -c)`) + '\n');
    process.exit(code);
  }

  async start(firstPrompt) {
    // esc 를 누른 뒤 기다리는 시간을 줄여 중단이 바로 먹게 한다 (기본 500ms).
    readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 60 });
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?2004h');
    process.stdin.on('keypress', (str, key) => { try { this.onKey(str, key); } catch (e) { this.say(c.red('입력 처리 오류: ' + (e && e.message))); } });
    process.stdout.on('resize', () => this.render());
    process.on('exit', () => { try { process.stdout.write('\x1b[?2004l\x1b[?25h'); } catch { /* 무시 */ } });
    // 시작할 때 터미널을 비우고 맨 위에서부터 그린다 (이전 출력 아래에 이어 붙지 않게).
    this.clearScreen();
    this.banner();
    if (this.agent.messages.length) this.replay();
    this.render();
    // 등록된 토큰이 없으면 시작하자마자 등록으로 이끈다.
    if (!this.keyInfo.key) { await this.ensureKey(); this.render(); }
    if (firstPrompt) this.queue.push(firstPrompt);
    for (;;) {
      const text = await this.nextInput();
      await this.handle(text);
      this.render();
    }
  }
}

module.exports = { App, fmtElapsed, fmtNum, diffLines, toolSummary };
