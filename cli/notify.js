'use strict';
// 터미널(EXAONE Code)의 알림: 작업이 끝났거나 사용자의 확인(질문 · 권한)을 기다릴 때 알려 준다.
//   · 터미널 벨(BEL) — 대부분의 터미널이 탭 · 작업 표시줄에 표시하거나 소리를 낸다
//   · 시스템 알림 — Windows: 알림 센터(PowerShell), macOS: osascript, Linux: notify-send
// 터미널이 "포커스 알림"(DECSET 1004)을 지원하면 창이 앞에 있는 동안에는 알리지 않는다.

const { spawn } = require('child_process');

const xml = (s) => String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function run(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* 알리지 못해도 작업에는 지장이 없다 */ }
}

/** 시스템 알림을 띄운다 (되는 만큼만, 실패해도 조용히 넘어간다). */
function osNotify(title, body) {
  title = clip(title, 80); body = clip(body, 200);
  if (process.platform === 'win32') {
    // Windows PowerShell 에 등록된 앱 식별자를 빌려 알림 센터에 띄운다 (따로 설치할 것이 없다).
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${xml(title).replace(/'/g, "''")}</text><text>${xml(body).replace(/'/g, "''")}</text></binding></visual></toast>')`,
      "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]);
  } else if (process.platform === 'darwin') {
    const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    run('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`]);
  } else {
    run('notify-send', ['-a', 'EXAONE Code', title, body]);
  }
}

class Notifier {
  /** @param {{ enabled: boolean, out?: NodeJS.WriteStream }} opt */
  constructor(opt = {}) {
    this.enabled = opt.enabled !== false;
    this.out = opt.out || process.stdout;
    this.focused = null;   // true/false: 터미널이 알려 준 포커스 상태, null: 알 수 없음(지원하지 않는 터미널)
    this.pending = null;
  }

  /** 터미널에 포커스 변화를 알려 달라고 한다. */
  start() { if (this.out.isTTY) this.out.write('\x1b[?1004h'); }
  stop() { this.cancel(); if (this.out.isTTY) this.out.write('\x1b[?1004l'); }

  /** 터미널이 보낸 포커스 신호면 처리하고 true (입력으로 다루지 않게). */
  key(seq) {
    if (seq === '\x1b[I') { this.focused = true; this.cancel(); return true; }
    if (seq === '\x1b[O') { this.focused = false; return true; }
    return false;
  }

  /**
   * 알린다. 창이 앞에 있으면 알리지 않고, 뒤에 있으면 바로 알린다.
   * 포커스를 알 수 없는 터미널에서는 waitMs 뒤에도 아직 유효하면(still 이 true 를 돌려주면) 알린다.
   */
  notify(title, body, { waitMs = 0, still } = {}) {
    if (!this.enabled) return;
    this.cancel();
    if (this.focused === true) return;
    const fire = () => {
      this.pending = null;
      if (this.focused === true || (still && !still())) return;
      try { this.out.write('\x07'); } catch { /* 무시 */ }
      osNotify(title, body);
    };
    if (this.focused === false || !waitMs) fire();
    else { this.pending = setTimeout(fire, waitMs); if (this.pending.unref) this.pending.unref(); }
  }

  cancel() { clearTimeout(this.pending); this.pending = null; }
}

module.exports = { Notifier, osNotify };
