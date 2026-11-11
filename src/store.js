'use strict';
// 설정·대화 저장소 (userData 폴더의 JSON 파일)

const fs = require('fs');
const path = require('path');

const DEFAULT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    answer: { type: 'string', description: '최종 답변' },
    confidence: { type: 'number', description: '0~1 사이 확신도' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'confidence', 'keywords'],
  additionalProperties: false,
}, null, 2);

const DEFAULT_CUSTOM_TOOLS = JSON.stringify([
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '도시의 현재 날씨를 조회한다.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '도시 이름' } },
        required: ['city'],
      },
    },
  },
], null, 2);

const DEFAULTS = {
  baseUrl: 'https://api.exaone.ai/v1',
  model: 'k-exaone_v2.5',
  theme: 'system',
  systemPrompt: '',
  sendReasoning: true,
  expandDetails: false, // 추론·도구 카드를 기본으로 펼쳐 둘지 (기본: 접힘)
  minGapMs: 1100,
  saveLogs: true,
  autoPreview: true,
  autoProgress: true, // 에이전트가 계획을 세우면 오른쪽 진행 탭을 자동으로 연다
  notify: 'unfocused', // 작업 완료 · 질문 · 승인 대기 알림: 'unfocused'(창이 뒤에 있을 때만) | 'always' | 'off'
  maxRetries: 10, // 네트워크 문제 · 요청 한도 · 서버 오류로 실패한 요청을 다시 보내는 횟수 (0 이면 다시 시도하지 않음)
  compact: { auto: true }, // 컨텍스트가 한도에 가까워지면 이전 대화를 요약으로 압축 (기준: 창 − 요약용 20K − 여유 13K)
  params: {
    reasoning_effort: 'high',
    temperature: 1.0,
    top_p: 0.95,
    top_k: -1,
    presence_penalty: 0,
    max_tokens: null,
    stream: true,
    preserve_thinking: false,
  },
  structured: { mode: 'off', name: 'response', strict: true, schema: DEFAULT_SCHEMA },
  agent: {
    approval: 'ask', // readonly | ask | auto
    maxSteps: 25,
    shell: 'auto',
    commandTimeout: 120,
    disabledTools: [],
    toolChoice: 'auto',
    reasoning_effort: 'medium',
  },
  customTools: { enabled: false, json: DEFAULT_CUSTOM_TOOLS },
  ui: { sidebar: true, panel: false, collapsedProjects: [] },
  projects: [], // { id, name, path, instructions, createdAt }
  lastMode: 'chat',
  lastWorkspace: '',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.convDir = path.join(dir, 'conversations');
    fs.mkdirSync(this.convDir, { recursive: true });
    this.settingsFile = path.join(dir, 'settings.json');
    this._settings = null;
  }

  getSettings() {
    if (!this._settings) {
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { /* 첫 실행 */ }
      this._settings = merge(DEFAULTS, saved);
    }
    return this._settings;
  }

  setSettings(patch) {
    this._settings = merge(this.getSettings(), patch);
    writeAtomic(this.settingsFile, JSON.stringify(this._settings, null, 2));
    return this._settings;
  }

  _file(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error('잘못된 대화 ID');
    return path.join(this.convDir, safe + '.json');
  }

  listConvs() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.convDir); } catch { /* 없음 */ }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.convDir, n), 'utf8'));
        const firstUser = (c.messages || []).find((m) => m.role === 'user');
        out.push({
          id: c.id, title: c.title || '새 대화', mode: c.mode || 'chat', projectId: c.projectId || null, workspace: c.workspace || '', cliSession: c.cliSession || null, cliMtime: c.cliMtime || 0,
          createdAt: c.createdAt, updatedAt: c.updatedAt || c.createdAt,
          count: (c.messages || []).length,
          preview: firstUser ? String(firstUser.content || '').slice(0, 200) : '',
        });
      } catch { /* 손상된 파일 건너뜀 */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  loadConv(id) {
    try { return JSON.parse(fs.readFileSync(this._file(id), 'utf8')); } catch { return null; }
  }

  saveConv(conv) {
    writeAtomic(this._file(conv.id), JSON.stringify(conv));
    return true;
  }

  deleteConv(id) {
    try { fs.unlinkSync(this._file(id)); } catch { /* 이미 없음 */ }
    return true;
  }
}

module.exports = { Store, DEFAULTS };
