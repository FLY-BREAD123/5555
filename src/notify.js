// @ts-check
const config = require('./config');
const { warn } = require('./util');

/** 서버 주인 + 자동백업 설정한 사람 + 봇 주인에게 DM */
/** @param {import('discord.js').Client} client @param {import('discord.js').Guild} guild */
async function alertOwners(client, guild, cfg, payload) {
  const ids = new Set([guild.ownerId, cfg?.configuredBy, ...config.ownerIds].filter(Boolean));
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      await user.send(payload);
    } catch (e) {
      warn(`[notify] ${id}에게 DM 실패: ${e.message}`);
    }
  }
}

module.exports = { alertOwners };
