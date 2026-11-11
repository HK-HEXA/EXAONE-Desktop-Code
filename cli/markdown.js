'use strict';
// 터미널용 Markdown: 스트리밍 중에도 줄 단위로 확정해서 출력할 수 있게 만든 가벼운 렌더러.

const { c, strWidth, padEnd, wrapAnsi } = require('./term');

function inline(s) {
  // 코드 스팬은 먼저 떼어 두고, 나머지에만 강조·링크를 적용한다.
  return String(s).split(/(`[^`\n]+`)/g).map((seg, i) => {
    if (i % 2) return c.code(seg.slice(1, -1));
    return seg
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => c.underline(t) + c.dim(` (${u})`))
      .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => c.bold(t))
      .replace(/__([^_\n]+)__/g, (_, t) => c.bold(t))
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, (_, p, t) => p + c.italic(t))
      .replace(/~~([^~\n]+)~~/g, (_, t) => c.strike(t));
  }).join('');
}

/** 한 줄(문단·제목·목록 항목 등)을 폭에 맞춘 여러 줄로 만든다. */
function block(line, width) {
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return [c.dim('─'.repeat(Math.min(width, 40)))];
  let m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (m) {
    const t = inline(m[2].replace(/\s+#+\s*$/, ''));
    return wrapAnsi(m[1].length <= 2 ? c.bold(c.underline(t)) : c.bold(t), width);
  }
  m = /^(\s*)>\s?(.*)$/.exec(line);
  if (m) return wrapAnsi(inline(m[2]), width - 2).map((l) => c.dim('▎ ') + c.italic(l));
  m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (m) {
    const indent = ' '.repeat(Math.min(m[1].length, 12));
    const mark = /^\d/.test(m[2]) ? m[2] : '•';
    const box = m[3] ? (/x/i.test(m[3]) ? '☒ ' : '☐ ') : '';
    const head = indent + (box || mark + ' ');
    const pad = ' '.repeat(strWidth(head));
    return wrapAnsi(inline(m[4]), width - strWidth(head)).map((l, i) => (i ? pad : head) + l);
  }
  return wrapAnsi(inline(line), width);
}

function table(rows, width) {
  const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()));
  const body = cells.filter((r) => !r.every((x) => /^:?-{2,}:?$/.test(x) || x === ''));
  if (!body.length) return [];
  const n = Math.max(...body.map((r) => r.length));
  const data = body.map((r) => Array.from({ length: n }, (_, i) => inline(r[i] || '')));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...data.map((r) => strWidth(r[i]))));
  if (widths.reduce((a, b) => a + b, 0) + 3 * n + 1 > width) return rows.flatMap((r) => wrapAnsi(inline(r), width));
  const rule = (l, m, r) => c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const res = [rule('┌', '┬', '┐')];
  data.forEach((r, i) => {
    res.push(c.dim('│') + r.map((x, j) => ' ' + padEnd(i === 0 ? c.bold(x) : x, widths[j]) + ' ').join(c.dim('│')) + c.dim('│'));
    if (i === 0 && data.length > 1) res.push(rule('├', '┼', '┤'));
  });
  res.push(rule('└', '┴', '┘'));
  return res;
}

/**
 * 스트리밍 텍스트를 받아 "확정된 줄"을 emit 으로 내보낸다.
 * 아직 줄바꿈이 오지 않은 마지막 줄은 pending() 으로 미리 볼 수 있다.
 */
class MdStream {
  constructor(emit, getWidth) {
    this.emit = emit; this.getWidth = getWidth;
    this.buf = ''; this.inCode = false; this.rows = []; this.lastBlank = true; this.started = false;
  }

  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this._line(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
  }

  end() {
    if (this.buf) this._line(this.buf);
    this.buf = '';
    this._flushTable();
  }

  _out(lines) { for (const l of lines) { this.started = true; this.emit(l); } }

  _flushTable() {
    if (!this.rows.length) return;
    const rows = this.rows; this.rows = [];
    this._out(table(rows, this.getWidth()));
    this.lastBlank = false;
  }

  _line(l) {
    if (/^\s*(```|~~~)/.test(l)) {
      this._flushTable();
      this.inCode = !this.inCode;
      return;
    }
    if (this.inCode) { this._out([c.code('  ' + l.replace(/\t/g, '  '))]); this.lastBlank = false; return; }
    if (/^\s*\|.*\|\s*$/.test(l)) { this.rows.push(l); return; }
    this._flushTable();
    if (!l.trim()) {
      if (!this.lastBlank && this.started) this._out(['']);
      this.lastBlank = true;
      return;
    }
    this._out(block(l, this.getWidth()));
    this.lastBlank = false;
  }

  /** 아직 확정되지 않은 부분(표를 모으는 중이거나 쓰는 중인 줄)의 미리보기 */
  pending() {
    const res = [];
    if (this.rows.length) res.push(...table(this.rows, this.getWidth()));
    if (this.buf) res.push(...(this.inCode ? [c.code(this.buf)] : block(this.buf, this.getWidth())));
    return res;
  }
}

function render(text, width) {
  const lines = [];
  const s = new MdStream((l) => lines.push(l), () => width);
  s.push(String(text));
  s.end();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = { inline, block, table, MdStream, render };
