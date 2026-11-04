// @ts-check
const { ChannelType, MessageType, ChannelFlags, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { mapLimit, fetchBuffer, sha256, snowflakeCompare, errText, warn } = require('./util');

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const THREAD_ONLY_TYPES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
const KEEP_MESSAGE_TYPES = new Set([
  MessageType.Default,
  MessageType.Reply,
  MessageType.ChatInputCommand,
  MessageType.ContextMenuCommand,
]);
const CHANNEL_FIELDS = [
  'topic',
  'nsfw',
  'rateLimitPerUser',
  'bitrate',
  'userLimit',
  'rtcRegion',
  'videoQualityMode',
  'defaultAutoArchiveDuration',
  'defaultThreadRateLimitPerUser',
  'defaultSortOrder',
  'defaultForumLayout',
];

/** 웹훅으로 다시 보낼 수 있게 메시지를 압축 저장 */
function packMessage(m) {
  if (!KEEP_MESSAGE_TYPES.has(m.type)) return null;
  const embeds = m.embeds.filter((e) => !e.data.type || e.data.type === 'rich').map((e) => e.toJSON());
  const files = [...m.attachments.values()].map((a) => ({ name: a.name, size: a.size }));
  const stickers = [...m.stickers.values()].map((s) => s.name);
  if (!m.content && !embeds.length && !files.length && !stickers.length) return null;
  const out = {
    id: m.id,
    author: {
      id: m.author.id,
      name: m.member?.displayName ?? m.author.displayName ?? m.author.username,
      avatar: m.author.displayAvatarURL({ extension: 'png', size: 128 }),
      bot: m.author.bot || undefined,
    },
    content: m.content || undefined,
    ts: m.createdTimestamp,
  };
  if (embeds.length) out.embeds = embeds;
  if (files.length) out.files = files;
  if (stickers.length) out.stickers = stickers;
  if (m.pinned) out.pinned = true;
  return out;
}

async function collectMessages(channel, limit) {
  if (!limit) return [];
  const fetched = await channel.messages.fetch({ limit: Math.min(100, limit), cache: false });
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(packMessage)
    .filter(Boolean);
}

/** 포럼 게시글(스레드) + 게시글 메시지 */
async function collectPosts(channel, activeThreads, messageLimit, postLimit) {
  const threads = new Map();
  for (const t of activeThreads.values()) if (t.parentId === channel.id) threads.set(t.id, t);
  try {
    const archived = await channel.threads.fetchArchived({ type: 'public', limit: Math.min(100, postLimit) }, false);
    for (const t of archived.threads.values()) threads.set(t.id, t);
  } catch (e) {
    warn(`[backup] #${channel.name} 보관된 게시글 못 읽음: ${errText(e)}`);
  }
  const list = [...threads.values()]
    .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))
    .slice(0, postLimit)
    .reverse(); // 복구할 때 오래된 글부터 올리도록

  return mapLimit(list, 3, async (t) => {
    let messages = [];
    try {
      const fetched = await t.messages.fetch({ limit: Math.min(100, Math.max(1, messageLimit)), cache: false });
      if (!fetched.has(t.id)) {
        const starter = await t.messages.fetch({ message: t.id, cache: false }).catch(() => null);
        if (starter) fetched.set(starter.id, starter);
      }
      messages = [...fetched.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(packMessage)
        .filter(Boolean);
    } catch (e) {
      warn(`[backup] 게시글 "${t.name}" 메시지 못 읽음: ${errText(e)}`);
    }
    return {
      id: t.id,
      name: t.name,
      appliedTags: [...(t.appliedTags || [])],
      locked: Boolean(t.locked),
      archived: Boolean(t.archived),
      pinned: t.flags ? t.flags.has(ChannelFlags.Pinned) : false,
      createdAt: t.createdTimestamp ?? null,
      messages,
    };
  });
}

function packChannel(c) {
  const d = {
    id: c.id,
    type: c.type,
    name: c.name,
    parentId: c.parentId ?? null,
    position: c.rawPosition,
    overwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
    })),
  };
  for (const key of CHANNEL_FIELDS) {
    if (c[key] !== undefined && c[key] !== null) d[key] = c[key];
  }
  if (Array.isArray(c.availableTags)) {
    d.availableTags = c.availableTags.map((t) => ({
      id: t.id,
      name: t.name,
      moderated: Boolean(t.moderated),
      emoji: t.emoji ? { id: t.emoji.id ?? null, name: t.emoji.name ?? null } : null,
    }));
  }
  if (c.defaultReactionEmoji) {
    d.defaultReactionEmoji = { id: c.defaultReactionEmoji.id ?? null, name: c.defaultReactionEmoji.name ?? null };
  }
  if (c.flags) d.flags = Number(c.flags.bitfield);
  return d;
}

/** 밴 목록 전부 (1000개씩 끊어서) */
async function fetchAllBans(guild, max = config.limits.maxBans) {
  const out = [];
  let after;
  while (out.length < max) {
    const batch = await guild.bans.fetch({ limit: 1000, after, cache: false });
    for (const ban of batch.values()) out.push({ id: ban.user.id, reason: ban.reason ?? null });
    if (batch.size < 1000) break;
    after = [...batch.keys()].sort(snowflakeCompare).pop();
  }
  return out;
}

/**
 * 서버를 통째로 읽어서 백업 묶음을 만듦 (저장은 안 함)
 * @param {import('discord.js').Guild} guild
 */
async function createBackup(guild, { store, type = 'manual', creatorId = null, note = null, messageLimit = 20, useMemo = true, onProgress = null }) {
  const progress = (text) => {
    try {
      onProgress?.(text);
    } catch {
      /* 무시 */
    }
  };
  const warnings = [];
  await guild.fetch();
  progress('역할 · 채널 · 이모지 읽는 중');
  const [roles, channels, emojis] = await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);

  // 멤버를 먼저 불러와야 메시지 작성자 닉네임도 제대로 저장됨
  progress('멤버 목록 읽는 중');
  let members = guild.members.cache;
  try {
    members = await guild.members.fetch({ time: 90_000 });
  } catch (e) {
    warnings.push(`멤버 전체 목록 못 읽음 (일부만 저장): ${errText(e)}`);
  }

  // ---------- 이미지(아이콘/이모지) : 해시로 중복 없이 ----------
  const memo = useMemo ? store.getMemo(guild.id) : new Map();
  const newMemo = new Map();
  /** @type {Map<string, Buffer | null>} */
  const assets = new Map();
  const grab = async (key, url) => {
    if (!url) return null;
    const known = memo.get(key);
    if (known) {
      newMemo.set(key, known);
      if (!assets.has(known)) assets.set(known, null);
      return known;
    }
    try {
      const buf = await fetchBuffer(url, { maxBytes: 12 * 1024 * 1024 });
      const sha = sha256(buf);
      assets.set(sha, buf);
      newMemo.set(key, sha);
      return sha;
    } catch (e) {
      warnings.push(`이미지 저장 실패 (${key.split(':')[0]}): ${errText(e)}`);
      return null;
    }
  };

  // ---------- 서버 정보 ----------
  const animatedIcon = Boolean(guild.icon?.startsWith('a_'));
  const animatedBanner = Boolean(guild.banner?.startsWith('a_'));
  const guildData = {
    id: guild.id,
    name: guild.name,
    description: guild.description ?? null,
    icon: guild.icon ? await grab(`icon:${guild.icon}`, guild.iconURL({ extension: 'png', size: 1024 })) : null,
    iconStatic:
      guild.icon && animatedIcon
        ? await grab(`icon-static:${guild.icon}`, guild.iconURL({ extension: 'png', size: 1024, forceStatic: true }))
        : null,
    banner: guild.banner ? await grab(`banner:${guild.banner}`, guild.bannerURL({ extension: 'png', size: 2048 })) : null,
    bannerStatic:
      guild.banner && animatedBanner
        ? await grab(`banner-static:${guild.banner}`, guild.bannerURL({ extension: 'png', size: 2048, forceStatic: true }))
        : null,
    splash: guild.splash ? await grab(`splash:${guild.splash}`, guild.splashURL({ extension: 'png', size: 2048 })) : null,
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afkChannelId: guild.afkChannelId ?? null,
    afkTimeout: guild.afkTimeout,
    systemChannelId: guild.systemChannelId ?? null,
    systemChannelFlags: Number(guild.systemChannelFlags.bitfield),
    rulesChannelId: guild.rulesChannelId ?? null,
    publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
    safetyAlertsChannelId: guild.safetyAlertsChannelId ?? null,
    preferredLocale: guild.preferredLocale ?? null,
    premiumProgressBarEnabled: Boolean(guild.premiumProgressBarEnabled),
    features: [...guild.features],
    premiumTier: guild.premiumTier,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
  };

  // ---------- 역할 (높은 것부터) ----------
  const roleList = [...roles.values()].sort((a, b) => b.position - a.position);
  const rolesData = await mapLimit(roleList, 4, async (r) => ({
    id: r.id,
    name: r.name,
    colors: {
      primaryColor: r.colors?.primaryColor ?? r.color ?? 0,
      secondaryColor: r.colors?.secondaryColor ?? null,
      tertiaryColor: r.colors?.tertiaryColor ?? null,
    },
    hoist: r.hoist,
    mentionable: r.mentionable,
    permissions: r.permissions.bitfield.toString(),
    position: r.position,
    managed: r.managed,
    everyone: r.id === guild.id,
    botId: r.tags?.botId ?? null,
    premium: Boolean(r.tags?.premiumSubscriberRole),
    icon: r.icon ? await grab(`role:${r.icon}`, r.iconURL({ extension: 'png', size: 128 })) : null,
    unicodeEmoji: r.unicodeEmoji ?? null,
  }));

  // ---------- 이모지 ----------
  progress(`이모지 ${emojis.size}개 저장 중`);
  const emojiData = (
    await mapLimit([...emojis.values()], 5, async (e) => ({
      id: e.id,
      name: e.name,
      animated: Boolean(e.animated),
      asset: await grab(`emoji:${e.id}`, e.imageURL({ extension: e.animated ? 'gif' : 'png' })),
    }))
  ).filter((e) => e.asset);

  // ---------- 채널 + 메시지 ----------
  const all = [...channels.values()].filter((c) => c && !c.isThread());
  const byPosition = (a, b) => a.rawPosition - b.rawPosition || snowflakeCompare(a.id, b.id);
  const categories = all.filter((c) => c.type === ChannelType.GuildCategory).sort(byPosition);
  const others = all.filter((c) => c.type !== ChannelType.GuildCategory).sort(byPosition);
  const withPosts = messageLimit > 0 && config.limits.forumPosts > 0;

  let activeThreads = new Map();
  if (withPosts && others.some((c) => THREAD_ONLY_TYPES.has(c.type))) {
    try {
      activeThreads = new Map((await guild.channels.fetchActiveThreads(false)).threads);
    } catch (e) {
      warnings.push(`진행 중인 포럼 글 못 읽음: ${errText(e)}`);
    }
  }

  let done = 0;
  const ordered = [...categories, ...others];
  const channelData = await mapLimit(ordered, 4, async (c) => {
    const d = packChannel(c);
    if (messageLimit > 0) {
      try {
        if (TEXT_TYPES.has(c.type)) d.messages = await collectMessages(c, messageLimit);
        else if (withPosts && THREAD_ONLY_TYPES.has(c.type)) {
          d.posts = await collectPosts(c, activeThreads, messageLimit, config.limits.forumPosts);
        }
      } catch (e) {
        warnings.push(`#${c.name} 메시지 못 읽음: ${errText(e)}`);
      }
    }
    done++;
    if (done % 5 === 0) progress(`채널 ${done}/${ordered.length} 읽는 중`);
    return d;
  });

  // ---------- 밴 ----------
  let bans = [];
  if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    progress('밴 목록 저장 중');
    try {
      bans = await fetchAllBans(guild);
    } catch (e) {
      warnings.push(`밴 목록 못 읽음: ${errText(e)}`);
    }
  }

  // ---------- 멤버별 역할 (나중에 다시 들어오면 자동 지급용) ----------
  const memberData = [];
  for (const m of members.values()) {
    if (m.user.bot) continue;
    const roleIds = [...m.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id);
    if (!roleIds.length && !m.nickname) continue;
    memberData.push({ id: m.id, nick: m.nickname ?? null, roles: roleIds });
  }

  const data = {
    version: 1,
    guild: guildData,
    roles: rolesData,
    channels: channelData,
    emojis: emojiData,
    bans,
    members: memberData,
  };

  const meta = {
    id: store.newBackupId(),
    version: 1,
    type,
    note: note || null,
    guildId: guild.id,
    guildName: guild.name,
    guildIconUrl: guild.iconURL({ extension: 'png', size: 128 }),
    ownerId: guild.ownerId,
    creatorId: creatorId || guild.ownerId,
    createdAt: Date.now(),
    stats: computeStats(data),
    size: 0,
    assets: [],
  };

  return { meta, data, assets, memo: newMemo, warnings };
}

function computeStats(data) {
  let messages = 0;
  let posts = 0;
  for (const c of data.channels) {
    messages += c.messages?.length || 0;
    for (const p of c.posts || []) {
      posts++;
      messages += p.messages?.length || 0;
    }
  }
  return {
    roles: data.roles.filter((r) => !r.everyone && !r.managed).length,
    channels: data.channels.length,
    categories: data.channels.filter((c) => c.type === ChannelType.GuildCategory).length,
    messages,
    posts,
    emojis: data.emojis.length,
    bans: data.bans.length,
    members: data.members.length,
    memberCount: data.guild.memberCount ?? 0,
  };
}

/**
 * 백업 만들고 저장까지. check(bundle)가 false면 저장 안 함 (자동백업 이상 감지용)
 * @param {import('discord.js').Guild} guild
 */
async function backupGuild(guild, opts) {
  let bundle = await createBackup(guild, opts);
  if (opts.check && !(await opts.check(bundle))) return { ...bundle, skipped: true };
  try {
    await opts.store.saveBundle(bundle);
  } catch (e) {
    if (e.name !== 'AssetMissingError') throw e;
    bundle = await createBackup(guild, { ...opts, useMemo: false });
    await opts.store.saveBundle(bundle);
  }
  opts.store.setMemo(guild.id, bundle.memo);
  return { ...bundle, skipped: false };
}

module.exports = { createBackup, backupGuild, fetchAllBans, computeStats };
