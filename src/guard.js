// @ts-check
const { EmbedBuilder, AuditLogEvent, Events } = require('discord.js');
const config = require('./config');
const state = require('./state');
const { alertOwners } = require('./notify');
const { ts, warn, log } = require('./util');

const KINDS = {
  channel: { text: (n) => `채널 ${n}개 삭제`, audit: AuditLogEvent.ChannelDelete, limit: () => config.guard.channelDeletes },
  role: { text: (n) => `역할 ${n}개 삭제`, audit: AuditLogEvent.RoleDelete, limit: () => config.guard.roleDeletes },
  ban: { text: (n) => `멤버 ${n}명 밴`, audit: AuditLogEvent.MemberBanAdd, limit: () => config.guard.bans },
};

/**
 * 테러 감지: 짧은 시간에 채널/역할 대량 삭제·대량 밴이 일어나면
 * 1) 자동백업을 멈춰서 정상 백업이 망가진 백업으로 밀려나지 않게 하고
 * 2) 서버 주인한테 DM으로 알림 + 복구 명령어 안내
 */
/** @param {{ client: import('discord.js').Client, store: any }} p */
function setupGuard({ client, store }) {
  const windows = new Map(); // guildId -> { channel: [], role: [], ban: [] }
  const lastAlert = new Map();

  /** @param {import('discord.js').Guild} guild */
  async function findSuspect(guild, kind) {
    try {
      const logs = await guild.fetchAuditLogs({ type: KINDS[kind].audit, limit: 30 });
      const since = Date.now() - config.guard.windowMs - 10_000;
      const counts = new Map();
      for (const entry of logs.entries.values()) {
        if (entry.createdTimestamp < since || !entry.executorId || entry.executorId === client.user?.id) continue;
        counts.set(entry.executorId, (counts.get(entry.executorId) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? { id: top[0], count: top[1] } : null;
    } catch {
      return null;
    }
  }

  /** @param {import('discord.js').Guild} guild */
  async function trigger(guild, kind, count) {
    const now = Date.now();
    if (now - (lastAlert.get(guild.id) || 0) < 10 * 60_000) return;
    lastAlert.set(guild.id, now);

    const reason = `${Math.round(config.guard.windowMs / 1000)}초 안에 ${KINDS[kind].text(count)}됨`;
    const cfg = store.getConfig(guild.id);
    await store.patchConfig(guild.id, { paused: true, pauseReason: `테러 의심 — ${reason}`, pausedAt: now });
    const suspect = await findSuspect(guild, kind);
    const latest = store.latestForGuild(guild.id);
    log(`[guard] ${guild.name} 테러 의심: ${reason}${suspect ? ` · 의심 계정 ${suspect.id}` : ''}`);

    const lines = [
      `**${guild.name}** — ${reason}`,
      suspect ? `의심 계정: <@${suspect.id}> (\`${suspect.id}\`) — ${suspect.count}건` : null,
      '',
      '좋은 백업이 덮어써지지 않게 **자동백업을 멈췄어요.**',
      latest
        ? `마지막 백업: \`${latest.id}\` (${ts(latest.createdAt, 'f')} · ${ts(latest.createdAt, 'R')})`
        : '⚠️ 이 서버에 저장된 백업이 아직 없어요.',
      '',
      '**지금 할 일**',
      '1. 의심 계정 / 봇의 권한부터 빼거나 추방하기',
      latest ? `2. 서버에서 \`/백업 복구 아이디:${latest.id}\` (테러로 밴당한 멤버까지 풀려면 \`밴해제:True\`)` : null,
      latest ? '3. 서버가 아예 없어졌으면 → 새 서버 만들고 봇 초대 → 같은 명령어' : null,
      '',
      '오탐이면 `/자동백업 재개`로 다시 켜면 돼요.',
    ].filter((l) => l !== null);

    await alertOwners(client, guild, cfg, {
      embeds: [
        new EmbedBuilder()
          .setColor(config.color.err)
          .setTitle('🚨 서버 테러 의심 감지')
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'DarkBackup' }),
      ],
    });
  }

  function hit(guild, kind) {
    if (!guild) return;
    if (state.locks.get(guild.id) === 'restore') return; // 우리 봇이 복구하면서 지우는 건 무시
    const now = Date.now();
    const w = windows.get(guild.id) || { channel: [], role: [], ban: [] };
    windows.set(guild.id, w);
    w[kind] = w[kind].filter((t) => now - t < config.guard.windowMs);
    w[kind].push(now);
    if (w[kind].length >= KINDS[kind].limit()) trigger(guild, kind, w[kind].length).catch((e) => warn('[guard]', e));
  }

  client.on(Events.ChannelDelete, (channel) => {
    if ('guild' in channel && channel.guild) hit(channel.guild, 'channel');
  });
  client.on(Events.GuildRoleDelete, (role) => hit(role.guild, 'role'));
  client.on(Events.GuildBanAdd, (ban) => hit(ban.guild, 'ban'));
}

module.exports = { setupGuard };
