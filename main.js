'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, protocol, nativeTheme, Menu, Notification, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sessions = require('./src/sessions');
const live = require('./src/live');
const cliInstall = require('./src/cliInstall');
const updater = require('./src/updater');
const crypto = require('crypto');

if (process.env.EXAONE_DATA_DIR) app.setPath('userData', path.resolve(process.env.EXAONE_DATA_DIR));

const exaone = require('./src/exaone');
const tools = require('./src/tools');
const { Store } = require('./src/store');
const { History } = require('./src/history');

protocol.registerSchemesAsPrivileged([
  { scheme: 'exa-preview', privileges: { standard: true, secure: true, supportFetchAPI: false } },
  // 작업 폴더의 파일을 미리보기 창에 그대로 내주는 스킴 (HTML 이 옆의 CSS·JS·이미지를 상대 경로로 읽을 수 있게)
  { scheme: 'exa-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};
const fileRoots = new Map(); // 토큰 -> 작업 폴더 절대 경로
function fileToken(workspace) {
  const root = path.resolve(workspace);
  const token = 'w' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  fileRoots.set(token, root);
  return token;
}

let store;
let history;
let cliHistory; // 터미널(EXAONE Code)과 함께 쓰는 파일 버전 기록
let win;
let tray;            // 시스템 트레이 아이콘 (GC 되지 않게 잡아 둔다)
let isQuitting = false; // true 일 때만 창 닫기가 실제 종료로 이어진다
const chats = new Map();     // reqId -> AbortController
const previews = new Map();  // id -> html
const fetchImpl = (url, opts) => net.fetch(url, opts);

// ---------- 토큰 (API 키) ----------
// 등록한 토큰만 쓴다. 앱이나 터미널(EXAONE Code)에서 등록하면 ~/.exaone/key.txt 에 저장되어 둘이 함께 쓴다.
// key.txt 를 폴더에 두거나 환경 변수로 주는 방식은 더 이상 읽지 않는다.
const cliStore = require('./cli/store');
function readKey() {
  return cliStore.findKey();
}

/** 예전 버전이 앱 설정에 넣어 둔 키가 있으면 공용 저장 위치로 한 번 옮긴다. */
function migrateKey() {
  const s = store.getSettings();
  if (!s.apiKeyEnc && !s.apiKeyPlain) return;
  let k = '';
  if (s.apiKeyEnc) {
    try { if (safeStorage.isEncryptionAvailable()) k = safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')).trim(); } catch { /* 풀지 못하면 다시 등록해야 한다 */ }
  }
  if (!k && s.apiKeyPlain) k = String(s.apiKeyPlain).trim();
  if (k && !cliStore.findKey().key) cliStore.saveKey(k);
  if (k || !s.apiKeyEnc) store.setSettings({ apiKeyEnc: '', apiKeyPlain: '' });
}

function keyInfo() {
  const { key, source } = readKey();
  return { hasKey: !!key, source, masked: key ? key.slice(0, 3) + '…' + key.slice(-4) : '' };
}

function publicSettings() {
  const { apiKeyEnc, apiKeyPlain, ...rest } = store.getSettings();
  return rest;
}

// ---------- API 로그 파일 ----------
// 개발 실행 중에는 앱 폴더의 logs/ 에, 패키징된 앱이거나 쓸 수 없으면 데이터 폴더의 logs/ 에 남긴다.
let logDirCache = null;
function logDir() {
  if (logDirCache) return logDirCache;
  const candidates = app.isPackaged ? [] : [path.join(app.getAppPath(), 'logs')];
  candidates.push(path.join(app.getPath('userData'), 'logs'));
  for (const d of candidates) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); logDirCache = d; return d; } catch { /* 다음 후보 */ }
  }
  return candidates[candidates.length - 1];
}

function saveLog(log) {
  const dir = logDir();
  const stamp = String(log.time || new Date().toISOString()).replace(/[:.]/g, '-');
  const id = String(log.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  fs.writeFileSync(path.join(dir, `${stamp}_${log.status || 'ERR'}_${id}.json`), JSON.stringify(log, null, 2), 'utf8');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 40))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 무시 */ } }
  return true;
}

// ---------- 로고 ----------
/**
 * 사용자가 넣어 둔 로고 파일. 앱 폴더의 assets/logo.(svg|png|jpg|webp) 또는 설정 폴더(~/.exaone)의 logo.* 가 있으면
 * 사이드바 · 시작 화면과 창 아이콘에 쓴다. 없으면 Desktop/Code 기본 브랜드를 쓴다.
 */
function brandLogo() {
  const types = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  for (const dir of [path.join(__dirname, 'assets'), cliStore.HOME]) {
    for (const ext of Object.keys(types)) {
      const file = path.join(dir, 'logo.' + ext);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0 && st.size <= 2 * 1024 * 1024) return { file, ext, url: `data:${types[ext]};base64,` + fs.readFileSync(file).toString('base64') };
      } catch { /* 없음 */ }
    }
  }
  return null;
}

// ---------- 창 ----------
function overlayColors(dark) {
  return dark ? { color: '#111113', symbolColor: '#f4f4f5', height: 44 } : { color: '#fafafa', symbolColor: '#131415', height: 44 };
}

// ---------- 실시간 연동 (src/live.js) ----------
// 열어 둔 Code 세션에서 터미널이 실행 중인 작업을 읽어 화면으로 보내고, 앱이 실행하는 작업은 터미널이 볼 수 있게 적는다.
const liveSrc = live.newSrc();
let liveWriter = null;  // 앱이 실행 중인 작업을 알리는 쪽 { sid }
let liveReader = null;  // 열어 둔 세션을 읽는 쪽 { sid }
let liveTimer = null;
function sessionFileOf(sid, cwd) {
  const f = sessions.findCliSession(sid);
  if (f) return f.file;
  return cwd ? path.join(cliStore.projectDir(cwd), sid + '.jsonl') : null;
}
function pumpLive() {
  if (!liveReader || !win || win.isDestroyed()) return;
  let events = [];
  try { events = liveReader.poll(); } catch { return; }
  if (events.length) win.webContents.send('live:events', { sid: liveReader.sid, events });
}

/**
 * 터미널(EXAONE Code)이 세션 파일에 쓰는 즉시 화면에 반영되도록 세션 폴더를 지켜본다.
 * 변경이 몰려 올 수 있어 잠깐 모았다가 한 번만 알린다.
 */
let cliWatcher = null;
function watchCliSessions() {
  const root = path.join(cliStore.HOME, 'projects');
  let timer = null;
  try {
    fs.mkdirSync(root, { recursive: true });
    cliWatcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      if (name && !/\.(jsonl|live)$/i.test(String(name))) return;
      if (name && /\.live$/i.test(String(name))) { pumpLive(); return; } // 실시간 사건은 모으지 않고 바로 전한다
      clearTimeout(timer);
      // 실시간 사건을 먼저 전한 뒤에 "기록이 바뀌었다" 고 알린다 (같은 내용을 두 번 그리지 않게).
      timer = setTimeout(() => { pumpLive(); if (win && !win.isDestroyed()) win.webContents.send('cli:changed', {}); }, 120);
    });
    cliWatcher.on('error', () => { /* 지켜보지 못해도 화면 쪽의 주기적 확인이 대신한다 */ });
  } catch { /* 지원하지 않는 환경: 주기적 확인만 쓴다 */ }
}

/**
 * 새 터미널 창을 열어 그 폴더에서 `exaone --resume <id>` 를 실행한다.
 * 실패하면 직접 붙여 넣을 수 있도록 명령을 돌려준다.
 */
function openCliTerminal(cwd, id) {
  if (!/^[\w.:-]+$/.test(String(id))) throw new Error('세션 id 가 올바르지 않습니다');
  if (!cwd || !fs.existsSync(cwd)) throw new Error('작업 폴더를 찾을 수 없습니다: ' + (cwd || '(알 수 없음)'));
  // 앱이 만든 런처로 실행한다 (PC 에 Node 가 없어도, exaone 명령을 설치하지 않았어도 열린다).
  const dir = path.join(app.getPath('userData'), 'bin');
  cliInstall.writeLaunchers(dir, cliInstall.pickRuntime(cliCtx()));
  const launcher = cliInstall.mainLauncher(dir);
  const command = process.platform === 'win32'
    ? `cd /d "${cwd}" && "${launcher}" --resume ${id}`
    : `cd "${cwd}" && "${launcher}" --resume ${id}`;
  let child;
  if (process.platform === 'win32') {
    // cmd /k ""프로그램" 인자" : 바깥 따옴표 한 쌍은 cmd 가 벗겨 낸다.
    const line = `/d /s /c "start "EXAONE Code" /D "${cwd}" cmd.exe /k ""${launcher}" --resume ${id}""`;
    child = spawn(process.env.ComSpec || 'cmd.exe', [line], { cwd, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
  } else if (process.platform === 'darwin') {
    const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${esc(command)}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', command], { cwd, detached: true, stdio: 'ignore' });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    child.on('error', (e) => finish({ opened: false, command, error: e.message }));
    child.on('spawn', () => { child.unref(); setTimeout(() => finish({ opened: true, command }), 150); });
  });
}

// ---------- EXAONE Code(터미널 명령) 설치 ----------
/** 런처가 가리킬 곳: 이 앱의 폴더와 실행 파일, 배포판이면 함께 들어 있는 Node 의 위치. */
function cliCtx() {
  return { appDir: app.getAppPath(), execPath: process.execPath, resourcesPath: app.isPackaged ? process.resourcesPath : null };
}
/** 터미널(EXAONE Code)이 이 앱을 띄울 수 있게, 실행하는 방법을 설정 폴더에 적어 둔다 (토큰 등록 · "앱에서 열기"). */
function registerDesktop() {
  try {
    cliStore.ensure(cliStore.HOME);
    fs.writeFileSync(path.join(cliStore.HOME, 'desktop.json'), JSON.stringify({ exe: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()], version: app.getVersion() }, null, 2), 'utf8');
  } catch { /* 적지 못해도 앱은 뜬다 */ }
}

// ---------- 알림 ----------
// 작업이 끝났거나 사용자의 확인(질문 · 승인)을 기다릴 때 시스템 알림을 띄운다.
// 설정 notify: 'unfocused'(창이 뒤에 있을 때만, 기본) | 'always' | 'off'
function notifyUser({ title, body, convId, kind }) {
  const mode = store.getSettings().notify || 'unfocused';
  if (mode === 'off' || !win || win.isDestroyed()) return false;
  const focused = win.isFocused() && !win.isMinimized();
  if (!focused) { try { win.flashFrame(true); } catch { /* 플랫폼 미지원 */ } }
  if (process.env.EXAONE_NOTIFY_LOG) { try { fs.appendFileSync(process.env.EXAONE_NOTIFY_LOG, JSON.stringify({ title, body, kind, convId, mode, focused }) + '\n'); } catch { /* 시험용 기록 */ } }
  if (mode !== 'always' && focused) return false;
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || 'EXAONE Desktop').slice(0, 120), body: String(body || '').replace(/\s+/g, ' ').trim().slice(0, 240), silent: false });
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    win.webContents.send('notify:click', { convId, kind });
  });
  n.show();
  lastNotices.add(n); // 눌러 볼 때까지 사라지지 않게 잡아 둔다
  setTimeout(() => lastNotices.delete(n), 5 * 60 * 1000);
  return true;
}
const lastNotices = new Set();

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 780,
    minHeight: 540,
    show: false,
    backgroundColor: dark ? '#111113' : '#fafafa',
    title: 'EXAONE Desktop',
    icon: (() => { const l = brandLogo(); return l && /^(png|jpe?g)$/.test(l.ext) ? l.file : path.join(__dirname, 'assets', 'desktop.png'); })(),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : overlayColors(dark),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { type: 'separator' }, { role: 'selectAll', label: '모두 선택' });
    else if (p.selectionText) items.push({ role: 'copy', label: '복사' });
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: '링크 열기', click: () => shell.openExternal(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // X 를 눌러도 종료하지 않고 트레이로 숨긴다. 트레이 메뉴의 '종료'나 OS 종료 때만 실제로 닫힌다.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('session-end', () => { isQuitting = true; });
  win.on('closed', () => { win = null; });
  win.on('focus', () => { try { win.flashFrame(false); } catch { /* 플랫폼 미지원 */ } });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ---------- 트레이 ----------
function trayIcon() {
  const l = brandLogo();
  const file = l && /^(png|jpe?g)$/.test(l.ext) ? l.file : path.join(__dirname, 'assets', 'desktop.png');
  const src = nativeImage.createFromPath(file);
  if (src.isEmpty()) return src;
  if (process.platform === 'darwin') return src.resize({ width: 16, height: 16, quality: 'best' });
  // 화면 배율(100% · 150% · 200%)마다 선명하게 보이도록 크기별 그림을 넣는다.
  const img = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32]]) {
    img.addRepresentation({ scaleFactor, buffer: src.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  }
  return img;
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('EXAONE Desktop');
  updateTrayMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function updateTrayMenu() {
  if (!tray) return;
  const u = updater.getState();
  const upd = !u.supported ? []
    : u.status === 'ready' ? [{ label: `재시작하여 업데이트 (v${u.version})`, click: installUpdate }]
      : u.status === 'downloading' ? [{ label: `업데이트 받는 중… ${u.percent || 0}%`, enabled: false }]
        : u.status === 'checking' ? [{ label: '업데이트 확인 중…', enabled: false }]
          : [{ label: '업데이트 확인', click: () => updater.check() }];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'EXAONE Desktop 열기', click: showWindow },
    ...upd,
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ---------- 자동 업데이트 ----------
function installUpdate() {
  return updater.install(() => { isQuitting = true; tools.cancelAll(); for (const ac of chats.values()) ac.abort(); });
}

let lastTrayStatus = '';
function onUpdateState(st) {
  if (win && !win.isDestroyed()) win.webContents.send('update:state', st);
  // 진행률은 메뉴를 너무 자주 다시 만들지 않도록 10% 단위로만 반영한다.
  const key = st.status + ':' + (st.status === 'downloading' ? Math.floor((st.percent || 0) / 10) : '');
  if (key !== lastTrayStatus) { lastTrayStatus = key; updateTrayMenu(); }
}

function buildMenu() {
  // 메뉴 바는 보이지 않지만 단축키(복사/붙여넣기, 개발자 도구, 확대/축소)를 위해 둔다.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools', accelerator: 'F12' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}

// ---------- IPC ----------
function registerIpc() {
  const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

  ipcMain.handle('app:init', () => ({
    settings: publicSettings(),
    keyInfo: keyInfo(),
    // ask_user 는 화면에서 처리하는 도구라 client 표시를 붙여 함께 내려보낸다.
    toolDefs: tools.definitions().concat({ name: 'ask_user', category: 'read', def: tools.askUser.def, client: true }),
    askUser: { prompt: tools.askUser.prompt, skipped: tools.askUser.skipped },
    registerToken: process.argv.includes('--register-token'),
    logo: (brandLogo() || {}).url || null,
    env: {
      platform: process.platform,
      osLabel: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform,
      shell: tools.shellFor(store.getSettings().agent.shell).name,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      dataDir: app.getPath('userData'),
      logDir: logDir(),
      home: app.getPath('home'),
    },
  }));

  ipcMain.handle('settings:set', (_e, patch) => {
    const clean = { ...(patch || {}) };
    delete clean.apiKeyEnc; delete clean.apiKeyPlain;
    store.setSettings(clean);
    if (clean.theme) nativeTheme.themeSource = clean.theme;
    return publicSettings();
  });

  ipcMain.handle('key:set', (_e, key) => {
    const k = String(key || '').trim().split(/\s+/)[0] || '';
    if (k) cliStore.saveKey(k); else cliStore.removeKey();
    return keyInfo();
  });
  ipcMain.handle('key:info', () => keyInfo());

  ipcMain.handle('conv:list', () => store.listConvs());
  // id 가 "code:<세션 id>" 인 대화는 EXAONE Code(터미널)의 세션 파일을 그대로 읽고 쓴다.
  const sidOf = (id) => (String(id || '').startsWith('code:') ? String(id).slice(5) : null);
  ipcMain.handle('conv:load', (_e, id) => (sidOf(id) ? sessions.loadCodeSession(sidOf(id)) : store.loadConv(id)));
  ipcMain.handle('conv:save', (_e, conv) => {
    if (conv && conv.code) { try { return sessions.saveCodeSession(conv); } catch (e) { console.error('code:save', e); return { error: String(e && e.message || e) }; } }
    return store.saveConv(conv);
  });
  ipcMain.handle('conv:delete', (_e, id) => {
    const sid = sidOf(id);
    if (sid) { try { cliHistory.remove(sid); } catch { /* 기록이 없을 수 있다 */ } return sessions.deleteCodeSession(sid); }
    history.remove(id);
    return store.deleteConv(id);
  });
  ipcMain.handle('code:stat', (_e, sid) => sessions.statCodeSession(sid));
  // 실시간 연동: 앱이 실행하는 작업을 알리기
  ipcMain.handle('live:begin', (_e, { sid, cwd, info }) => {
    const file = sessionFileOf(sid, cwd);
    if (!file) return false;
    if (liveWriter) liveWriter.end(true);
    liveWriter = new live.LiveWriter(file, liveSrc, { onStop: () => send('live:stop', { sid }) });
    liveWriter.sid = sid;
    liveWriter.begin(info);
    return true;
  });
  ipcMain.on('live:emit', (_e, { sid, events }) => {
    if (!liveWriter || liveWriter.sid !== sid || !Array.isArray(events)) return;
    for (const ev of events) liveWriter.emit(ev.t, ...(Array.isArray(ev.a) ? ev.a : []));
  });
  ipcMain.handle('live:end', (_e, sid) => { if (liveWriter && liveWriter.sid === sid) liveWriter.end(); return true; });
  // 실시간 연동: 열어 둔 세션에서 터미널이 실행하는 작업 읽기
  ipcMain.handle('live:watch', (_e, req) => {
    clearInterval(liveTimer); liveTimer = null; liveReader = null;
    const sid = req && req.sid;
    const file = sid ? sessionFileOf(sid, req.cwd) : null;
    if (!file) return false;
    liveReader = new live.LiveReader(file, liveSrc);
    liveReader.sid = sid;
    liveReader.skipFinished(); // 이미 끝난 작업은 다시 그리지 않는다
    liveTimer = setInterval(pumpLive, 100); // 파일 변경 알림을 못 받는 환경에서도 0.1초 안에 따라간다
    pumpLive();
    return true;
  });
  ipcMain.handle('live:stop', (_e, sid) => (liveReader && liveReader.sid === sid ? liveReader.requestStop() : false));
  ipcMain.handle('code:memory', (_e, cwd) => { try { return sessions.codeMemory(cwd); } catch { return ''; } });
  // 파일 버전 기록도 터미널과 같은 곳(~/.exaone/file-history)을 써서 /diff · /rewind 와 변경 사항 패널이 서로 통한다.
  const hist = (convId) => (sidOf(convId) ? [cliHistory, sidOf(convId)] : [history, convId]);

  ipcMain.handle('chat:start', (_e, { reqId, body }) => {
    const { key } = readKey();
    const s = store.getSettings();
    const emit = (ev) => send('chat:event', { reqId, ...ev });
    if (!key) {
      setImmediate(() => {
        emit({ type: 'error', status: 401, message: 'API 키가 설정되지 않았습니다. 설정에서 키를 입력하거나 앱 폴더(또는 상위 폴더)에 key.txt 를 두세요.' });
        emit({ type: 'done', raw: '' });
      });
      return true;
    }
    const ac = new AbortController();
    chats.set(reqId, ac);
    exaone.chat({ fetchImpl, baseUrl: s.baseUrl, apiKey: key, body, signal: ac.signal, minGapMs: s.minGapMs, onEvent: emit })
      .catch((e) => { emit({ type: 'error', status: 0, message: String(e && e.message || e) }); emit({ type: 'done', raw: '' }); })
      .finally(() => chats.delete(reqId));
    return true;
  });
  ipcMain.handle('chat:abort', (_e, reqId) => { const ac = chats.get(reqId); if (ac) ac.abort(); return true; });

  ipcMain.handle('tool:run', (_e, { callId, name, args, workspace, convId }) => {
    const s = store.getSettings();
    return tools.run(name, args, {
      workspace, callId, shell: s.agent.shell, commandTimeout: s.agent.commandTimeout, fetchImpl,
      onOutput: (chunk) => send('tool:output', { callId, chunk }),
      // 파일 변경은 대화별 버전 기록에 남긴다 (기록 실패가 도구 실행을 막지는 않는다).
      onChange: (c) => { if (convId) { try { const [hs, hid] = hist(convId); hs.record(hid, { ...c, callId }); } catch (e) { console.error('history', e); } } },
    });
  });

  const guard = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } };
  ipcMain.handle('history:summary', (_e, { convId, workspace }) => guard(() => { const [hs, hid] = hist(convId); return hs.summary(hid, workspace); }));
  ipcMain.handle('history:diff', (_e, { convId, workspace, path: p, from, to }) => guard(() => { const [hs, hid] = hist(convId); return hs.diff(hid, workspace, p, from, to); }));
  ipcMain.handle('history:restore', (_e, { convId, workspace, path: p, n }) => guard(() => { const [hs, hid] = hist(convId); return hs.restore(hid, workspace, p, n); }));
  ipcMain.handle('history:restoreAll', (_e, { convId, workspace }) => guard(() => { const [hs, hid] = hist(convId); return hs.restoreAll(hid, workspace); }));
  ipcMain.handle('tool:cancel', (_e, callId) => { tools.cancel(callId); return true; });

  ipcMain.handle('tabular:run', async (_e, req) => {
    const { key } = readKey();
    if (!key) return { ok: false, status: 401, error: 'API 키가 설정되지 않았습니다.' };
    const s = store.getSettings();
    const ac = new AbortController();
    chats.set(req.reqId, ac);
    try {
      return await exaone.tabular({
        fetchImpl, baseUrl: s.baseUrl, apiKey: key, task: req.task, mode: req.mode, outputType: req.outputType,
        targetColumn: req.targetColumn, train: req.train, test: req.test, signal: ac.signal, minGapMs: s.minGapMs,
      });
    } finally { chats.delete(req.reqId); }
  });

  ipcMain.handle('dialog:folder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { title: '작업 폴더 선택', defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle('export:save', async (_e, { defaultName, content }) => {
    const r = await dialog.showSaveDialog(win, { title: '내보내기', defaultPath: path.join(app.getPath('documents'), defaultName) });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });

  ipcMain.handle('shell:open', (_e, target) => {
    if (/^https?:\/\//i.test(target)) return shell.openExternal(target);
    return shell.openPath(String(target));
  });

  ipcMain.handle('file:url', (_e, { workspace, path: p }) => guard(() => {
    const abs = tools.resolveIn(workspace, p);
    const rel = path.relative(path.resolve(workspace), abs).split(path.sep).map(encodeURIComponent).join('/');
    return `exa-file://${fileToken(workspace)}/${rel}`;
  }));
  ipcMain.handle('file:read', (_e, { workspace, path: p }) => guard(() => {
    const abs = tools.resolveIn(workspace, p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error('폴더입니다');
    const max = 1024 * 1024;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    try { return { text: tools.decodeText(buf), size: st.size, truncated: st.size > max }; }
    catch { return { binary: true, size: st.size }; }
  }));
  ipcMain.handle('file:list', (_e, { workspace, path: p }) => guard(() => {
    const abs = tools.resolveIn(workspace, p || '.');
    const rows = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      const dir = e.isDirectory();
      let size = 0;
      if (!dir) { try { size = fs.statSync(path.join(abs, e.name)).size; } catch { /* 접근 불가 */ } }
      return { name: e.name, dir, size };
    });
    rows.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { entries: rows.slice(0, 500), more: Math.max(0, rows.length - 500) };
  }));
  // ----- EXAONE Code(터미널) 세션 연계 -----
  ipcMain.handle('cli:list', () => guard(() => sessions.listCliSessions({ limit: 100 })));
  ipcMain.handle('cli:load', (_e, { slug, id }) => guard(() => {
    const raw = sessions.readCliSession(slug, id);
    if (!raw.length) throw new Error('세션을 읽지 못했습니다');
    return { messages: sessions.cliToDesktop(raw) };
  }));
  // EXAONE Code(터미널 명령 exaone) 설치 · 제거
  const cliAct = (fn) => { try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } };
  ipcMain.handle('clibin:status', () => cliAct(() => cliInstall.status(cliCtx())));
  ipcMain.handle('clibin:install', () => cliAct(() => cliInstall.install(cliCtx())));
  ipcMain.handle('clibin:uninstall', () => cliAct(() => cliInstall.uninstall(cliCtx())));
  // 폴더 신뢰: 터미널(EXAONE Code)과 같은 목록(~/.exaone/trusted-folders.json)을 함께 쓴다.
  ipcMain.handle('trust:check', (_e, dir) => { try { return cliStore.isTrusted(String(dir || '')); } catch { return false; } });
  ipcMain.handle('trust:add', (_e, dir) => { try { return cliStore.trustFolder(String(dir || '')); } catch { return false; } });
  ipcMain.handle('update:state', () => updater.getState());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.handle('notify', (_e, req) => { try { return notifyUser(req || {}); } catch { return false; } });
  ipcMain.handle('cli:terminal', async (_e, { cwd, id }) => {
    try { return { ok: true, data: await openCliTerminal(cwd, id) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  ipcMain.handle('file:open', (_e, { workspace, path: p, reveal }) => guard(() => {
    const abs = tools.resolveIn(workspace, p);
    if (reveal) shell.showItemInFolder(abs); else shell.openPath(abs);
    return true;
  }));

  ipcMain.handle('log:save', (_e, log) => { try { return saveLog(log || {}); } catch { return false; } });

  ipcMain.handle('preview:set', (_e, html) => {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    previews.set(id, String(html));
    if (previews.size > 20) previews.delete(previews.keys().next().value);
    return `exa-preview://${id}/`;
  });

  ipcMain.on('ui:theme', (_e, dark) => {
    if (!win || win.isDestroyed() || process.platform === 'darwin') return;
    try { win.setTitleBarOverlay(overlayColors(!!dark)); win.setBackgroundColor(dark ? '#111113' : '#fafafa'); } catch { /* 플랫폼 미지원 */ }
  });
}

// ---------- 시작 ----------
// Windows 알림은 앱 식별자가 있어야 뜬다. 설치판은 설치 프로그램이 등록한 식별자, 개발 실행은 실행 파일 경로를 쓴다.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'ai.exaone.desktop' : process.execPath);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 이미 떠 있는데 다시 실행하면 그 창을 앞으로 가져온다. 터미널(EXAONE Code)이 --register-token 으로 부르면 토큰 등록 화면을 연다.
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    showWindow();
    if (argv.includes('--register-token')) win.webContents.send('ui:token', {});
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    history = new History(path.join(app.getPath('userData'), 'history'));
    cliHistory = new History(path.join(cliStore.HOME, 'file-history'));
    migrateKey();
    watchCliSessions();
    registerDesktop();
    // exaone 명령을 설치해 두었는데 앱 위치가 바뀌었으면(업데이트 · 폴더 이동) 런처를 새로 쓴다.
    setTimeout(() => { try { cliInstall.refresh(cliCtx()); } catch { /* 설정 화면에서 다시 설치할 수 있다 */ } }, 1500);
    nativeTheme.themeSource = store.getSettings().theme || 'system';

    protocol.handle('exa-preview', (req) => {
      const id = new URL(req.url).hostname;
      const html = previews.get(id);
      if (html == null) return new Response('미리보기를 찾을 수 없습니다.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    });

    protocol.handle('exa-file', async (req) => {
      const plain = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      try {
        const u = new URL(req.url);
        const root = fileRoots.get(u.hostname);
        if (!root) return plain(404, '미리보기 대상 폴더를 찾을 수 없습니다.');
        let abs = tools.resolveIn(root, decodeURIComponent(u.pathname).replace(/^\/+/, '') || '.');
        if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
        const data = await fs.promises.readFile(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        return new Response(data, { headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
      } catch (e) {
        return plain(e && e.code === 'ENOENT' ? 404 : 403, e && e.code === 'ENOENT' ? '파일이 없습니다.' : String(e && e.message || e));
      }
    });

    buildMenu();
    registerIpc();
    createWindow();
    createTray();
    updater.init(onUpdateState);
    app.on('activate', showWindow);
  });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('window-all-closed', () => {
    tools.cancelAll();
    for (const ac of chats.values()) ac.abort();
    if (process.platform !== 'darwin') app.quit();
  });
}
