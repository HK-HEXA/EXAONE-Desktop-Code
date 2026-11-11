'use strict';
// ---------- 자동 업데이트 (Windows 설치판 전용) ----------
// GitHub Release(latest.yml)를 확인해 새 버전을 백그라운드로 받아 두고, 화면과 트레이에 '재시작하여 업데이트'를 띄운다.
// 바로 재시작하지 않으면 다음에 앱을 종료할 때 설치된다.
const { app } = require('electron');

const CHECK_DELAY = 10 * 1000;            // 시작 후 첫 확인
const CHECK_EVERY = 4 * 60 * 60 * 1000;   // 이후 확인 주기

let autoUpdater = null;
let state = { status: 'idle', version: null, percent: 0, error: null, supported: false, current: app.getVersion() };
let listener = () => {};

function set(patch) {
  state = { ...state, ...patch };
  try { listener(state); } catch { /* 화면 갱신 실패는 무시 */ }
}

function supported() {
  return process.platform === 'win32' && app.isPackaged;
}

/** onChange(state) 는 상태가 바뀔 때마다 불린다. */
function init(onChange) {
  if (onChange) listener = onChange;
  if (!supported()) { set({ supported: false }); return; }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    set({ supported: false, error: String(e && e.message || e) });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info && info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info && info.version, percent: 100 }));
  autoUpdater.on('error', (e) => {
    // 이미 받아 둔 업데이트가 있으면 그 상태를 유지한다.
    if (state.status === 'ready') return;
    set({ status: 'error', error: String(e && e.message || e).split('\n')[0].slice(0, 300) });
  });

  set({ supported: true });
  setTimeout(check, CHECK_DELAY);
  setInterval(check, CHECK_EVERY).unref?.();
}

function check() {
  if (!autoUpdater) return state;
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
  autoUpdater.checkForUpdates().catch((e) => set({ status: 'error', error: String(e && e.message || e).split('\n')[0].slice(0, 300) }));
  return state;
}

/** 받아 둔 업데이트를 설치하고 다시 실행한다. beforeQuit 은 창 닫기 막기를 풀기 위해 먼저 부른다. */
function install(beforeQuit) {
  if (!autoUpdater || state.status !== 'ready') return false;
  if (beforeQuit) beforeQuit();
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); // 조용히 설치 후 바로 다시 실행
  return true;
}

function getState() { return state; }

module.exports = { init, check, install, getState, supported };
