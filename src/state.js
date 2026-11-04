const { newToken } = require('./util');

/** 서버별 작업 잠금 (백업 중에 복구 못 하게 등) */
const locks = new Map(); // guildId -> 'backup' | 'restore'

function lock(guildId, kind) {
  if (locks.has(guildId)) return false;
  locks.set(guildId, kind);
  return true;
}

function unlock(guildId) {
  locks.delete(guildId);
}

/** 복구 확인 버튼 대기 */
const pending = new Map(); // token -> { ..., expiresAt }
const PENDING_MS = 3 * 60_000;

function addPending(data) {
  const token = newToken();
  pending.set(token, { ...data, expiresAt: Date.now() + PENDING_MS });
  return token;
}

function takePending(token) {
  const p = pending.get(token);
  if (!p || p.expiresAt < Date.now()) {
    pending.delete(token);
    return null;
  }
  return p;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of pending) if (p.expiresAt < now) pending.delete(token);
}, 60_000).unref();

module.exports = { locks, lock, unlock, pending, addPending, takePending, PENDING_MS };
