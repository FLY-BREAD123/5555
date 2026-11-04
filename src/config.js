require('dotenv').config();

const num = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim(),
  mongoUri: (process.env.MONGODB_URI || '').trim(),
  mongoDb: (process.env.MONGODB_DB || 'darkbackup').trim(),
  dataDir: process.env.DATA_DIR || './data',
  port: num(process.env.PORT, 3000),
  // Render가 자동으로 넣어주는 주소. 다른 곳에 올리면 SELF_PING_URL 직접 지정
  selfPingUrl: (process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, ''),
  onRender: process.env.RENDER === 'true',
  ownerIds: list(process.env.BOT_OWNER_IDS),
  timezone: process.env.TZ_DISPLAY || 'Asia/Seoul',

  defaults: {
    autoEnabled: String(process.env.AUTO_BACKUP_DEFAULT || 'true').toLowerCase() !== 'false',
    intervalHours: clamp(num(process.env.AUTO_BACKUP_HOURS, 6), 1, 168),
    keep: clamp(num(process.env.AUTO_BACKUP_KEEP, 10), 1, 50),
    messageLimit: clamp(num(process.env.BACKUP_MESSAGES, 20), 0, 100),
  },

  limits: {
    maxManualPerGuild: clamp(num(process.env.MAX_MANUAL_BACKUPS, 20), 1, 200),
    forumPosts: clamp(num(process.env.BACKUP_FORUM_POSTS, 15), 0, 100),
    maxBans: 20000,
    maxDataBytes: 15 * 1024 * 1024, // MongoDB 문서 16MB 제한 여유분
    maxImportBytes: 60 * 1024 * 1024,
  },

  guard: {
    windowMs: 60_000,
    channelDeletes: clamp(num(process.env.GUARD_CHANNEL_DELETES, 5), 2, 100),
    roleDeletes: clamp(num(process.env.GUARD_ROLE_DELETES, 5), 2, 100),
    bans: clamp(num(process.env.GUARD_BANS, 8), 2, 500),
  },

  rejoinDays: clamp(num(process.env.REJOIN_ROLE_DAYS, 30), 1, 365),

  color: {
    main: 0xb478ff,
    ok: 0x4de1ff,
    warn: 0xffb454,
    err: 0xff5c8a,
  },
};
