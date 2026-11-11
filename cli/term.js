'use strict';
// 터미널 기본기: 색, 글자 폭(한글 2칸), 줄바꿈, 화면 아래쪽 고정 영역(footer) 다시 그리기.

const out = process.stdout;
let colorOn = !!out.isTTY && !process.env.NO_COLOR;
const setColor = (v) => { colorOn = !!v; };

const sgr = (open, close) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), italic: sgr(3, 23), underline: sgr(4, 24), inverse: sgr(7, 27), strike: sgr(9, 29),
  red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39),
  gray: sgr(90, 39), white: sgr(97, 39),
  brand: sgr('38;5;147', 39),   // Showroom 라벤더 (ANSI 256색 근사값)
  code: sgr('38;5;111', 39),
  plan: sgr('38;5;73', 39),
  accept: sgr('38;5;141', 39),
  warn: sgr('38;5;214', 39),
  bash: sgr('38;5;205', 39),
  memory: sgr('38;5;75', 39),
  bgAdd: sgr('48;5;22', 49), bgDel: sgr('48;5;52', 49), bgUser: sgr('48;5;237', 49),
  /** 전경색 코드를 직접 지정 (구문 강조용) */
  colorize: (code, s) => (colorOn ? `\x1b[${code}m${s}\x1b[39m` : String(s)),
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || cp === 0xfe0e) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** 보이는 폭이 width 를 넘으면 … 로 자른다 (ANSI 코드는 유지). */
function truncate(s, width) {
  s = String(s);
  if (strWidth(s) <= width) return s;
  let w = 0, res = '';
  const re = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t.length > 1 && t[0] === '\x1b') { res += t; continue; }
    const cw = charWidth(t.codePointAt(0));
    if (w + cw > width - 1) break;
    res += t; w += cw;
  }
  return res + '…' + (colorOn ? '\x1b[0m' : '');
}
const padEnd = (s, width) => s + ' '.repeat(Math.max(0, width - strWidth(s)));

/** ANSI 코드를 건드리지 않고 보이는 폭 기준으로 줄을 나눈다. 공백과 한글 글자 사이에서 끊는다. */
function wrapAnsi(text, width) {
  width = Math.max(4, width);
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '', w = 0, brk = -1;
    const re = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
    let m;
    while ((m = re.exec(para))) {
      const t = m[0];
      if (t.length > 1 && t[0] === '\x1b') { cur += t; continue; }
      const cw = charWidth(t.codePointAt(0));
      if (w + cw > width && w > 0) {
        if (t === ' ') { lines.push(cur); cur = ''; w = 0; brk = -1; continue; }
        if (brk > 0) {
          lines.push(cur.slice(0, brk).replace(/ +$/, ''));
          cur = cur.slice(brk).replace(/^ +/, '');
          w = strWidth(cur);
        } else { lines.push(cur); cur = ''; w = 0; }
        brk = -1;
      }
      if (t === ' ') { cur += t; w += 1; brk = cur.length; }
      else {
        // 한자·가나는 글자 사이에서 끊어도 되지만, 한글은 띄어쓰기에서 끊는 편이 읽기 좋다.
        const cp = t.codePointAt(0);
        if (cw === 2 && w > 0 && !(cp >= 0xac00 && cp <= 0xd7a3)) brk = cur.length;
        cur += t; w += cw;
      }
    }
    lines.push(cur);
  }
  return lines;
}

/** 둥근 테두리 상자. lines 는 이미 폭에 맞춰 나뉜 줄들. */
function box(lines, width, color = c.dim) {
  const inner = width - 4;
  const res = [color('╭' + '─'.repeat(width - 2) + '╮')];
  for (const l of lines) res.push(color('│') + ' ' + padEnd(truncate(l, inner), inner) + ' ' + color('│'));
  res.push(color('╰' + '─'.repeat(width - 2) + '╯'));
  return res;
}

/**
 * 화면 맨 아래의 고정 영역. 위쪽 기록은 평범하게 출력하고, 이 영역만 제자리에서 다시 그린다.
 * anchor 를 켜면 기록이 짧아도 이 영역을 터미널의 맨 아랫줄에 붙여 그린다 (사이는 빈 줄로 채운다).
 */
class Screen {
  constructor() { this.rows = 0; this.curRow = 0; this.lines = null; this.cursor = null; this.split = 0; this.top = 0; this.anchor = false; }
  get cols() { return Math.max(24, out.columns || 80); }
  get height() { return Math.max(8, out.rows || 24); }

  /** 화면을 통째로 지운 뒤 부른다: 기록이 맨 윗줄부터 다시 시작한다. */
  reset() { this.rows = 0; this.curRow = 0; this.top = 0; }

  /** text 를 출력하면 차지할 터미널 줄 수 (폭을 넘는 줄은 접혀서 여러 줄이 된다) */
  _rowsOf(text) {
    const cols = out.columns || 80;
    let n = 0;
    for (const l of String(text).split('\n')) n += Math.max(1, Math.ceil(strWidth(l) / cols));
    return n;
  }

  _clearSeq() {
    if (!this.rows) return '';
    let s = '\r';
    if (this.curRow > 0) s += `\x1b[${this.curRow}A`;
    this.rows = 0; this.curRow = 0;
    return s + '\x1b[J';
  }

  _drawSeq(lines, cursor, split = 0) {
    if (!lines || !lines.length) return '\x1b[?25h';
    const max = this.cols - 1;
    const limit = this.height - 1;
    if (lines.length > limit) {
      const cutTop = lines.length - limit;
      lines = lines.slice(cutTop);
      split = Math.max(0, split - cutTop);
      if (cursor) cursor = { row: Math.max(0, cursor.row - cutTop), col: cursor.col };
    }
    // top: 이 영역이 시작하는 화면 줄. 아래에 남는 줄이 있으면 빈 줄을 앞에 채워 맨 아래로 내린다.
    const H = this.height;
    if (this.anchor) {
      this.top = Math.min(this.top, H - 1);
      const pad = Math.max(0, H - this.top - lines.length);
      if (pad) {
        // 빈 줄은 split 번째 줄 앞에 넣는다: 그 앞쪽(진행 중인 출력)은 기록 바로 아래에, 뒤쪽(입력창)은 맨 아래에 온다.
        lines = lines.slice(0, split).concat(Array(pad).fill(''), lines.slice(split));
        if (cursor && cursor.row >= split) cursor = { row: cursor.row + pad, col: cursor.col };
      }
    }
    let s = lines.map((l) => truncate(l, max)).join('\n');
    let row = lines.length - 1;
    if (cursor) {
      const up = lines.length - 1 - cursor.row;
      s += '\r';
      if (up > 0) s += `\x1b[${up}A`;
      if (cursor.col > 0) s += `\x1b[${Math.min(cursor.col, max)}C`;
      s += '\x1b[?25h';
      row = cursor.row;
    } else s += '\x1b[?25l';
    this.rows = lines.length; this.curRow = row;
    // 영역이 화면보다 아래로 넘치면 터미널이 그만큼 밀려 올라간다.
    this.top = Math.max(0, Math.min(this.top, H - lines.length));
    return s;
  }

  /** 기록 영역에 출력 (footer 는 지웠다가 다시 그린다). */
  print(text = '') {
    const lines = this.lines, cursor = this.cursor;
    const head = this._clearSeq() + text + '\n';
    this.top = Math.min(this.top + this._rowsOf(text), this.height - 1);
    out.write(head + (lines ? this._drawSeq(lines, cursor, this.split) : ''));
  }

  /** split: 맨 아래에 붙일 부분이 시작하는 줄 번호 (anchor 일 때만 뜻이 있다) */
  draw(lines, cursor, split = 0) {
    this.lines = lines && lines.length ? lines : null;
    this.cursor = cursor || null;
    this.split = split;
    out.write(this._clearSeq() + (this.lines ? this._drawSeq(this.lines, this.cursor, split) : '\x1b[?25h'));
  }

  clear() { this.lines = null; this.cursor = null; out.write(this._clearSeq() + '\x1b[?25h'); }
}

module.exports = { c, setColor, stripAnsi, charWidth, strWidth, truncate, padEnd, wrapAnsi, box, Screen };
