'use strict';
// 에이전트가 바꾼 파일의 버전 기록 (git 과 비슷한 내용 주소 저장소).
// 대화마다 저장소가 하나씩 있고, 파일마다 v0(에이전트가 손대기 전 원본)부터 변경 때마다 버전이 쌓인다.
//   <root>/<convId>/index.json   파일별 버전 목록
//   <root>/<convId>/blobs/<sha1> 파일 내용

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lineDiff, resolveIn, decodeText } = require('./tools');

const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
const norm = (p) => String(p).split(path.sep).join('/');

class History {
  constructor(root) { this.root = root; }

  _dir(convId) {
    const id = safeId(convId);
    if (!id) throw new Error('잘못된 대화 ID');
    return path.join(this.root, id);
  }

  _load(convId) {
    try { return JSON.parse(fs.readFileSync(path.join(this._dir(convId), 'index.json'), 'utf8')); }
    catch { return { seq: 0, files: {} }; }
  }

  _save(convId, idx) {
    const dir = this._dir(convId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(idx), 'utf8');
    fs.renameSync(file + '.tmp', file);
  }

  _put(convId, text) {
    const sha = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
    const dir = path.join(this._dir(convId), 'blobs');
    const file = path.join(dir, sha);
    if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
    return sha;
  }

  _get(convId, sha) {
    if (!sha) return null;
    return fs.readFileSync(path.join(this._dir(convId), 'blobs', safeId(sha)), 'utf8');
  }

  _text(convId, v) { return v && v.existed ? this._get(convId, v.blob) : null; }

  _disk(workspace, rel) {
    try { return decodeText(fs.readFileSync(resolveIn(workspace, rel))); } catch { return null; }
  }

  /** 파일 변경 한 건을 기록한다. before/after 가 null 이면 그 시점에 파일이 없었다는 뜻. */
  record(convId, { path: rel, before, after, tool, callId }) {
    const idx = this._load(convId);
    const key = norm(rel);
    const f = idx.files[key] || (idx.files[key] = { versions: [] });
    const now = Date.now();
    const push = (v) => { f.versions.push({ n: f.versions.length, ts: now, seq: ++idx.seq, ...v }); };
    const last = f.versions[f.versions.length - 1];
    if (!last) {
      push({ tool: 'baseline', existed: before != null, blob: before != null ? this._put(convId, before) : null, added: 0, removed: 0 });
    } else if (this._text(convId, last) !== before) {
      // 에이전트의 파일 도구 밖에서(명령 실행, 사용자 편집 등) 바뀐 내용
      const d = lineDiff(this._text(convId, last) || '', before || '');
      push({ tool: 'external', existed: before != null, blob: before != null ? this._put(convId, before) : null, added: d.added, removed: d.removed });
    }
    const d = lineDiff(before || '', after || '');
    push({ tool, callId: callId || null, existed: after != null, blob: after != null ? this._put(convId, after) : null, added: d.added, removed: d.removed });
    this._save(convId, idx);
  }

  /** 대화에서 바뀐 파일 목록. 상태와 줄 수는 원본(v0)과 지금 디스크 내용을 비교해 계산한다. */
  summary(convId, workspace) {
    const idx = this._load(convId);
    const files = [];
    for (const [rel, f] of Object.entries(idx.files)) {
      if (!f.versions.length) continue;
      const base = this._text(convId, f.versions[0]);
      const disk = this._disk(workspace, rel);
      const last = this._text(convId, f.versions[f.versions.length - 1]);
      const d = lineDiff(base || '', disk || '');
      let status = 'modified';
      if (base === disk) status = 'unchanged';
      else if (base == null) status = 'added';
      else if (disk == null) status = 'deleted';
      files.push({
        path: rel, status, added: d.added, removed: d.removed,
        dirty: last !== disk, // 마지막 기록 이후 도구 밖에서 바뀜
        lastSeq: f.versions[f.versions.length - 1].seq,
        versions: f.versions.map((v) => ({ n: v.n, ts: v.ts, tool: v.tool, callId: v.callId || null, existed: v.existed, added: v.added, removed: v.removed })),
      });
    }
    files.sort((a, b) => b.lastSeq - a.lastSeq);
    return { files };
  }

  _side(convId, workspace, rel, which) {
    if (which === 'disk') return this._disk(workspace, rel);
    const f = this._load(convId).files[norm(rel)];
    const v = f && f.versions[Number(which)];
    if (!v) throw new Error('버전을 찾을 수 없습니다');
    return this._text(convId, v);
  }

  diff(convId, workspace, rel, from, to) {
    const a = this._side(convId, workspace, rel, from);
    const b = this._side(convId, workspace, rel, to);
    const d = lineDiff(a || '', b || '', 3, 1500);
    return { ...d, fromMissing: a == null, toMissing: b == null, same: a === b };
  }

  /** 파일을 특정 버전 내용으로 되돌린다 (그 버전에 파일이 없었으면 삭제). 되돌린 것도 새 버전으로 남는다. */
  restore(convId, workspace, rel, n) {
    const f = this._load(convId).files[norm(rel)];
    const v = f && f.versions[Number(n)];
    if (!v) throw new Error('버전을 찾을 수 없습니다');
    const abs = resolveIn(workspace, rel);
    const before = this._disk(workspace, rel);
    const after = this._text(convId, v);
    if (before === after) return false;
    if (after == null) { try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, after, 'utf8'); }
    this.record(convId, { path: rel, before, after, tool: 'restore:v' + v.n });
    return true;
  }

  restoreAll(convId, workspace) {
    let count = 0;
    for (const rel of Object.keys(this._load(convId).files)) { if (this.restore(convId, workspace, rel, 0)) count++; }
    return count;
  }

  remove(convId) {
    try { fs.rmSync(this._dir(convId), { recursive: true, force: true }); } catch { /* 없음 */ }
  }
}

module.exports = { History };
