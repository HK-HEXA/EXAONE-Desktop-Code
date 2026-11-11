'use strict';
// 한 세션을 데스크톱 앱과 터미널(EXAONE Code)이 같이 볼 때, 진행 중인 작업을 실시간으로 주고받는 통로.
//
// 작업을 실행하는 쪽(writer)이 세션 파일 옆의 "<세션 id>.live" 에 일어나는 일(입력한 지시, 생각, 답변 글자, 도구 실행…)을
// 한 줄에 하나씩 적고, 보는 쪽(reader)은 그 파일의 늘어난 부분만 읽어 화면에 그대로 재생한다.
// 파일은 지시 하나(turn)를 시작할 때 비우고 다시 쓰므로, 늦게 연 쪽도 처음부터 읽으면 지금 화면을 그대로 만들 수 있다.
// 보는 쪽에서 중단을 누르면 "<세션 id>.ctl" 에 요청을 남기고, 실행하는 쪽이 이를 보고 멈춘다.

const fs = require('fs');
const path = require('path');

const liveFile = (sessionFile) => String(sessionFile).replace(/\.jsonl$/i, '') + '.live';
const ctlFile = (sessionFile) => String(sessionFile).replace(/\.jsonl$/i, '') + '.ctl';
const newSrc = () => Math.random().toString(36).slice(2, 10);
const MERGE = new Set(['reasoning', 'content', 'toolOutput']); // 잇달아 오는 글자 조각은 한 줄로 모아 쓴다
const MAX_TEXT = 60000;
const HEAD_BYTES = 56; // 첫 줄의 앞부분 (누가 · 언제 시작한 지시인지가 들어 있다)

/** 너무 긴 문자열은 잘라서 보낸다 (화면 재생용이라 전부 필요하지는 않다). */
function slim(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '\n… (이하 생략)' : v;
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => slim(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) { if (typeof x !== 'function') out[k] = slim(x, depth + 1); }
  return out;
}

class LiveWriter {
  /**
   * @param {string} sessionFile 세션 기록 파일(.jsonl) 경로
   * @param {string} src 이 프로세스를 가리키는 표시 (자기가 쓴 것을 다시 재생하지 않기 위해)
   * @param {{ onStop?: () => void }} opt 보는 쪽이 중단을 요청했을 때 부를 함수
   */
  constructor(sessionFile, src, opt = {}) {
    this.file = liveFile(sessionFile);
    this.ctl = ctlFile(sessionFile);
    this.src = src;
    this.onStop = opt.onStop || null;
    this.active = false;
    this.turn = 0;
    this.buf = [];
    this.flushTimer = null;
    this.beat = null;
  }

  begin(info) {
    this.end(true);
    this.turn = Date.now();
    this.active = true;
    this.started = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { fs.unlinkSync(this.ctl); } catch { /* 없음 */ }
      fs.writeFileSync(this.file, JSON.stringify({ t: 'turnStart', s: this.src, n: this.turn, a: [slim(info || {})] }) + '\n', 'utf8');
    } catch { this.active = false; return; }
    // 살아 있음을 알리는 신호 + 중단 요청 확인
    this.beat = setInterval(() => {
      if (!this.active) return;
      this._append([{ t: 'hb', a: [] }]);
      this._checkStop();
    }, 1200);
    if (this.beat.unref) this.beat.unref();
  }

  emit(t, ...a) {
    if (!this.active) return;
    const last = this.buf[this.buf.length - 1];
    if (MERGE.has(t) && last && last.t === t && typeof a[0] === 'string' && a.length === 1) last.a[0] += a[0];
    else this.buf.push({ t, a: a.map((x) => slim(x)) });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.buf.length) return;
    const events = this.buf;
    this.buf = [];
    this._append(events);
    this._checkStop();
  }

  _append(events) {
    try { fs.appendFileSync(this.file, events.map((e) => JSON.stringify({ t: e.t, s: this.src, n: this.turn, a: e.a })).join('\n') + '\n', 'utf8'); }
    catch { /* 못 써도 작업은 계속한다 */ }
  }

  _checkStop() {
    if (!this.onStop) return;
    let req = null;
    try { req = JSON.parse(fs.readFileSync(this.ctl, 'utf8')); } catch { return; }
    try { fs.unlinkSync(this.ctl); } catch { /* 이미 지워짐 */ }
    if (req && req.t === 'stop' && req.s !== this.src && (req.ts || 0) >= this.started) this.onStop();
  }

  /** 지시 하나가 끝났음을 알린다. quiet 면 끝 표시를 남기지 않는다 (새 지시를 시작하기 직전의 정리). */
  end(quiet) {
    if (!this.active) return;
    this.flush();
    if (!quiet) this._append([{ t: 'liveEnd', a: [] }]);
    this.active = false;
    clearInterval(this.beat);
    this.beat = null;
  }
}

class LiveReader {
  constructor(sessionFile, src) {
    this.file = liveFile(sessionFile);
    this.ctl = ctlFile(sessionFile);
    this.src = src;
    this.pos = 0;
    this.rest = '';
    this.ino = null;
  }

  /** 지난번 이후 새로 적힌 사건들 (자기가 쓴 것은 뺀다). 파일이 새 지시로 다시 시작됐으면 처음부터 읽는다. */
  poll() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.pos = 0; this.rest = ''; this.head = ''; return []; }
    if (st.size < this.pos) { this.pos = 0; this.rest = ''; }
    let chunk = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        // 파일은 지시마다 비우고 다시 쓴다. 그 사이에 이미 읽은 곳보다 길어졌을 수도 있으므로 첫 줄(지시마다 다르다)로도 확인한다.
        const hb = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
        const head = hb.toString('latin1', 0, fs.readSync(fd, hb, 0, hb.length, 0));
        if (this.pos > 0 && this.head && head !== this.head) { this.pos = 0; this.rest = ''; }
        this.head = head;
        if (st.size <= this.pos) return [];
        const buf = Buffer.alloc(st.size - this.pos);
        const n = fs.readSync(fd, buf, 0, buf.length, this.pos);
        chunk = buf.toString('utf8', 0, n);
        this.pos += n;
      } finally { fs.closeSync(fd); }
    } catch { return []; }
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop(); // 아직 다 쓰이지 않은 마지막 줄
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e && e.t && e.s !== this.src) out.push(e);
    }
    return out;
  }

  /**
   * 세션을 막 열었을 때: 이미 끝난 작업(끝 표시가 있거나 한동안 소식이 없는 것)이면 건너뛴다.
   * 지금 진행 중인 작업이면 그대로 두어, 다음 poll 이 처음부터 읽어 화면을 그대로 만들게 한다.
   */
  skipFinished() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    const lines = text.split('\n').filter((l) => l.trim());
    let lastT = '';
    try { lastT = JSON.parse(lines[lines.length - 1]).t; } catch { /* 쓰는 중인 줄 */ }
    if (lastT === 'liveEnd' || this.age() > 8000) { this.pos = Buffer.byteLength(text, 'utf8'); this.rest = ''; this.head = Buffer.from(text, 'utf8').subarray(0, HEAD_BYTES).toString('latin1'); }
  }

  /** 그 파일이 마지막으로 바뀐 지 얼마나 됐는지 (ms). 없으면 Infinity. */
  age() {
    try { return Date.now() - fs.statSync(this.file).mtimeMs; } catch { return Infinity; }
  }

  /** 실행 중인 쪽에 중단을 요청한다. */
  requestStop() {
    try { fs.writeFileSync(this.ctl, JSON.stringify({ t: 'stop', s: this.src, ts: Date.now() }), 'utf8'); return true; } catch { return false; }
  }
}

// 실행하는 쪽이 알리는 사건 이름 (EXAONE Code 의 화면 갱신 함수 이름과 같다)
const EVENTS = ['requestStart', 'thinkingStart', 'reasoning', 'thinkingEnd', 'contentStart', 'content', 'contentEnd', 'toolBuilding', 'toolStart', 'toolOutput', 'toolEnd', 'error', 'notice', 'retryWait', 'compactStart', 'compactEnd', 'interrupted', 'turnEnd'];

/** 화면 재생에 필요한 것만 남긴다 (도구 호출 객체 전체를 보내지 않는다). */
function slimArgs(name, args) {
  if (name === 'toolBuilding') return [{ name: args[0] && args[0].name }];
  if (name === 'toolStart') return [{ id: args[0].id, name: args[0].name }, args[1]];
  if (name === 'toolEnd') {
    const r = args[2] || {};
    return [{ id: args[0].id, name: args[0].name }, args[1], { ok: !!r.ok, content: r.content, meta: r.meta, rejected: r.rejected, display: r.display, silent: r.silent }];
  }
  return args;
}

/** 화면 갱신 함수 묶음(ui)을 감싸, 부를 때마다 실시간 통로에도 같은 사건을 적게 한다. getWriter 는 그때그때의 LiveWriter 를 돌려준다. */
function tee(base, getWriter) {
  const out = { ...base };
  for (const name of EVENTS) {
    out[name] = (...args) => {
      const w = getWriter();
      if (w && w.active) { try { w.emit(name, ...slimArgs(name, args)); } catch { /* 알리지 못해도 작업은 한다 */ } }
      return typeof base[name] === 'function' ? base[name](...args) : undefined;
    };
  }
  return out;
}

module.exports = { LiveWriter, LiveReader, liveFile, ctlFile, newSrc, EVENTS, slimArgs, tee };
