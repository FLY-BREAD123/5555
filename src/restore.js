// @ts-check
const { ChannelType, OverwriteType, ChannelFlags } = require('discord.js');
const config = require('./config');
const { fetchAllBans } = require('./backup');
const { mapLimit, safeWebhookName, rewriteIds, rewriteDeep, truncate, errText, warn } = require('./util');

const REASON = 'DarkBackup 백업 복구';

const PHASES = [
  ['roles', '역할'],
  ['emojis', '이모지'],
  ['channels', '채널'],
  ['settings', '서버 설정'],
  ['members', '멤버 역할'],
  ['bans', '밴'],
  ['messages', '메시지'],
  ['cleanup', '마무리'],
];

const T = ChannelType;
const TEXT_LIKE = new Set([T.GuildText, T.GuildAnnouncement]);
const VOICE_LIKE = new Set([T.GuildVoice, T.GuildStageVoice]);
const FORUM_LIKE = new Set([T.GuildForum, T.GuildMedia]);

class RestoreContext {
  /**
   * @param {{ guild: import('discord.js').Guild, bundle: any, options?: any, invokingChannelId?: string | null, onUpdate?: (ctx: RestoreContext) => void }} p
   */
  constructor({ guild, bundle, options = {}, invokingChannelId = null, onUpdate = undefined }) {
    this.guild = guild;
    this.meta = bundle.meta;
    this.data = bundle.data;
    /** @type {Map<string, Buffer>} */
    this.assets = bundle.assets || new Map();
    this.opts = { mode: 'sync', messages: true, unban: false, ...options };
    this.sameGuild = guild.id === this.data.guild.id;
    this.maps = { roles: new Map(), channels: new Map(), emojis: new Map() };
    this.tagMaps = new Map(); // 옛 채널 id -> Map(옛 태그 id -> 새 태그 id)
    this.created = new Set(); // 이번에 새로 만든 채널 (옛 id)
    this.deferred = []; // 마지막에 지울 채널 id
    this.pendingFlags = new Map(); // 새 채널 id -> flags (태그 필수 같은 건 메시지 복구 후 적용)
    this.memberOverwrites = []; // 서버에 없는 멤버 전용 권한 → 다시 들어오면 적용
    this.absent = []; // 서버에 없는 멤버의 역할 → 다시 들어오면 지급
    this.warnings = [];
    this.invokingChannelId = invokingChannelId;
    this.onUpdate = onUpdate;
    this.phase = {};
    this.started = Date.now();
    this.finished = 0;
    this.error = null;
    this.stats = {
      roles: { created: 0, updated: 0, deleted: 0, failed: 0, skipped: 0 },
      emojis: { created: 0, reused: 0, failed: 0, skipped: 0 },
      channels: { created: 0, updated: 0, deleted: 0, failed: 0, fallback: 0 },
      members: { granted: 0, failed: 0, later: 0 },
      bans: { added: 0, removed: 0, failed: 0 },
      messages: { total: 0, sent: 0, failed: 0 },
    };
  }

  warn(text) {
    if (this.warnings.length < 60) this.warnings.push(text);
  }

  set(key, status, text) {
    this.phase[key] = { status, text: text ?? this.phase[key]?.text ?? null };
    try {
      this.onUpdate?.(this);
    } catch {
      /* 무시 */
    }
  }

  get me() {
    return /** @type {import('discord.js').GuildMember} */ (this.guild.members.me);
  }

  botTop() {
    return this.me.roles.highest.position;
  }
}

async function runPhase(ctx, key, fn) {
  ctx.set(key, 'run', null);
  try {
    const text = await fn(ctx);
    const current = ctx.phase[key]?.status;
    ctx.set(key, current === 'warn' || current === 'skip' ? current : 'done', text ?? null);
  } catch (e) {
    const label = PHASES.find(([k]) => k === key)?.[1] || key;
    ctx.warn(`${label} 단계 오류: ${errText(e)}`);
    ctx.set(key, 'warn', errText(e));
    warn(`[restore] ${key}`, e);
  }
}

// =====================================================================
// 역할
// =====================================================================
function colorsFor(r, gradient) {
  const c = r.colors || { primaryColor: r.color ?? 0 };
  const out = { primaryColor: c.primaryColor ?? 0 };
  if (gradient && c.secondaryColor != null) out.secondaryColor = c.secondaryColor;
  if (gradient && c.tertiaryColor != null) out.tertiaryColor = c.tertiaryColor;
  return out;
}

function roleDiff(role, r, gradient) {
  const patch = {};
  if (role.name !== r.name) patch.name = r.name;
  if (role.hoist !== Boolean(r.hoist)) patch.hoist = Boolean(r.hoist);
  if (role.mentionable !== Boolean(r.mentionable)) patch.mentionable = Boolean(r.mentionable);
  if (role.permissions.bitfield !== BigInt(r.permissions)) patch.permissions = BigInt(r.permissions);
  const cur = role.colors || { primaryColor: role.color, secondaryColor: null, tertiaryColor: null };
  const want = colorsFor(r, gradient);
  const colorChanged =
    cur.primaryColor !== want.primaryColor ||
    (gradient && ((cur.secondaryColor ?? null) !== (want.secondaryColor ?? null) || (cur.tertiaryColor ?? null) !== (want.tertiaryColor ?? null)));
  if (colorChanged) {
    patch.colors = {
      primaryColor: want.primaryColor,
      secondaryColor: want.secondaryColor ?? null,
      tertiaryColor: want.tertiaryColor ?? null,
    };
  }
  return Object.keys(patch).length ? patch : null;
}

/** @param {RestoreContext} ctx */
async function restoreRoles(ctx) {
  const { guild, data, sameGuild, opts } = ctx;
  const s = ctx.stats.roles;
  const backupRoles = [...data.roles].sort((a, b) => b.position - a.position);
  const backupIds = new Set(backupRoles.map((r) => r.id));
  ctx.maps.roles.set(data.guild.id, guild.id); // @everyone

  // 1) 전체 복구: 백업에 없는 역할 삭제 (테러범이 만든 역할 등)
  if (opts.mode === 'sync') {
    const victims = [...guild.roles.cache.values()].filter(
      (r) => r.id !== guild.id && !r.managed && !ctx.me.roles.cache.has(r.id) && !(sameGuild && backupIds.has(r.id)),
    );
    let i = 0;
    for (const role of victims) {
      i++;
      if (role.position >= ctx.botTop()) {
        s.skipped++;
        continue;
      }
      try {
        await role.delete(REASON);
        s.deleted++;
      } catch (e) {
        s.failed++;
        ctx.warn(`역할 삭제 실패 @${role.name}: ${errText(e)}`);
      }
      if (i % 5 === 0) ctx.set('roles', 'run', `정리 중 ${i}/${victims.length}`);
    }
    if (s.skipped) ctx.warn(`봇 역할보다 높은 역할 ${s.skipped}개는 건드리지 못했어요 (서버 설정 → 역할에서 봇 역할을 맨 위로 올려주세요)`);
  }

  // 2) 높은 역할부터 만들기/고치기 → 새 역할은 맨 아래에 생기므로 순서가 그대로 유지됨
  const canIcon = guild.features.includes('ROLE_ICONS');
  const gradient = guild.features.includes('ENHANCED_ROLE_COLORS');
  let i = 0;
  for (const r of backupRoles) {
    i++;
    if (r.everyone) {
      const everyone = guild.roles.everyone;
      if (opts.mode === 'sync' && everyone.permissions.bitfield !== BigInt(r.permissions)) {
        try {
          await everyone.setPermissions(BigInt(r.permissions), REASON);
          s.updated++;
        } catch (e) {
          ctx.warn(`@everyone 권한 복구 실패: ${errText(e)}`);
        }
      }
      continue;
    }

    if (r.managed) {
      // 봇/부스터 역할은 만들 수 없음 → 같은 봇의 역할에 연결만
      const match = guild.roles.cache.find(
        (x) =>
          x.managed &&
          ((r.botId && x.tags?.botId === r.botId) || (r.premium && x.tags?.premiumSubscriberRole) || x.name === r.name),
      );
      if (match) ctx.maps.roles.set(r.id, match.id);
      continue;
    }

    const existing = sameGuild ? guild.roles.cache.get(r.id) : null;
    if (existing && !existing.managed) {
      ctx.maps.roles.set(r.id, existing.id);
      if (opts.mode === 'sync' && existing.position < ctx.botTop()) {
        const patch = roleDiff(existing, r, gradient);
        if (patch) {
          try {
            await existing.edit({ ...patch, reason: REASON });
            s.updated++;
          } catch (e) {
            s.failed++;
            ctx.warn(`역할 수정 실패 @${r.name}: ${errText(e)}`);
          }
        }
      }
      continue;
    }

    if (opts.mode === 'add') {
      const byName = guild.roles.cache.find((x) => !x.managed && x.id !== guild.id && x.name === r.name);
      if (byName) {
        ctx.maps.roles.set(r.id, byName.id);
        continue;
      }
    }

    const base = {
      name: r.name,
      colors: colorsFor(r, gradient),
      hoist: Boolean(r.hoist),
      mentionable: Boolean(r.mentionable),
      permissions: BigInt(r.permissions),
      reason: REASON,
    };
    const iconBuf = canIcon && r.icon ? ctx.assets.get(r.icon) : null;
    const withIcon = iconBuf ? { ...base, icon: iconBuf } : canIcon && r.unicodeEmoji ? { ...base, unicodeEmoji: r.unicodeEmoji } : base;
    try {
      let created;
      try {
        created = await guild.roles.create(withIcon);
      } catch (e) {
        if (withIcon === base) throw e;
        created = await guild.roles.create(base); // 아이콘 문제면 아이콘 빼고 다시
      }
      ctx.maps.roles.set(r.id, created.id);
      s.created++;
    } catch (e) {
      s.failed++;
      ctx.warn(`역할 생성 실패 @${r.name}: ${errText(e)}`);
      if (e.code === 30005) break; // 역할 250개 한도
    }
    if (i % 3 === 0) ctx.set('roles', 'run', `${i}/${backupRoles.length}`);
  }

  await fixRolePositions(ctx);
  return `생성 ${s.created} · 수정 ${s.updated} · 삭제 ${s.deleted}${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

/** 봇 역할 아래 역할들을 백업 순서대로 정렬 */
/** @param {RestoreContext} ctx */
async function fixRolePositions(ctx) {
  const { guild, data } = ctx;
  await guild.roles.fetch();
  const top = ctx.botTop();
  const movable = new Map([...guild.roles.cache.values()].filter((r) => r.id !== guild.id && r.position < top).map((r) => [r.id, r]));
  const seen = new Set();
  const mapped = [];
  for (const r of [...data.roles].sort((a, b) => b.position - a.position)) {
    if (r.everyone) continue;
    const id = ctx.maps.roles.get(r.id);
    if (id && movable.has(id) && !seen.has(id)) {
      seen.add(id);
      mapped.push(id);
    }
  }
  const extras = [...movable.values()]
    .filter((r) => !seen.has(r.id))
    .sort((a, b) => b.position - a.position)
    .map((r) => r.id);
  const final = [...extras, ...mapped];
  const current = [...movable.values()].sort((a, b) => b.position - a.position).map((r) => r.id);
  if (final.join() === current.join()) return;
  try {
    await guild.roles.setPositions(final.map((id, index) => ({ role: id, position: final.length - index })));
  } catch (e) {
    ctx.warn(`역할 순서 정리 실패: ${errText(e)}`);
  }
}

// =====================================================================
// 이모지
// =====================================================================
/** @param {RestoreContext} ctx */
async function restoreEmojis(ctx) {
  const { guild, data, sameGuild } = ctx;
  const s = ctx.stats.emojis;
  const list = data.emojis || [];
  if (!list.length) {
    ctx.set('emojis', 'skip');
    return '백업에 이모지 없음';
  }
  const current = await guild.emojis.fetch();
  const limit = [50, 100, 150, 250][guild.premiumTier] ?? 50;
  const count = {
    static: current.filter((e) => !e.animated).size,
    animated: current.filter((e) => e.animated).size,
  };
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (sameGuild && current.has(e.id)) {
      ctx.maps.emojis.set(e.id, e.id);
      s.reused++;
      continue;
    }
    const byName = current.find((x) => x.name === e.name && Boolean(x.animated) === Boolean(e.animated));
    if (byName) {
      ctx.maps.emojis.set(e.id, byName.id);
      s.reused++;
      continue;
    }
    const kind = e.animated ? 'animated' : 'static';
    const buf = e.asset ? ctx.assets.get(e.asset) : null;
    if (!buf || count[kind] >= limit) {
      s.skipped++;
      continue;
    }
    try {
      const created = await guild.emojis.create({ attachment: buf, name: e.name, reason: REASON });
      ctx.maps.emojis.set(e.id, created.id);
      count[kind]++;
      s.created++;
    } catch (err) {
      if (err.name === 'RateLimitError') {
        const left = list.length - i;
        s.skipped += left;
        ctx.warn(`이모지 ${left}개는 디스코드 업로드 제한 때문에 못 올렸어요. 몇 시간 뒤 같은 백업으로 /백업 복구 모드:추가만 하면 이어서 올라가요.`);
        ctx.set('emojis', 'warn');
        break;
      }
      if (err.code === 30008) {
        count[kind] = limit;
        s.skipped++;
        continue;
      }
      s.failed++;
    }
    if (i % 5 === 0) ctx.set('emojis', 'run', `${i + 1}/${list.length}`);
  }
  if (s.skipped && ctx.phase.emojis?.status !== 'warn') ctx.warn(`이모지 ${s.skipped}개는 슬롯 부족 등으로 건너뜀`);
  return `생성 ${s.created} · 기존 ${s.reused}${s.skipped ? ` · 건너뜀 ${s.skipped}` : ''}${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

// =====================================================================
// 채널
// =====================================================================
function maxBitrate(guild, type) {
  if (type === T.GuildStageVoice) return 64_000;
  return [96_000, 128_000, 256_000, 384_000][guild.premiumTier] ?? 96_000;
}

/** 서버 기능에 따라 만들 수 있는 채널 종류 순서 */
function typePlan(ctx, type) {
  const f = ctx.guild.features;
  const community = f.includes('COMMUNITY');
  const news = community || f.includes('NEWS');
  switch (type) {
    case T.GuildText:
    case T.GuildVoice:
    case T.GuildCategory:
      return [type];
    case T.GuildAnnouncement:
      return news ? [T.GuildAnnouncement, T.GuildText] : [T.GuildText];
    case T.GuildStageVoice:
      return community ? [T.GuildStageVoice, T.GuildVoice] : [T.GuildVoice];
    case T.GuildForum:
      return [T.GuildForum, T.GuildText];
    case T.GuildMedia:
      return [T.GuildMedia, T.GuildForum, T.GuildText];
    default:
      return [T.GuildText];
  }
}

function mapEmojiRef(ctx, e) {
  if (!e) return null;
  if (e.id) {
    const id = ctx.maps.emojis.get(e.id);
    return id ? { id, name: null } : null;
  }
  return e.name ? { id: null, name: e.name } : null;
}

function mapTags(ctx, tags) {
  return (tags || []).slice(0, 20).map((t) => ({
    name: String(t.name).slice(0, 20),
    moderated: Boolean(t.moderated),
    emoji: mapEmojiRef(ctx, t.emoji),
  }));
}

/** 권한 덮어쓰기: 옛 역할 id → 새 역할 id. 서버에 없는 멤버 것은 따로 모아둠 */
/** @param {RestoreContext} ctx */
function mapOverwrites(ctx, list) {
  const out = [];
  const absentMembers = [];
  const seen = new Set();
  for (const ow of list || []) {
    if (ow.type === OverwriteType.Role) {
      const id = ow.id === ctx.data.guild.id ? ctx.guild.id : ctx.maps.roles.get(ow.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, type: OverwriteType.Role, allow: BigInt(ow.allow), deny: BigInt(ow.deny) });
    } else if (ctx.guild.members.cache.has(ow.id)) {
      if (seen.has(ow.id)) continue;
      seen.add(ow.id);
      out.push({ id: ow.id, type: OverwriteType.Member, allow: BigInt(ow.allow), deny: BigInt(ow.deny) });
    } else {
      absentMembers.push(ow);
    }
  }
  return { overwrites: out, absentMembers };
}

function sameOverwrites(cache, wanted) {
  const norm = (arr) =>
    arr
      .map((o) => `${o.id}:${o.type}:${BigInt(o.allow)}:${BigInt(o.deny)}`)
      .sort()
      .join('|');
  const current = [...cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
  return norm(current) === norm(wanted);
}

/** @param {RestoreContext} ctx @param {import('discord.js').NonThreadGuildBasedChannel} ch */
function channelDiff(ctx, ch, c, parentId, overwrites) {
  const p = {};
  if (ch.name !== c.name) p.name = c.name;
  if (ch.type !== T.GuildCategory && (ch.parentId ?? null) !== (parentId ?? null)) p.parent = parentId ?? null;
  if ('topic' in ch && (TEXT_LIKE.has(ch.type) || FORUM_LIKE.has(ch.type)) && (ch.topic ?? null) !== (c.topic ?? null)) {
    p.topic = c.topic ?? null;
  }
  if ('nsfw' in ch && Boolean(ch.nsfw) !== Boolean(c.nsfw)) p.nsfw = Boolean(c.nsfw);
  if ('rateLimitPerUser' in ch && ch.type !== T.GuildAnnouncement && (ch.rateLimitPerUser ?? 0) !== (c.rateLimitPerUser ?? 0)) {
    p.rateLimitPerUser = c.rateLimitPerUser ?? 0;
  }
  if (ch.isVoiceBased()) {
    if (c.bitrate && ch.bitrate !== c.bitrate) p.bitrate = Math.min(c.bitrate, maxBitrate(ctx.guild, ch.type));
    if ((ch.userLimit ?? 0) !== (c.userLimit ?? 0)) p.userLimit = c.userLimit ?? 0;
  }
  if (!sameOverwrites(ch.permissionOverwrites.cache, overwrites)) p.permissionOverwrites = overwrites;
  return p;
}

function createOptions(ctx, c, type, parentId, overwrites) {
  /** @type {any} */
  const o = { name: c.name, type, permissionOverwrites: overwrites, reason: REASON };
  if (type !== T.GuildCategory && parentId) o.parent = parentId;
  if (Number.isFinite(c.position)) o.position = c.position;
  if (TEXT_LIKE.has(type)) {
    if (c.topic) o.topic = truncate(c.topic, 1024);
    o.nsfw = Boolean(c.nsfw);
    if (type === T.GuildText && c.rateLimitPerUser) o.rateLimitPerUser = c.rateLimitPerUser;
    if (c.defaultAutoArchiveDuration) o.defaultAutoArchiveDuration = c.defaultAutoArchiveDuration;
    if (type === T.GuildText && c.defaultThreadRateLimitPerUser) o.defaultThreadRateLimitPerUser = c.defaultThreadRateLimitPerUser;
  } else if (VOICE_LIKE.has(type)) {
    if (c.bitrate) o.bitrate = Math.max(8000, Math.min(c.bitrate, maxBitrate(ctx.guild, type)));
    if (c.userLimit) o.userLimit = type === T.GuildVoice ? Math.min(c.userLimit, 99) : c.userLimit;
    if (c.rtcRegion) o.rtcRegion = c.rtcRegion;
    if (type === T.GuildVoice) {
      if (c.videoQualityMode) o.videoQualityMode = c.videoQualityMode;
      o.nsfw = Boolean(c.nsfw);
      if (c.rateLimitPerUser) o.rateLimitPerUser = c.rateLimitPerUser;
    }
  } else if (FORUM_LIKE.has(type)) {
    if (c.topic) o.topic = truncate(c.topic, 4096);
    o.nsfw = Boolean(c.nsfw);
    if (c.rateLimitPerUser) o.rateLimitPerUser = c.rateLimitPerUser;
    if (c.availableTags?.length) o.availableTags = mapTags(ctx, c.availableTags);
    const reaction = mapEmojiRef(ctx, c.defaultReactionEmoji);
    if (reaction) o.defaultReactionEmoji = reaction;
    if (c.defaultSortOrder != null) o.defaultSortOrder = c.defaultSortOrder;
    if (type === T.GuildForum && c.defaultForumLayout != null) o.defaultForumLayout = c.defaultForumLayout;
    if (c.defaultThreadRateLimitPerUser) o.defaultThreadRateLimitPerUser = c.defaultThreadRateLimitPerUser;
    if (c.defaultAutoArchiveDuration) o.defaultAutoArchiveDuration = c.defaultAutoArchiveDuration;
  }
  return o;
}

function rememberTags(ctx, c, ch) {
  if (!c.availableTags?.length || !Array.isArray(ch.availableTags)) return;
  const map = new Map();
  c.availableTags.slice(0, 20).forEach((t, index) => {
    const match = ch.availableTags.find((x) => x.name === String(t.name).slice(0, 20)) || ch.availableTags[index];
    if (match) map.set(t.id, match.id);
  });
  ctx.tagMaps.set(c.id, map);
}

/** @param {RestoreContext} ctx @param {any} c @param {number | null} [forceType] */
async function upsertChannel(ctx, c, forceType = null) {
  const { guild, sameGuild, opts } = ctx;
  const s = ctx.stats.channels;
  const parentId = c.parentId ? ctx.maps.channels.get(c.parentId) ?? null : null;
  const { overwrites, absentMembers } = mapOverwrites(ctx, c.overwrites);

  // 같은 서버에 아직 살아있는 채널이면 그대로 두고 설정만 맞춤
  /** @type {any} */
  let existing = sameGuild ? guild.channels.cache.get(c.id) : null;
  if (existing && !existing.isThread() && (existing.type === c.type || (TEXT_LIKE.has(existing.type) && TEXT_LIKE.has(c.type)))) {
    ctx.maps.channels.set(c.id, existing.id);
    if (opts.mode === 'sync') {
      const patch = channelDiff(ctx, existing, c, parentId, overwrites);
      if (Object.keys(patch).length) {
        try {
          await existing.edit({ ...patch, reason: REASON });
          s.updated++;
        } catch (e) {
          s.failed++;
          ctx.warn(`#${c.name} 설정 복구 실패: ${errText(e)}`);
        }
      }
    }
    for (const ow of absentMembers) ctx.memberOverwrites.push({ channelId: existing.id, userId: ow.id, allow: ow.allow, deny: ow.deny });
    if (Array.isArray(existing.availableTags)) {
      const ids = new Set(existing.availableTags.map((t) => t.id));
      ctx.tagMaps.set(c.id, new Map((c.availableTags || []).filter((t) => ids.has(t.id)).map((t) => [t.id, t.id])));
    }
    return existing;
  }

  // 추가만 모드: 같은 이름·종류·위치의 채널이 있으면 그걸 씀
  if (opts.mode === 'add') {
    existing = guild.channels.cache.find(
      (x) => !x.isThread() && x.name === c.name && x.type === c.type && (x.parentId ?? null) === (parentId ?? null),
    );
    if (existing) {
      ctx.maps.channels.set(c.id, existing.id);
      return existing;
    }
  }

  const plan = forceType != null ? [forceType] : typePlan(ctx, c.type);
  let lastError = null;
  for (const type of plan) {
    try {
      const ch = await guild.channels.create(createOptions(ctx, c, type, parentId, overwrites));
      ctx.maps.channels.set(c.id, ch.id);
      ctx.created.add(c.id);
      s.created++;
      if (type !== c.type) {
        s.fallback++;
        ctx.warn(`#${c.name}: 이 서버에선 원래 채널 종류를 못 만들어서 ${type === T.GuildText ? '일반 채팅' : type === T.GuildVoice ? '음성' : '다른'} 채널로 만들었어요`);
      }
      for (const ow of absentMembers) ctx.memberOverwrites.push({ channelId: ch.id, userId: ow.id, allow: ow.allow, deny: ow.deny });
      if (FORUM_LIKE.has(type)) {
        rememberTags(ctx, c, ch);
        if (c.flags && c.flags & ChannelFlags.RequireTag) ctx.pendingFlags.set(ch.id, ChannelFlags.RequireTag);
      }
      return ch;
    } catch (e) {
      lastError = e;
      if (e.code === 30013) break; // 채널 500개 한도
    }
  }
  s.failed++;
  ctx.warn(`#${c.name} 생성 실패: ${errText(lastError)}`);
  return null;
}

/** @param {RestoreContext} ctx */
async function enableCommunity(ctx) {
  const { guild, data } = ctx;
  const rules = ctx.maps.channels.get(data.guild.rulesChannelId);
  const updates = ctx.maps.channels.get(data.guild.publicUpdatesChannelId);
  if (!rules || !updates) {
    ctx.warn('커뮤니티 서버 설정에 필요한 규칙/업데이트 채널이 백업에 없어서 커뮤니티 기능은 켜지 않았어요');
    return;
  }
  try {
    await guild.edit({
      features: /** @type {any} */ ([...new Set([...guild.features, 'COMMUNITY'])]),
      verificationLevel: Math.max(1, data.guild.verificationLevel ?? 1),
      explicitContentFilter: 2,
      rulesChannel: rules,
      publicUpdatesChannel: updates,
      reason: REASON,
    });
  } catch (e) {
    ctx.warn(`커뮤니티 기능 켜기 실패 (공지/스테이지 채널은 일반 채널로 만들어짐): ${errText(e)}`);
  }
}

/** @param {RestoreContext} ctx */
async function restoreChannels(ctx) {
  const { guild, data, sameGuild, opts } = ctx;
  const s = ctx.stats.channels;
  const backupIds = new Set(data.channels.map((c) => c.id));

  // 1) 전체 복구: 백업에 없는 채널 삭제 (명령어 쓴 채널은 맨 마지막에)
  if (opts.mode === 'sync') {
    const victims = [...guild.channels.cache.values()].filter((ch) => !ch.isThread() && !(sameGuild && backupIds.has(ch.id)));
    let i = 0;
    for (const ch of victims) {
      i++;
      if (ch.id === ctx.invokingChannelId) {
        ctx.deferred.push(ch.id);
        continue;
      }
      try {
        await ch.delete(REASON);
        s.deleted++;
      } catch (e) {
        if (e.code === 50074) ctx.deferred.push(ch.id);
        else if (e.code !== 10003) {
          s.failed++;
          ctx.warn(`#${ch.name} 삭제 실패: ${errText(e)}`);
        }
      }
      if (i % 5 === 0) ctx.set('channels', 'run', `정리 중 ${i}/${victims.length}`);
    }
  }

  const categories = data.channels.filter((c) => c.type === T.GuildCategory);
  const others = data.channels.filter((c) => c.type !== T.GuildCategory);
  const total = data.channels.length;
  let n = 0;
  const tick = () => {
    n++;
    if (n % 3 === 0) ctx.set('channels', 'run', `${n}/${total}`);
  };

  for (const c of categories) {
    await upsertChannel(ctx, c);
    tick();
  }

  // 2) 원래 커뮤니티 서버였으면 규칙/업데이트 채널 먼저 만들고 커뮤니티 켜기 → 공지·스테이지 채널 원래대로 생성 가능
  const needCommunity =
    opts.mode === 'sync' && data.guild.features?.includes('COMMUNITY') && !guild.features.includes('COMMUNITY');
  if (needCommunity) {
    for (const id of [data.guild.rulesChannelId, data.guild.publicUpdatesChannelId]) {
      const c = others.find((x) => x.id === id);
      if (c && !ctx.maps.channels.has(c.id)) {
        await upsertChannel(ctx, c, T.GuildText);
        tick();
      }
    }
    await enableCommunity(ctx);
  }

  for (const c of others) {
    if (ctx.maps.channels.has(c.id)) continue;
    await upsertChannel(ctx, c);
    tick();
  }

  // 3) 순서 맞추기
  const updates = [];
  for (const c of data.channels) {
    const id = ctx.maps.channels.get(c.id);
    const ch = id ? guild.channels.cache.get(id) : null;
    if (ch && !ch.isThread() && ch.rawPosition !== c.position) updates.push({ channel: id, position: c.position });
  }
  if (updates.length) {
    try {
      await guild.channels.setPositions(updates);
    } catch (e) {
      ctx.warn(`채널 순서 정리 실패: ${errText(e)}`);
    }
  }

  return `생성 ${s.created} · 수정 ${s.updated} · 삭제 ${s.deleted}${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

// =====================================================================
// 서버 설정 (이름, 아이콘, 시스템 채널 등) - 전체 복구 모드에서만
// =====================================================================
function pickImage(ctx, main, still, animatedAllowed) {
  const mainBuf = main ? ctx.assets.get(main) : null;
  const stillBuf = still ? ctx.assets.get(still) : null;
  if (stillBuf && !animatedAllowed) return stillBuf;
  return mainBuf || stillBuf || null;
}

/** @param {RestoreContext} ctx */
async function restoreSettings(ctx) {
  const { guild, data, opts } = ctx;
  if (opts.mode !== 'sync') {
    ctx.set('settings', 'skip');
    return '추가만 모드라 건너뜀';
  }
  const g = data.guild;
  const ch = (id) => (id ? ctx.maps.channels.get(id) ?? null : null);
  const community = guild.features.includes('COMMUNITY');
  /** @type {any} */
  const patch = {
    name: g.name,
    verificationLevel: community ? Math.max(1, g.verificationLevel ?? 1) : g.verificationLevel,
    explicitContentFilter: community ? 2 : g.explicitContentFilter,
    defaultMessageNotifications: g.defaultMessageNotifications,
    afkTimeout: g.afkTimeout,
    afkChannel: ch(g.afkChannelId),
    systemChannel: ch(g.systemChannelId),
    systemChannelFlags: g.systemChannelFlags ?? 0,
    premiumProgressBarEnabled: Boolean(g.premiumProgressBarEnabled),
  };
  const icon = pickImage(ctx, g.icon, g.iconStatic, guild.features.includes('ANIMATED_ICON'));
  if (icon) patch.icon = icon;
  if (community) {
    if (ch(g.rulesChannelId)) patch.rulesChannel = ch(g.rulesChannelId);
    if (ch(g.publicUpdatesChannelId)) patch.publicUpdatesChannel = ch(g.publicUpdatesChannelId);
    patch.safetyAlertsChannel = ch(g.safetyAlertsChannelId);
    patch.description = g.description ?? null;
    if (g.preferredLocale) patch.preferredLocale = g.preferredLocale;
  }
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

  const failed = [];
  try {
    await guild.edit({ ...patch, reason: REASON });
  } catch {
    // 한 번에 안 되면 하나씩
    for (const [key, value] of Object.entries(patch)) {
      try {
        await guild.edit({ [key]: value, reason: REASON });
      } catch {
        failed.push(key);
      }
    }
  }

  if (g.banner && guild.features.includes('BANNER')) {
    const banner = pickImage(ctx, g.banner, g.bannerStatic, guild.features.includes('ANIMATED_BANNER'));
    if (banner) await guild.edit({ banner, reason: REASON }).catch(() => failed.push('banner'));
  }
  if (g.splash && guild.features.includes('INVITE_SPLASH')) {
    const splash = ctx.assets.get(g.splash);
    if (splash) await guild.edit({ splash, reason: REASON }).catch(() => failed.push('splash'));
  }

  const labels = {
    name: '이름',
    icon: '아이콘',
    banner: '배너',
    splash: '초대 배경',
    afkChannel: '잠수 채널',
    systemChannel: '시스템 채널',
    rulesChannel: '규칙 채널',
    publicUpdatesChannel: '업데이트 채널',
  };
  if (failed.length) {
    ctx.warn(`서버 설정 일부 실패: ${failed.map((k) => labels[k] || k).join(', ')}`);
    ctx.set('settings', 'warn');
    return `일부 실패 (${failed.length})`;
  }
  return '이름 · 아이콘 · 알림 · 시스템 채널';
}

// =====================================================================
// 멤버 역할 다시 지급
// =====================================================================
/** @param {RestoreContext} ctx */
async function restoreMemberRoles(ctx) {
  const { guild, data } = ctx;
  const s = ctx.stats.members;
  const top = ctx.botTop();
  const assignable = (id) => {
    const role = guild.roles.cache.get(id);
    return Boolean(role && !role.managed && role.id !== guild.id && role.position < top);
  };
  const present = [];
  for (const m of data.members || []) {
    const roles = [...new Set((m.roles || []).map((id) => ctx.maps.roles.get(id)).filter(Boolean))];
    const member = guild.members.cache.get(m.id);
    if (!member) {
      if (roles.length || m.nick) ctx.absent.push({ id: m.id, roles, nick: m.nick ?? null });
      continue;
    }
    present.push({ member, roles: roles.filter(assignable), nick: m.nick ?? null });
  }
  s.later = ctx.absent.length;
  let done = 0;
  await mapLimit(present, 3, async ({ member, roles, nick }) => {
    const missing = roles.filter((id) => !member.roles.cache.has(id));
    if (missing.length) {
      try {
        await member.roles.add(missing, REASON);
        s.granted++;
      } catch {
        s.failed++;
      }
    }
    if (nick && !member.nickname && member.manageable) await member.setNickname(nick, REASON).catch(() => {});
    done++;
    if (done % 10 === 0) ctx.set('members', 'run', `${done}/${present.length}`);
  });
  return `${s.granted}명 지급${s.later ? ` · 다시 들어오면 자동 지급 ${s.later}명` : ''}${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

// =====================================================================
// 밴
// =====================================================================
/** @param {RestoreContext} ctx */
async function restoreBans(ctx) {
  const { guild, data, sameGuild, opts } = ctx;
  const s = ctx.stats.bans;
  const backupIds = new Set((data.bans || []).map((b) => b.id));
  const doUnban = Boolean(opts.unban && sameGuild);
  if (!backupIds.size && !doUnban) {
    ctx.set('bans', 'skip');
    return '백업에 밴 없음';
  }
  const current = new Set((await fetchAllBans(guild)).map((b) => b.id));

  const toBan = [...backupIds].filter((id) => !current.has(id) && id !== guild.ownerId);
  for (let i = 0; i < toBan.length; i += 200) {
    const chunk = toBan.slice(i, i + 200);
    try {
      const result = await guild.bans.bulkCreate(chunk, { reason: REASON });
      s.added += result.bannedUsers.length;
      s.failed += result.failedUsers.length;
    } catch {
      for (const id of chunk) {
        try {
          await guild.bans.create(id, { reason: REASON });
          s.added++;
        } catch {
          s.failed++;
        }
      }
    }
    ctx.set('bans', 'run', `밴 ${Math.min(i + 200, toBan.length)}/${toBan.length}`);
  }

  if (doUnban) {
    const extra = [...current].filter((id) => !backupIds.has(id));
    let done = 0;
    await mapLimit(extra, 2, async (id) => {
      try {
        await guild.bans.remove(id, 'DarkBackup: 백업 이후 생긴 밴 해제');
        s.removed++;
      } catch {
        s.failed++;
      }
      done++;
      if (done % 10 === 0) ctx.set('bans', 'run', `밴 해제 ${done}/${extra.length}`);
    });
  }
  return `밴 ${s.added}${doUnban ? ` · 해제 ${s.removed}` : ''}${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

// =====================================================================
// 메시지 (웹훅으로 원래 이름·프사 그대로)
// =====================================================================
function cleanEmbed(e) {
  const out = {};
  for (const key of ['title', 'description', 'url', 'timestamp', 'color']) if (e[key] != null) out[key] = e[key];
  if (e.footer?.text) out.footer = { text: e.footer.text, icon_url: e.footer.icon_url };
  if (e.image?.url) out.image = { url: e.image.url };
  if (e.thumbnail?.url) out.thumbnail = { url: e.thumbnail.url };
  if (e.author?.name) out.author = { name: e.author.name, url: e.author.url, icon_url: e.author.icon_url };
  if (Array.isArray(e.fields) && e.fields.length) {
    out.fields = e.fields.slice(0, 25).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  }
  return Object.keys(out).length ? out : null;
}

function buildPayload(ctx, m) {
  let content = rewriteIds(m.content || '', ctx.maps);
  const extras = [];
  for (const f of m.files || []) extras.push(`📎 ${f.name}`);
  for (const s of m.stickers || []) extras.push(`🏷️ 스티커: ${s}`);
  if (extras.length) content = content ? `${content}\n${extras.join('\n')}` : extras.join('\n');
  const embeds = (m.embeds || [])
    .map(cleanEmbed)
    .filter(Boolean)
    .slice(0, 10)
    .map((e) => rewriteDeep(e, ctx.maps));
  if (!content && !embeds.length) return null;
  /** @type {any} */
  const payload = {
    username: safeWebhookName(m.author?.name),
    allowedMentions: { parse: [] },
  };
  if (m.author?.avatar) payload.avatarURL = m.author.avatar;
  if (content) payload.content = truncate(content, 2000);
  if (embeds.length) payload.embeds = embeds;
  return payload;
}

/** @param {RestoreContext} ctx @param {import('discord.js').Webhook} webhook */
async function sendOne(ctx, webhook, payload, extra = {}) {
  try {
    return await webhook.send({ ...payload, ...extra });
  } catch (e) {
    if (e.code !== 50035) throw e;
    // 입력값 오류 → 이름이 디코 규칙에 걸렸을 수 있으니 이름을 본문으로 옮겨서 재시도
    const named = payload.content ? `**${payload.username}**\n${payload.content}` : `**${payload.username}**`;
    const safer = { ...payload, username: 'DarkBackup 복구', content: truncate(named, 2000) };
    try {
      return await webhook.send({ ...safer, ...extra });
    } catch (e2) {
      if (e2.code !== 50035 || !safer.embeds) throw e2;
      // 그래도 안 되면 임베드 빼고 글만
      const { embeds, ...rest } = safer;
      return webhook.send({ ...rest, ...extra });
    }
  }
}

/** @param {RestoreContext} ctx @param {any} target @param {import('discord.js').Webhook} webhook @param {any[]} messages @param {string | null} [threadId] */
async function replayMessages(ctx, target, webhook, messages, threadId = null) {
  const s = ctx.stats.messages;
  for (const m of messages) {
    const payload = buildPayload(ctx, m);
    if (!payload) continue;
    try {
      const sent = await sendOne(ctx, webhook, payload, threadId ? { threadId } : {});
      s.sent++;
      if (m.pinned && target?.messages) await target.messages.pin(sent.id, REASON).catch(() => {});
    } catch (e) {
      s.failed++;
      if (e.code === 10015) throw e; // 웹훅이 지워짐
    }
    if ((s.sent + s.failed) % 10 === 0) ctx.set('messages', 'run', `${s.sent + s.failed}/${s.total}`);
  }
}

/** @param {RestoreContext} ctx @param {any} forum @param {import('discord.js').Webhook} webhook */
async function replayPosts(ctx, forum, webhook, c) {
  const s = ctx.stats.messages;
  const tagMap = ctx.tagMaps.get(c.id) || new Map();
  for (const post of c.posts || []) {
    const [first, ...rest] = post.messages || [];
    const firstPayload = (first && buildPayload(ctx, first)) || {
      content: '*(원본 첫 글 내용 없음)*',
      username: 'DarkBackup',
      allowedMentions: { parse: [] },
    };
    const appliedTags = (post.appliedTags || []).map((id) => tagMap.get(id)).filter(Boolean).slice(0, 5);
    let starter;
    try {
      starter = await sendOne(ctx, webhook, firstPayload, { threadName: truncate(post.name || '게시글', 100), appliedTags });
      s.sent++;
    } catch (e) {
      s.failed += (post.messages || []).length || 1;
      ctx.warn(`게시글 "${truncate(post.name, 40)}" 복구 실패: ${errText(e)}`);
      if (e.code === 10015) throw e;
      continue;
    }
    const thread = await ctx.guild.channels.fetch(starter.channelId).catch(() => null);
    await replayMessages(ctx, thread, webhook, rest, starter.channelId);
    if (thread && thread.isThread()) {
      if (post.pinned) await thread.pin(REASON).catch(() => {});
      if (post.locked) await thread.setLocked(true, REASON).catch(() => {});
      if (post.archived) await thread.setArchived(true, REASON).catch(() => {});
    }
  }
}

/** @param {RestoreContext} ctx */
async function restoreMessages(ctx) {
  const { guild, data, opts } = ctx;
  const s = ctx.stats.messages;
  if (!opts.messages) {
    ctx.set('messages', 'skip');
    return '끔';
  }
  const jobs = data.channels.filter((c) => ctx.created.has(c.id) && (c.messages?.length || c.posts?.length));
  for (const c of jobs) {
    s.total += c.messages?.length || 0;
    for (const p of c.posts || []) s.total += p.messages?.length || 1;
  }
  if (!jobs.length) {
    ctx.set('messages', 'skip');
    return ctx.sameGuild ? '없어진 채널이 없거나 저장된 메시지 없음' : '저장된 메시지 없음';
  }
  ctx.set('messages', 'run', `0/${s.total}`);

  await mapLimit(jobs, 3, async (c) => {
    const ch = guild.channels.cache.get(ctx.maps.channels.get(c.id));
    if (!ch || !('createWebhook' in ch)) return;
    let webhook = null;
    try {
      webhook = await ch.createWebhook({ name: 'DarkBackup 복구', reason: REASON });
      if (FORUM_LIKE.has(ch.type)) {
        await replayPosts(ctx, ch, webhook, c);
      } else {
        await replayMessages(ctx, ch, webhook, c.messages || []);
        // 포럼을 일반 채널로 대신 만든 경우: 게시글을 제목 달아서 순서대로
        for (const post of c.posts || []) {
          await sendOne(ctx, webhook, {
            content: `📌 **${truncate(post.name || '게시글', 200)}**`,
            username: 'DarkBackup',
            allowedMentions: { parse: [] },
          }).catch(() => {});
          await replayMessages(ctx, ch, webhook, post.messages || []);
        }
      }
    } catch (e) {
      ctx.warn(`#${c.name} 메시지 복구 실패: ${errText(e)}`);
    } finally {
      if (webhook) await webhook.delete(REASON).catch(() => {});
    }
  });
  if (s.failed) ctx.set('messages', 'warn');
  return `${s.sent}/${s.total}개${s.failed ? ` · 실패 ${s.failed}` : ''}`;
}

// =====================================================================
// 마무리
// =====================================================================
/** @param {RestoreContext} ctx */
async function cleanup(ctx) {
  const { guild } = ctx;
  for (const [id, flags] of ctx.pendingFlags) {
    const ch = /** @type {any} */ (guild.channels.cache.get(id));
    if (ch && FORUM_LIKE.has(ch.type)) await ch.edit({ flags, reason: REASON }).catch(() => {});
  }
  for (const id of ctx.deferred) {
    const ch = guild.channels.cache.get(id);
    if (!ch) continue;
    try {
      await ch.delete(REASON);
      ctx.stats.channels.deleted++;
    } catch (e) {
      ctx.warn(`#${ch.name} 삭제 실패: ${errText(e)}`);
    }
  }
  return '완료';
}

/** 서버에 없던 멤버가 나중에 들어오면 역할/전용권한 지급하기 위한 정보 */
function buildRejoinLink(ctx) {
  const members = {};
  for (const a of ctx.absent) members[a.id] = { roles: a.roles, nick: a.nick };
  const overwrites = {};
  for (const o of ctx.memberOverwrites) {
    if (!overwrites[o.userId]) overwrites[o.userId] = [];
    overwrites[o.userId].push({ channelId: o.channelId, allow: String(o.allow), deny: String(o.deny) });
  }
  if (!Object.keys(members).length && !Object.keys(overwrites).length) return null;
  return {
    guildId: ctx.guild.id,
    backupId: ctx.meta?.id ?? null,
    sourceGuildId: ctx.data.guild.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.rejoinDays * 86_400_000,
    members,
    overwrites,
  };
}

/**
 * 복구 실행
 * @param {RestoreContext} ctx
 * @param {{ saveLink?: (link: any) => Promise<void> }} hooks
 */
async function restoreBackup(ctx, hooks = {}) {
  const { guild } = ctx;
  try {
    await guild.fetch();
    await guild.members.fetchMe();
    await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    try {
      await guild.members.fetch({ time: 90_000 });
    } catch (e) {
      ctx.warn(`멤버 목록을 다 못 불러왔어요 (일부 멤버 역할은 다시 들어올 때 지급): ${errText(e)}`);
    }

    await runPhase(ctx, 'roles', restoreRoles);
    await runPhase(ctx, 'emojis', restoreEmojis);
    await runPhase(ctx, 'channels', restoreChannels);
    await runPhase(ctx, 'settings', restoreSettings);
    await Promise.all([
      runPhase(ctx, 'members', restoreMemberRoles),
      runPhase(ctx, 'bans', restoreBans),
      runPhase(ctx, 'messages', restoreMessages),
    ]);
    await runPhase(ctx, 'cleanup', cleanup);

    const link = buildRejoinLink(ctx);
    if (link && hooks.saveLink) {
      await hooks.saveLink(link).catch((e) => ctx.warn(`재입장 역할 지급 정보 저장 실패: ${errText(e)}`));
    }
  } catch (e) {
    ctx.error = e;
    warn('[restore] 치명적 오류', e);
  } finally {
    ctx.finished = Date.now();
    ctx.onUpdate?.(ctx);
  }
  return ctx;
}

module.exports = { RestoreContext, restoreBackup, PHASES };
