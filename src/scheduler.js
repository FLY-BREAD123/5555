// @ts-check
const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const state = require('./state');
const { backupGuild } = require('./backup');
const { alertOwners } = require('./notify');
const { errText, fmtBytes, log, warn, ts } = require('./util');

const HOUR = 3_600_000;

/** 처음 보는 서버면 기본 자동백업 설정 생성. firstDelayMs 뒤에 첫 백업 */
/** @param {import('discord.js').Guild} guild */
async function ensureConfig(store, guild, firstDelayMs = 2 * 60_000) {
  const existing = store.getConfig(guild.id);
  if (existing) {
    if (existing.guildName !== guild.name) await store.patchConfig(guild.id, { guildName: guild.name });
    return existing;
  }
  const d = config.defaults;
  return store.saveConfig({
    guildId: guild.id,
    guildName: guild.name,
    enabled: d.autoEnabled,
    intervalHours: d.intervalHours,
    keep: d.keep,
    messageLimit: d.messageLimit,
    configuredBy: guild.ownerId,
    lastRunAt: Date.now() - d.intervalHours * HOUR + firstDelayMs,
    lastBackupId: null,
    lastError: null,
    paused: false,
    pauseReason: null,
    skipSanityOnce: false,
    createdAt: Date.now(),
  });
}

/** 직전 백업보다 채널/역할/멤버가 반 이상 줄었으면 테러로 의심 */
function suspiciousDrop(prev, next) {
  const a = prev?.stats;
  const b = next?.stats;
  if (!a || !b) return null;
  const dropped = (before, after, min) => before >= min && after < before * 0.5;
  if (dropped(a.channels, b.channels, 4)) return `채널 ${a.channels}개 → ${b.channels}개`;
  if (dropped(a.roles, b.roles, 4)) return `역할 ${a.roles}개 → ${b.roles}개`;
  if (dropped(a.memberCount || 0, b.memberCount || 0, 10)) return `멤버 ${a.memberCount}명 → ${b.memberCount}명`;
  return null;
}

function createScheduler({ client, store }) {
  let running = false;

  /** @param {import('discord.js').Guild} guild */
  async function runAuto(guild, cfg) {
    if (!state.lock(guild.id, 'backup')) return;
    const interval = (cfg.intervalHours || config.defaults.intervalHours) * HOUR;
    try {
      const prev = store.latestForGuild(guild.id);
      let reason = null;
      const result = await backupGuild(guild, {
        store,
        type: 'auto',
        creatorId: cfg.configuredBy || guild.ownerId,
        messageLimit: cfg.messageLimit ?? config.defaults.messageLimit,
        check: (bundle) => {
          if (cfg.skipSanityOnce) return true;
          reason = suspiciousDrop(prev, bundle.meta);
          return !reason;
        },
      });

      if (result.skipped) {
        // 테러당한 상태를 백업해서 좋은 백업을 밀어내지 않도록 멈춤
        await store.patchConfig(guild.id, {
          paused: true,
          pauseReason: `서버가 갑자기 줄어듦 (${reason})`,
          pausedAt: Date.now(),
          lastRunAt: Date.now(),
        });
        warn(`[auto] ${guild.name} 이상 감지 → 자동백업 정지 (${reason})`);
        await alertOwners(client, guild, cfg, {
          embeds: [
            new EmbedBuilder()
              .setColor(config.color.err)
              .setTitle('🚨 서버 이상 감지 — 자동백업 멈춤')
              .setDescription(
                [
                  `**${guild.name}** 자동백업 중에 서버가 갑자기 줄어든 걸 발견했어요.`,
                  `> ${reason}`,
                  '',
                  '좋은 백업이 망가진 상태로 덮어써지지 않게 **자동백업을 멈췄어요.**',
                  prev ? `마지막 정상 백업: \`${prev.id}\` (${ts(prev.createdAt, 'f')})` : null,
                  prev ? `복구하려면 서버에서 \`/백업 복구 아이디:${prev.id}\`` : null,
                  '',
                  '일부러 정리한 거라면 `/자동백업 재개` 하면 지금 상태를 새 기준으로 다시 시작해요.',
                ]
                  .filter((l) => l !== null)
                  .join('\n'),
              )
              .setFooter({ text: 'DarkBackup' }),
          ],
        });
        return;
      }

      await store.patchConfig(guild.id, {
        guildName: guild.name,
        lastRunAt: Date.now(),
        lastBackupId: result.meta.id,
        lastError: null,
        skipSanityOnce: false,
      });
      const removed = await store.applyRetention(guild.id, cfg.keep || config.defaults.keep);
      log(
        `[auto] ${guild.name} → ${result.meta.id} (${fmtBytes(result.meta.size)})${removed ? ` · 오래된 자동백업 ${removed}개 정리` : ''}`,
      );
    } catch (e) {
      // 실패하면 15분 뒤 재시도
      await store
        .patchConfig(guild.id, { lastRunAt: Date.now() - interval + 15 * 60_000, lastError: `${new Date().toISOString()} ${errText(e)}` })
        .catch(() => {});
      warn(`[auto] ${guild.name} 백업 실패`, e);
    } finally {
      state.unlock(guild.id);
    }
  }

  async function tick() {
    if (running || !client.isReady()) return;
    running = true;
    try {
      for (const cfg of store.allConfigs()) {
        if (!cfg.enabled || cfg.paused) continue;
        const guild = client.guilds.cache.get(cfg.guildId);
        if (!guild || !guild.available) continue;
        const interval = (cfg.intervalHours || config.defaults.intervalHours) * HOUR;
        if (Date.now() - (cfg.lastRunAt || 0) < interval) continue;
        if (state.locks.has(guild.id)) continue;
        await runAuto(guild, store.getConfig(guild.id) || cfg);
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => tick().catch((e) => warn('[auto] tick', e)), 60_000);
  setTimeout(() => tick().catch(() => {}), 20_000);

  return { tick, runAuto, stop: () => clearInterval(timer) };
}

module.exports = { createScheduler, ensureConfig, suspiciousDrop };
