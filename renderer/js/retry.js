// 요청이 네트워크 문제 등으로 실패했을 때 다시 시도하는 규칙 — 데스크톱 앱(화면)과 EXAONE Code(터미널)가 같이 쓴다.
// Claude Code 와 같은 방식: 연결 오류·시간 초과·408·409·429·5xx 는 최대 10번까지,
// 0.5초에서 시작해 두 배씩(최대 32초, 약간의 무작위 지연 포함) 늘려 가며 다시 보낸다. 서버가 기다릴 시간을 알려 주면 그 시간을 따른다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Retry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_RETRIES = 10;
  const BASE_MS = 500;
  const MAX_MS = 32000;
  const RETRY_AFTER_MAX_MS = 60000; // 서버가 이보다 오래 기다리라고 하면 기다리지 않고 오류로 알린다

  /** err: { status, network, retryAfterMs } — 다시 보내면 될 만한 실패인가 */
  function retryable(err) {
    if (!err) return false;
    if (err.network) return true;
    const s = Number(err.status) || 0;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }

  /** attempt 번째(1부터) 다시 시도까지 기다릴 시간(ms). 다시 시도하지 않을 실패면 null. */
  function delay(err, attempt, max) {
    const limit = max == null ? MAX_RETRIES : max;
    if (!retryable(err) || attempt > limit) return null;
    const ra = Number(err.retryAfterMs) || 0;
    if (ra > 0) return ra <= RETRY_AFTER_MAX_MS ? ra + 150 : null;
    const base = Math.min(BASE_MS * Math.pow(2, attempt - 1), MAX_MS);
    return Math.round(base + Math.random() * 0.25 * base);
  }

  /** 화면에 보여 줄 짧은 원인 */
  function reason(err) {
    const s = Number(err && err.status) || 0;
    if (err && err.network) return '연결 오류';
    if (s === 429) return '요청 한도 초과';
    if (s === 408) return '요청 시간 초과';
    if (s === 529 || s === 503) return `서버 과부하 (HTTP ${s})`;
    if (s >= 500) return `서버 오류 (HTTP ${s})`;
    return s ? `HTTP ${s}` : '오류';
  }

  /** "API 오류 (연결 오류) · 4초 후 다시 시도… (시도 2/10)" */
  function label(info, leftMs) {
    const sec = Math.max(0, Math.ceil((leftMs || 0) / 1000));
    return `API 오류 (${(info && info.reason) || '오류'}) · ${sec}초 후 다시 시도… (시도 ${(info && info.attempt) || 1}/${(info && info.max) || MAX_RETRIES})`;
  }

  return { MAX_RETRIES, BASE_MS, MAX_MS, RETRY_AFTER_MAX_MS, retryable, delay, reason, label };
});
