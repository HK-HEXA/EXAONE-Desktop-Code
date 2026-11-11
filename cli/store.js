'use strict';
// EXAONE Code 의 파일 저장: 키, 설정, 세션 기록, 메모리(EXAONE.md), 입력 이력, 사용자 정의 명령.
// 사용자 폴더: ~/.exaone   프로젝트 폴더: <작업 폴더>/.exaone

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.EXAONE_HOME || path.join(os.homedir(), '.exaone');
const ensure = (dir) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { ensure(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); };

// ---------- 키 ----------
const keyFile = () => path.join(HOME, 'key.txt');
function readKeyFile(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split(/\s+/)[0] || ''; } catch { return ''; }
}
/**
 * 등록된 토큰(API 키). 데스크톱 앱이나 터미널에서 한 번 등록하면 ~/.exaone/key.txt 에 저장되어 둘이 함께 쓴다.
 * 등록하지 않은 key.txt 파일이나 환경 변수는 읽지 않는다.
 */
function findKey() {
  const k = readKeyFile(keyFile());
  return k ? { key: k, source: '등록된 토큰 (' + keyFile() + ')' } : { key: '', source: '' };
}
function saveKey(key) { ensure(HOME); fs.writeFileSync(keyFile(), key.trim() + '\n', { encoding: 'utf8', mode: 0o600 }); return keyFile(); }
function removeKey() { try { fs.unlinkSync(keyFile()); return true; } catch { return false; } }

/** 데스크톱 앱을 띄운다 (args 예: ['--register-token'] → 토큰 등록 화면). 띄우지 못하면 { ok: false, reason }. */
function openDesktopApp(args = []) {
  const appDir = path.resolve(__dirname, '..');
  let bin = '';
  try { bin = require(path.join(appDir, 'node_modules', 'electron')); } catch { /* 아직 설치 전 */ }
  if (typeof bin !== 'string' || !bin || !fs.existsSync(bin)) return { ok: false, reason: '데스크톱 앱이 아직 설치되어 있지 않습니다. ' + path.join(appDir, 'start.bat') + ' 을 한 번 실행하세요' };
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('child_process').spawn(bin, [appDir, ...args], { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}

// ---------- 설정 ----------
const settingsFiles = (cwd) => ({
  user: path.join(HOME, 'settings.json'),
  project: path.join(cwd, '.exaone', 'settings.json'),
  local: path.join(cwd, '.exaone', 'settings.local.json'),
});
function loadSettings(cwd) {
  const f = settingsFiles(cwd);
  const merged = { permissions: { allow: [], deny: [] } };
  for (const file of [f.user, f.project, f.local]) {
    const s = readJson(file, null);
    if (!s || typeof s !== 'object') continue;
    for (const [k, v] of Object.entries(s)) {
      if (k === 'permissions' && v && typeof v === 'object') {
        merged.permissions.allow.push(...(Array.isArray(v.allow) ? v.allow : []));
        merged.permissions.deny.push(...(Array.isArray(v.deny) ? v.deny : []));
        if (v.defaultMode) merged.permissions.defaultMode = v.defaultMode;
      } else merged[k] = v;
    }
  }
  return merged;
}
function saveUserSetting(key, value) {
  const file = path.join(HOME, 'settings.json');
  const s = readJson(file, {});
  if (value === undefined) delete s[key]; else s[key] = value;
  writeJson(file, s);
}
function addAllowRule(cwd, rule) {
  const file = settingsFiles(cwd).local;
  const s = readJson(file, {});
  s.permissions = s.permissions || {};
  s.permissions.allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  if (!s.permissions.allow.includes(rule)) s.permissions.allow.push(rule);
  writeJson(file, s);
  return file;
}

// ---------- 세션 ----------
const slug = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
const projectDir = (cwd) => path.join(HOME, 'projects', slug(cwd));

class Session {
  constructor(cwd, id) {
    this.cwd = cwd;
    this.id = id || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
    this.file = path.join(projectDir(cwd), this.id + '.jsonl');
    this.started = false;
  }

  /** 세션 폴더 이름만으로는 작업 폴더를 되돌릴 수 없어서 경로를 따로 적어 둔다 (데스크톱 앱이 세션 목록을 보여 줄 때 쓴다). */
  noteCwd() {
    const meta = path.join(path.dirname(this.file), 'project.json');
    if (!fs.existsSync(meta)) writeJson(meta, { cwd: path.resolve(this.cwd) });
  }

  /** 우리가 마지막으로 쓴(또는 읽은) 시점을 적어 둔다. 그 뒤로 파일이 바뀌었다면 다른 쪽(데스크톱 앱)이 쓴 것이다. */
  touch() { try { this.mtime = fs.statSync(this.file).mtimeMs; } catch { /* 아직 파일이 없다 */ } }
  /** 다른 쪽에서 이 세션에 쓴 것이 있는가 */
  changedOutside() {
    if (!this.started) return false;
    try { return fs.statSync(this.file).mtimeMs !== this.mtime; } catch { return false; }
  }

  append(msg) {
    try {
      if (!this.started) { ensure(path.dirname(this.file)); this.noteCwd(); this.started = true; }
      fs.appendFileSync(this.file, JSON.stringify({ ...msg, _ts: Date.now() }) + '\n', 'utf8');
      this.touch();
    } catch { /* 기록 실패는 대화를 막지 않는다 */ }
  }

  /** 압축(/compact) 뒤처럼 기록 전체를 바꿔 쓸 때 */
  rewrite(messages) {
    try { ensure(path.dirname(this.file)); this.noteCwd(); fs.writeFileSync(this.file, messages.map((m) => JSON.stringify({ ...m, _ts: Date.now() })).join('\n') + (messages.length ? '\n' : ''), 'utf8'); this.started = true; this.touch(); }
    catch { /* 무시 */ }
  }

  static read(file) {
    const out = [];
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const { _ts, ...m } = JSON.parse(line); if (m.role) out.push(m); } catch { /* 깨진 줄 건너뜀 */ }
    }
    return out;
  }

  static list(cwd) {
    const dir = projectDir(cwd);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    const res = [];
    for (const n of names) {
      const file = path.join(dir, n);
      const messages = Session.read(file);
      if (!messages.length) continue;
      const first = messages.find((m) => m.role === 'user');
      res.push({ id: n.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs, count: messages.length, first: first ? String(first._display || first.content).replace(/\s+/g, ' ').slice(0, 80) : '' });
    }
    return res.sort((a, b) => b.mtime - a.mtime);
  }

  static load(cwd, id) {
    const s = new Session(cwd, id);
    const messages = Session.read(s.file);
    s.started = fs.existsSync(s.file);
    s.touch();
    return { session: s, messages };
  }
}

// ---------- 메모리 (EXAONE.md) ----------
function memoryFiles(cwd) {
  const files = [{ scope: 'user', label: '사용자 메모리', path: path.join(HOME, 'EXAONE.md') }];
  const chain = [];
  for (let d = path.resolve(cwd); ;) { chain.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; }
  for (const d of chain) {
    const isCwd = d === path.resolve(cwd);
    const p = path.join(d, 'EXAONE.md');
    if (isCwd || fs.existsSync(p)) files.push({ scope: isCwd ? 'project' : 'parent', label: isCwd ? '프로젝트 메모리' : '상위 폴더 메모리', path: p });
  }
  files.push({ scope: 'local', label: '프로젝트 메모리 (개인용)', path: path.join(cwd, 'EXAONE.local.md') });
  return files.map((f) => {
    let text = '';
    try { text = fs.readFileSync(f.path, 'utf8'); } catch { /* 없음 */ }
    return { ...f, exists: !!text, text };
  });
}
function appendMemory(file, text) {
  ensure(path.dirname(file));
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* 새 파일 */ }
  fs.writeFileSync(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '- ' + text.trim() + '\n', 'utf8');
}

// ---------- 입력 이력 ----------
const historyFile = () => path.join(HOME, 'history.jsonl');
function loadHistory(cwd) {
  let text = '';
  try { text = fs.readFileSync(historyFile(), 'utf8'); } catch { return []; }
  const res = [];
  for (const line of text.split('\n').slice(-2000)) {
    try { const j = JSON.parse(line); if (j.cwd === cwd && j.text) res.push(j.text); } catch { /* 건너뜀 */ }
  }
  return res.slice(-200);
}
function appendHistory(cwd, text) {
  try { ensure(HOME); fs.appendFileSync(historyFile(), JSON.stringify({ cwd, text, ts: Date.now() }) + '\n', 'utf8'); } catch { /* 무시 */ }
}

// ---------- 사용자 정의 슬래시 명령 (.exaone/commands/*.md) ----------
function customCommands(cwd) {
  const res = [];
  for (const [dir, source] of [[path.join(HOME, 'commands'), 'user'], [path.join(cwd, '.exaone', 'commands'), 'project']]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const n of names) {
      let body = '';
      try { body = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
      let desc = '', arg = '';
      const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
      if (fm) {
        desc = ((/^description:\s*(.+)$/m.exec(fm[1]) || [])[1] || '').trim();
        // argument-hint: 명령 옆에 보여 줄 인자 예시 (Claude Code 의 사용자 명령과 같은 항목)
        arg = ((/^argument-hint:\s*(.+)$/m.exec(fm[1]) || [])[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
        body = body.slice(fm[0].length);
      }
      res.push({ name: '/' + n.slice(0, -3), arg, desc: desc || body.trim().split('\n')[0].slice(0, 60), body: body.trim(), source });
    }
  }
  return res;
}

module.exports = {
  HOME, ensure, readJson, writeJson, findKey, saveKey, removeKey, keyFile, openDesktopApp,
  settingsFiles, loadSettings, saveUserSetting, addAllowRule,
  Session, projectDir, memoryFiles, appendMemory, loadHistory, appendHistory, customCommands,
};
