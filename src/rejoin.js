// @ts-check
const { Events, Routes } = require('discord.js');
const { warn, log } = require('./util');

const REASON = 'DarkBackup: 백업에 있던 역할 다시 지급';

/**
 * 복구 후 다시 들어온 멤버에게 원래 역할 · 닉네임 · 채널 전용 권한을 자동으로 돌려줌.
 * (서버가 날아가서 새 서버로 복구하면 멤버들이 하나씩 다시 들어오니까)
 */
/** @param {{ client: import('discord.js').Client, store: any }} p */
function setupRejoin({ client, store }) {
  const saveTimers = new Map();

  const scheduleSave = (guildId) => {
    if (saveTimers.has(guildId)) return;
    saveTimers.set(
      guildId,
      setTimeout(async () => {
        saveTimers.delete(guildId);
        const link = store.links.get(guildId);
        if (!link) return;
        const empty = !Object.keys(link.members || {}).length && !Object.keys(link.overwrites || {}).length;
        try {
          if (empty) await store.deleteLink(guildId);
          else await store.saveLink(link);
        } catch (e) {
          warn('[rejoin] 저장 실패', e);
        }
      }, 30_000).unref(),
    );
  };

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    const { guild } = member;
    const link = store.getLink(guild.id);
    if (!link) return;
    const entry = link.members?.[member.id];
    const overwrites = link.overwrites?.[member.id];
    if (!entry && !overwrites) return;

    try {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const top = me.roles.highest.position;
      if (entry) {
        const roles = (entry.roles || []).filter((id) => {
          const role = guild.roles.cache.get(id);
          return role && !role.managed && role.position < top;
        });
        if (roles.length) await member.roles.add(roles, REASON);
        if (entry.nick && member.manageable) await member.setNickname(entry.nick, REASON).catch(() => {});
      }
      for (const o of overwrites || []) {
        if (!guild.channels.cache.has(o.channelId)) continue;
        await client.rest
          .put(Routes.channelPermission(o.channelId, member.id), {
            body: { type: 1, allow: o.allow, deny: o.deny },
            reason: REASON,
          })
          .catch(() => {});
      }
      log(`[rejoin] ${guild.name} · ${member.user.tag} 역할 ${entry?.roles?.length || 0}개 다시 지급`);
    } catch (e) {
      warn(`[rejoin] ${member.user.tag} 역할 지급 실패`, e);
      return; // 실패하면 다음에 또 들어왔을 때 다시 시도
    }

    if (link.members) delete link.members[member.id];
    if (link.overwrites) delete link.overwrites[member.id];
    scheduleSave(guild.id);
  });
}

module.exports = { setupRejoin };
