const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const config = require('./config');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function newId(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_CHARS[b % ID_CHARS.length];
  return out;
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 동시에 limit개씩만 실행 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchBuffer(url, { timeout = 20_000, maxBytes = 30 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error('파일이 너무 큼');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('파일이 너무 큼');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 자동완성처럼 디코 타임스탬프를 못 쓰는 곳용 (기본 한국시간) */
function fmtDate(ms) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: config.timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** 웹훅 이름 규칙(discord/clyde 금지, 1~80자) 맞추기 */
function safeWebhookName(name) {
  let n = String(name || '').replace(/discord/gi, 'dlscord').replace(/clyde/gi, 'c1yde').trim();
  if (/^(everyone|here)$/i.test(n)) n = `${n}_`;
  if (!n) n = '알 수 없음';
  return n.slice(0, 80);
}

/** 백업 속 옛날 ID 멘션을 새 서버 ID로 바꿈 */
function rewriteIds(text, maps) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/<@&(\d{15,21})>/g, (m, id) => (maps.roles.get(id) ? `<@&${maps.roles.get(id)}>` : m))
    .replace(/<#(\d{15,21})>/g, (m, id) => (maps.channels.get(id) ? `<#${maps.channels.get(id)}>` : m))
    .replace(/<(a?):(\w{2,32}):(\d{15,21})>/g, (m, a, name, id) => (maps.emojis.get(id) ? `<${a}:${name}:${maps.emojis.get(id)}>` : m));
}

function rewriteDeep(value, maps) {
  if (typeof value === 'string') return rewriteIds(value, maps);
  if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, maps));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteDeep(v, maps);
    return out;
  }
  return value;
}

const snowflakeCompare = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** 디스코드 API 에러를 사람이 읽을 수 있게 */
function errText(err) {
  if (!err) return '알 수 없는 오류';
  const code = err.code ?? err.rawError?.code;
  const known = {
    50013: '봇 권한 부족',
    50001: '봇이 접근할 수 없음',
    30005: '역할 개수 한도(250) 초과',
    30013: '채널 개수 한도(500) 초과',
    30008: '이모지 슬롯 가득 참',
    30007: '웹훅 개수 한도 초과',
    50035: '입력값 오류',
    50074: '커뮤니티 필수 채널이라 삭제 불가',
    10003: '채널이 이미 없음',
    10011: '역할이 이미 없음',
    10007: '멤버가 서버에 없음',
    10026: '밴 기록 없음',
    50024: '이 채널 종류에선 불가',
  };
  if (err.name === 'RateLimitError') return '레이트리밋 (디스코드가 잠시 막음)';
  const base = known[code] || err.message || String(err);
  return code ? `${base} (${code})` : base;
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const warn = (...args) => console.warn(new Date().toISOString(), '[warn]', ...args);

module.exports = {
  gzip,
  gunzip,
  sleep,
  newId,
  newToken,
  sha256,
  mapLimit,
  fetchBuffer,
  isGzip,
  fmtBytes,
  fmtDate,
  fmtDuration,
  ts,
  truncate,
  safeWebhookName,
  rewriteIds,
  rewriteDeep,
  snowflakeCompare,
  errText,
  log,
  warn,
};
