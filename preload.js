'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const fn = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('exa', {
  init: () => ipcRenderer.invoke('app:init'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setKey: (key) => ipcRenderer.invoke('key:set', key),
  keyInfo: () => ipcRenderer.invoke('key:info'),

  listConvs: () => ipcRenderer.invoke('conv:list'),
  loadConv: (id) => ipcRenderer.invoke('conv:load', id),
  saveConv: (conv) => ipcRenderer.invoke('conv:save', conv),
  deleteConv: (id) => ipcRenderer.invoke('conv:delete', id),

  chatStart: (reqId, body) => ipcRenderer.invoke('chat:start', { reqId, body }),
  chatAbort: (reqId) => ipcRenderer.invoke('chat:abort', reqId),
  onChatEvent: on('chat:event'),

  runTool: (req) => ipcRenderer.invoke('tool:run', req),
  cancelTool: (callId) => ipcRenderer.invoke('tool:cancel', callId),
  onToolOutput: on('tool:output'),
  onTokenRequest: on('ui:token'),
  onCliChanged: on('cli:changed'),
  liveBegin: (req) => ipcRenderer.invoke('live:begin', req),
  liveEmit: (sid, events) => ipcRenderer.send('live:emit', { sid, events }),
  liveEnd: (sid) => ipcRenderer.invoke('live:end', sid),
  liveWatch: (req) => ipcRenderer.invoke('live:watch', req),
  liveStop: (sid) => ipcRenderer.invoke('live:stop', sid),
  onLiveEvents: on('live:events'),
  onLiveStop: on('live:stop'),

  runTabular: (req) => ipcRenderer.invoke('tabular:run', req),

  pickFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
  exportSave: (defaultName, content) => ipcRenderer.invoke('export:save', { defaultName, content }),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  setPreview: (html) => ipcRenderer.invoke('preview:set', html),
  setTheme: (dark) => ipcRenderer.send('ui:theme', dark),
  saveLog: (log) => ipcRenderer.invoke('log:save', log),

  fileUrl: (req) => ipcRenderer.invoke('file:url', req),
  fileRead: (req) => ipcRenderer.invoke('file:read', req),
  fileOpen: (req) => ipcRenderer.invoke('file:open', req),
  cliList: () => ipcRenderer.invoke('cli:list'),
  cliLoad: (req) => ipcRenderer.invoke('cli:load', req),
  cliTerminal: (req) => ipcRenderer.invoke('cli:terminal', req),
  cliBinStatus: () => ipcRenderer.invoke('clibin:status'),
  cliBinInstall: () => ipcRenderer.invoke('clibin:install'),
  cliBinUninstall: () => ipcRenderer.invoke('clibin:uninstall'),
  notify: (req) => ipcRenderer.invoke('notify', req),
  trustCheck: (dir) => ipcRenderer.invoke('trust:check', dir),
  trustAdd: (dir) => ipcRenderer.invoke('trust:add', dir),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: on('update:state'),
  onNotifyClick: on('notify:click'),
  codeStat: (sid) => ipcRenderer.invoke('code:stat', sid),
  codeMemory: (cwd) => ipcRenderer.invoke('code:memory', cwd),
  fileList: (req) => ipcRenderer.invoke('file:list', req),

  historySummary: (req) => ipcRenderer.invoke('history:summary', req),
  historyDiff: (req) => ipcRenderer.invoke('history:diff', req),
  historyRestore: (req) => ipcRenderer.invoke('history:restore', req),
  historyRestoreAll: (req) => ipcRenderer.invoke('history:restoreAll', req),
});
