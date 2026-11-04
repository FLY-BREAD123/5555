// @ts-check
const { gzip, gunzip, isGzip, sha256 } = require('./util');
const { computeStats } = require('./backup');

const FORMAT = 'darkbackup';

function toFileObject({ meta, data, assets }) {
  const inline = {};
  for (const [sha, buf] of assets) if (buf) inline[sha] = buf.toString('base64');
  return { format: FORMAT, version: 1, exportedAt: Date.now(), meta, data, assets: inline };
}

function withoutEmojiImages(bundle) {
  const emojiShas = new Set(bundle.data.emojis.map((e) => e.asset));
  const assets = new Map([...bundle.assets].filter(([sha]) => !emojiShas.has(sha)));
  return { ...bundle, assets };
}

function withoutMessages(bundle) {
  const data = {
    ...bundle.data,
    channels: bundle.data.channels.map(({ messages, posts, ...rest }) => rest),
  };
  return { ...bundle, data };
}

/**
 * 파일로 내보내기. 디코 업로드 제한 넘으면 이모지 → 메시지 순으로 빼고 다시 시도
 * @returns {Promise<{ buffer: Buffer, omitted: string | null }>}
 */
async function exportBundle(bundle, maxBytes) {
  const attempts = [
    { omitted: null, make: (b) => b },
    { omitted: '이모지 이미지', make: withoutEmojiImages },
    { omitted: '이모지 이미지 · 메시지', make: (b) => withoutMessages(withoutEmojiImages(b)) },
  ];
  for (const attempt of attempts) {
    const buffer = await gzip(Buffer.from(JSON.stringify(toFileObject(attempt.make(bundle)))), { level: 9 });
    if (buffer.length <= maxBytes) return { buffer, omitted: attempt.omitted };
  }
  throw new Error('백업이 너무 커서 디스코드 파일 제한을 넘어요.');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isSnowflake = (v) => typeof v === 'string' && /^\d{15,21}$/.test(v);

/** 업로드된 백업 파일 읽기 + 검사 */
async function importBundle(buffer) {
  const raw = isGzip(buffer) ? await gunzip(buffer) : buffer;
  let obj;
  try {
    obj = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('백업 파일을 읽을 수 없어요 (JSON 아님).');
  }
  if (!isObj(obj) || obj.format !== FORMAT) throw new Error('DarkBackup 백업 파일이 아니에요.');
  const { data } = obj;
  if (
    !isObj(data) ||
    !isObj(data.guild) ||
    !isSnowflake(data.guild.id) ||
    !Array.isArray(data.roles) ||
    !Array.isArray(data.channels) ||
    data.roles.length > 300 ||
    data.channels.length > 600
  ) {
    throw new Error('백업 파일 내용이 손상됐어요.');
  }
  data.emojis = Array.isArray(data.emojis) ? data.emojis.slice(0, 600) : [];
  data.bans = Array.isArray(data.bans) ? data.bans.filter((b) => b && isSnowflake(b.id)) : [];
  data.members = Array.isArray(data.members) ? data.members.filter((m) => m && isSnowflake(m.id) && Array.isArray(m.roles)) : [];
  for (const r of data.roles) {
    if (!isObj(r) || !isSnowflake(r.id) || typeof r.name !== 'string') throw new Error('백업 파일의 역할 정보가 손상됐어요.');
    if (!/^\d+$/.test(String(r.permissions))) r.permissions = '0';
  }
  for (const c of data.channels) {
    if (!isObj(c) || !isSnowflake(c.id) || typeof c.name !== 'string' || typeof c.type !== 'number') {
      throw new Error('백업 파일의 채널 정보가 손상됐어요.');
    }
    c.overwrites = Array.isArray(c.overwrites)
      ? c.overwrites.filter((o) => o && isSnowflake(o.id) && /^\d+$/.test(String(o.allow)) && /^\d+$/.test(String(o.deny)))
      : [];
  }

  const assets = new Map();
  if (isObj(obj.assets)) {
    for (const [sha, b64] of Object.entries(obj.assets)) {
      if (typeof b64 !== 'string') continue;
      const buf = Buffer.from(b64, 'base64');
      if (sha256(buf) === sha) assets.set(sha, buf); // 내용이 바뀐 이미지는 버림
    }
  }

  const src = isObj(obj.meta) ? obj.meta : {};
  const meta = {
    id: typeof src.id === 'string' ? src.id.slice(0, 16) : 'FILE',
    version: 1,
    type: 'file',
    note: typeof src.note === 'string' ? src.note.slice(0, 100) : null,
    guildId: data.guild.id,
    guildName: String(data.guild.name || src.guildName || '알 수 없는 서버').slice(0, 100),
    guildIconUrl: null,
    ownerId: isSnowflake(src.ownerId) ? src.ownerId : null,
    creatorId: isSnowflake(src.creatorId) ? src.creatorId : null,
    createdAt: Number(src.createdAt) || Date.now(),
    stats: computeStats(data),
    size: buffer.length,
    assets: [...assets.keys()],
  };
  return { meta, data, assets };
}

module.exports = { exportBundle, importBundle };
