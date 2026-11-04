// @ts-check
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const config = require('./config');
const state = require('./state');
const ui = require('./ui');
const { backupGuild } = require('./backup');
const { exportBundle, importBundle } = require('./bundle');
const { RestoreContext, restoreBackup } = require('./restore');
const { LiveMessage } = require('./live');
const { ensureConfig } = require('./scheduler');
const { fetchBuffer, fmtDate, fmtBytes, truncate, errText, ts, log, warn } = require('./util');

const EPH = MessageFlags.Ephemeral;
const BUSY = '이 서버에서 이미 백업이나 복구가 진행 중이에요. 끝나고 다시 해주세요.';

/** 진행 메시지가 최종 결과를 덮어쓰지 않게 순서대로 수정 */
function serialEditor(interaction) {
  let chain = Promise.resolve();
  let closed = false;
  return {
    edit(payload, final = false) {
      if (closed) return chain;
      if (final) closed = true;
      chain = chain.then(() => interaction.editReply(payload)).catch(() => {});
      return chain;
    },
  };
}

function createInteractionHandler({ client, store, scheduler }) {
  const access = (i) => ({
    userId: i.user.id,
    guildId: i.guildId,
    adminHere: Boolean(i.inGuild() && i.memberPermissions?.has(PermissionFlagsBits.Administrator)),
  });

  const findMeta = (i, id) => {
    const meta = store.metas.get(String(id || '').trim());
    return meta && store.canAccess(meta, access(i)) ? meta : null;
  };
  const NOT_FOUND = '그 백업을 찾을 수 없거나 권한이 없어요. `/백업 목록`에서 ID를 확인해 주세요.';

  // ------------------------------------------------------------------ 자동완성
  /** @param {import('discord.js').AutocompleteInteraction} i */
  async function onAutocomplete(i) {
    const focused = i.options.getFocused(true);
    if (focused.name !== '아이디') return i.respond([]);
    const q = String(focused.value || '').toLowerCase().trim();
    const list = store
      .listAccessible(access(i))
      .filter(
        (m) =>
          !q ||
          m.id.toLowerCase().includes(q) ||
          String(m.guildName).toLowerCase().includes(q) ||
          String(m.note || '').toLowerCase().includes(q),
      )
      .slice(0, 25);
    await i.respond(
      list.map((m) => ({
        name: truncate(
          `${m.id} · ${m.guildName} · ${fmtDate(m.createdAt)} · ${ui.TYPE_LABEL[m.type] || m.type}${m.note ? ` · ${m.note}` : ''}`,
          100,
        ),
        value: m.id,
      })),
    );
  }

  // ------------------------------------------------------------------ /백업 생성
  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdCreate(i) {
    const { guild } = i;
    await i.deferReply({ flags: EPH });
    const manual = store.listForGuild(guild.id).filter((m) => m.type === 'manual').length;
    if (manual >= config.limits.maxManualPerGuild) {
      return i.editReply({
        embeds: [ui.fail(`수동 백업은 서버당 ${config.limits.maxManualPerGuild}개까지예요. \`/백업 삭제\`로 오래된 걸 지워주세요.`)],
      });
    }
    if (!state.lock(guild.id, 'backup')) return i.editReply({ embeds: [ui.fail(BUSY)] });
    const editor = serialEditor(i);
    try {
      const cfg = store.getConfig(guild.id);
      const messageLimit = i.options.getInteger('메시지수') ?? cfg?.messageLimit ?? config.defaults.messageLimit;
      let last = 0;
      editor.edit({ embeds: [ui.info('⏳ 백업 중…', '서버 크기에 따라 몇 초 ~ 1분 정도 걸려요.')] });
      const result = await backupGuild(guild, {
        store,
        type: 'manual',
        creatorId: i.user.id,
        note: i.options.getString('메모'),
        messageLimit,
        onProgress: (text) => {
          if (Date.now() - last < 2500) return;
          last = Date.now();
          editor.edit({ embeds: [ui.info('⏳ 백업 중…', text)] });
        },
      });
      await editor.edit({ embeds: [ui.backupDoneEmbed(result.meta, result.warnings, store)] }, true);
      log(`[backup] 수동 ${result.meta.id} · ${guild.name} · ${fmtBytes(result.meta.size)}`);
    } catch (e) {
      await editor.edit({ embeds: [ui.fail(`백업 실패: ${errText(e)}`)] }, true);
      warn('[backup] 수동 백업 실패', e);
    } finally {
      state.unlock(guild.id);
    }
  }

  // ------------------------------------------------------------------ /백업 목록 · 정보 · 삭제 · 다운로드
  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdList(i) {
    await i.reply({ flags: EPH, embeds: [ui.listEmbed(store.listAccessible(access(i)), i.guildId)] });
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdInfo(i) {
    const meta = findMeta(i, i.options.getString('아이디', true));
    if (!meta) return i.reply({ flags: EPH, embeds: [ui.fail(NOT_FOUND)] });
    await i.deferReply({ flags: EPH });
    const bundle = await store.loadBundle(meta.id);
    if (!bundle) return i.editReply({ embeds: [ui.fail('백업 데이터를 불러오지 못했어요.')] });
    await i.editReply({ embeds: [ui.infoEmbed(meta, bundle.data)] });
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdDelete(i) {
    const meta = findMeta(i, i.options.getString('아이디', true));
    if (!meta) return i.reply({ flags: EPH, embeds: [ui.fail(NOT_FOUND)] });
    await i.deferReply({ flags: EPH });
    await store.deleteBackup(meta.id);
    log(`[backup] 삭제 ${meta.id} by ${i.user.tag}`);
    await i.editReply({ embeds: [ui.ok('🗑️ 백업 삭제', `\`${meta.id}\` (${truncate(meta.guildName, 60)} · ${ts(meta.createdAt, 'f')}) 삭제했어요.`)] });
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdDownload(i) {
    const meta = findMeta(i, i.options.getString('아이디', true));
    if (!meta) return i.reply({ flags: EPH, embeds: [ui.fail(NOT_FOUND)] });
    await i.deferReply({ flags: EPH });
    const bundle = await store.loadBundle(meta.id);
    if (!bundle) return i.editReply({ embeds: [ui.fail('백업 데이터를 불러오지 못했어요.')] });
    const limit = Math.max(512 * 1024, (i.attachmentSizeLimit || 10 * 1024 * 1024) - 256 * 1024);
    const { buffer, omitted } = await exportBundle(bundle, limit);
    const file = new AttachmentBuilder(buffer, { name: `darkbackup-${meta.id}.json.gz` });
    await i.editReply({
      embeds: [
        ui.ok(
          '📥 백업 파일',
          [
            `\`${meta.id}\` · ${truncate(meta.guildName, 60)} · ${ts(meta.createdAt, 'f')} · ${fmtBytes(buffer.length)}`,
            '',
            '이 파일만 있으면 봇이나 DB가 날아가도 `/백업 복구 파일:`로 복구할 수 있어요.',
            '내 컴퓨터나 클라우드에 따로 보관해 두세요.',
            omitted ? `\n⚠️ 디스코드 파일 크기 제한 때문에 **${omitted}**은 빠졌어요.` : '',
          ].join('\n'),
        ),
      ],
      files: [file],
    });
  }

  // ------------------------------------------------------------------ /백업 복구
  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdRestore(i) {
    const { guild } = i;
    const id = i.options.getString('아이디');
    const file = i.options.getAttachment('파일');
    const options = {
      mode: i.options.getString('모드') || 'sync',
      messages: i.options.getBoolean('메시지') ?? true,
      unban: i.options.getBoolean('밴해제') ?? false,
    };
    if (!id && !file) {
      return i.reply({ flags: EPH, embeds: [ui.fail('`아이디`나 `파일` 중 하나는 넣어주세요. 목록은 `/백업 목록`')] });
    }
    if (guild.ownerId !== i.user.id && !i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return i.reply({ flags: EPH, embeds: [ui.fail('서버 주인이나 관리자만 복구할 수 있어요.')] });
    }
    if (state.locks.has(guild.id)) return i.reply({ flags: EPH, embeds: [ui.fail(BUSY)] });

    await i.deferReply({ flags: EPH });
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
      return i.editReply({
        embeds: [ui.fail('봇에 **관리자** 권한이 필요해요.\n서버 설정 → 역할 → 봇 역할 → 권한에서 `관리자`를 켜주세요.')],
      });
    }

    let bundle;
    if (file) {
      if (file.size > config.limits.maxImportBytes) {
        return i.editReply({ embeds: [ui.fail(`파일이 너무 커요 (${fmtBytes(file.size)}).`)] });
      }
      try {
        const buf = await fetchBuffer(file.url, { maxBytes: config.limits.maxImportBytes, timeout: 60_000 });
        bundle = await importBundle(buf);
      } catch (e) {
        return i.editReply({ embeds: [ui.fail(`백업 파일을 못 읽었어요: ${errText(e)}`)] });
      }
    } else {
      const meta = findMeta(i, id);
      if (!meta) {
        return i.editReply({
          embeds: [ui.fail(`${NOT_FOUND}\n(다른 서버의 백업은 그 서버 주인이나 백업을 만든 사람만 쓸 수 있어요)`)],
        });
      }
      bundle = await store.loadBundle(meta.id);
      if (!bundle) return i.editReply({ embeds: [ui.fail('백업 데이터를 불러오지 못했어요.')] });
    }

    const sameGuild = bundle.data.guild.id === guild.id;
    await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
    const top = me.roles.highest.position;
    const backupChannelIds = new Set(bundle.data.channels.map((c) => c.id));
    const backupRoleIds = new Set(bundle.data.roles.map((r) => r.id));
    const preview = {
      deleteChannels:
        options.mode === 'sync'
          ? guild.channels.cache.filter((c) => !c.isThread() && !(sameGuild && backupChannelIds.has(c.id))).size
          : 0,
      deleteRoles:
        options.mode === 'sync'
          ? guild.roles.cache.filter(
              (r) =>
                r.id !== guild.id && !r.managed && !me.roles.cache.has(r.id) && r.position < top && !(sameGuild && backupRoleIds.has(r.id)),
            ).size
          : 0,
    };

    const warnings = [];
    const above = guild.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.position > top).size;
    if (above) {
      warnings.push(`봇 역할보다 위에 있는 역할이 ${above}개 있어요. 그 역할은 못 건드리니 **서버 설정 → 역할에서 봇 역할을 맨 위로** 올린 뒤 복구하는 걸 추천해요.`);
    }
    if (options.unban && !sameGuild) warnings.push('밴해제는 같은 서버에 복구할 때만 적용돼요 (이번엔 무시).');
    if (options.mode === 'sync' && bundle.data.guild.features?.includes('COMMUNITY') && !guild.features.includes('COMMUNITY')) {
      warnings.push('원래 커뮤니티 서버라서 커뮤니티 기능도 자동으로 켜요.');
    }
    if (bundle.meta.type === 'file') warnings.push('업로드한 파일로 복구해요.');

    const token = state.addPending({ userId: i.user.id, guildId: guild.id, bundle, options });
    const row = /** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(
      new ButtonBuilder().setCustomId(`restore:go:${token}`).setLabel('복구 시작').setEmoji('♻️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`restore:cancel:${token}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
    );
    await i.editReply({
      embeds: [ui.confirmEmbed({ meta: bundle.meta, guild, options, preview, warnings, sameGuild })],
      components: [row],
    });
  }

  /** @param {import('discord.js').ButtonInteraction<'cached'>} i */
  async function onButton(i) {
    const [kind, action, token] = i.customId.split(':');
    if (kind !== 'restore') return;
    const p = state.takePending(token);
    if (!p) {
      // 버튼 두 번 눌림 → 이미 진행 중이면 조용히 무시
      if (state.locks.get(i.guildId) === 'restore') return i.deferUpdate().catch(() => {});
      return i.update({ embeds: [ui.fail('확인 시간이 지났어요. `/백업 복구`를 다시 해주세요.')], components: [] });
    }
    if (p.userId !== i.user.id) return i.reply({ flags: EPH, content: '복구 명령어를 쓴 사람만 누를 수 있어요.' });
    state.pending.delete(token);
    if (action === 'cancel') return i.update({ embeds: [ui.info('복구 취소', '아무것도 바뀌지 않았어요.')], components: [] });
    if (!state.lock(p.guildId, 'restore')) return i.update({ embeds: [ui.fail(BUSY)], components: [] });
    try {
      await i.update({ embeds: [ui.info('♻️ 복구 시작!', '진행 상황은 여기랑 DM으로 보여드려요.')], components: [] });
    } catch (e) {
      state.unlock(p.guildId);
      throw e;
    }
    runRestore(i, p)
      .catch((e) => warn('[restore] 실패', e))
      .finally(() => state.unlock(p.guildId));
  }

  /** @param {RestoreContext} ctx */
  async function postSummary(ctx) {
    const { guild } = ctx;
    const me = guild.members.me;
    const candidates = [
      guild.systemChannel,
      ...[...guild.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildText)
        .sort((a, b) => a.rawPosition - b.rawPosition),
    ].filter((c) => c && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages));
    const target = candidates[0];
    if (!target) return;
    const s = ctx.stats;
    await target.send({
      embeds: [
        new EmbedBuilder()
          .setColor(config.color.ok)
          .setTitle('♻️ 서버가 백업에서 복구됐어요')
          .setDescription(
            [
              `백업 \`${ctx.meta?.id ?? '?'}\` · ${ctx.meta?.createdAt ? ts(ctx.meta.createdAt, 'f') : ''}`,
              `역할 ${s.roles.created + s.roles.updated} · 채널 ${s.channels.created + s.channels.updated} · 메시지 ${s.messages.sent}`,
              s.members.later ? `예전 멤버는 다시 들어오면 원래 역할을 자동으로 받아요 (${config.rejoinDays}일간).` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .setFooter({ text: 'DarkBackup' }),
      ],
      allowedMentions: { parse: [] },
    });
  }

  /** @param {import('discord.js').ButtonInteraction<'cached'>} i */
  async function runRestore(i, p) {
    const { guild } = i;
    /** @type {RestoreContext} */
    let ctx;
    const live = new LiveMessage(() => ({ embeds: [ui.progressEmbed(ctx)] }), { interval: 3000 });
    ctx = new RestoreContext({
      guild,
      bundle: p.bundle,
      options: p.options,
      invokingChannelId: i.channelId,
      onUpdate: () => live.update(),
    });
    live.add({ edit: (payload) => i.editReply(payload), until: Date.now() + 14 * 60_000 });
    try {
      const dm = await i.user.send({ embeds: [ui.progressEmbed(ctx)] });
      live.add({ edit: (payload) => dm.edit(payload) });
    } catch {
      /* DM 막혀있음 */
    }
    log(`[restore] 시작 ${guild.name} ← ${p.bundle.meta.id} (${p.options.mode}) by ${i.user.tag}`);

    await restoreBackup(ctx, { saveLink: (link) => store.saveLink(link) });

    const final = { embeds: [ui.progressEmbed(ctx)] };
    await live.finish(final);
    if (!live.alive) await i.user.send(final).catch(() => {});
    log(`[restore] 끝 ${guild.name} · 경고 ${ctx.warnings.length}개${ctx.error ? ` · 오류: ${errText(ctx.error)}` : ''}`);

    if (!ctx.error && ctx.opts.mode === 'sync') await postSummary(ctx).catch(() => {});

    // 복구된 상태를 새 기준으로 → 10분 뒤 자동백업 (급감 감지 한 번 건너뜀)
    await ensureConfig(store, guild, 10 * 60_000);
    const cfg = store.getConfig(guild.id);
    const interval = (cfg?.intervalHours || config.defaults.intervalHours) * 3_600_000;
    await store.patchConfig(guild.id, {
      guildName: guild.name,
      paused: false,
      pauseReason: null,
      skipSanityOnce: true,
      lastRunAt: Date.now() - interval + 10 * 60_000,
    });
  }

  // ------------------------------------------------------------------ /자동백업
  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdAutoSet(i) {
    const { guild } = i;
    const cur = store.getConfig(guild.id) || {};
    const intervalHours = i.options.getInteger('주기') ?? cur.intervalHours ?? config.defaults.intervalHours;
    const keep = i.options.getInteger('보관') ?? cur.keep ?? config.defaults.keep;
    const messageLimit = i.options.getInteger('메시지수') ?? cur.messageLimit ?? config.defaults.messageLimit;
    const cfg = await store.patchConfig(guild.id, {
      guildName: guild.name,
      enabled: true,
      paused: false,
      pauseReason: null,
      intervalHours,
      keep,
      messageLimit,
      configuredBy: i.user.id,
      lastRunAt: cur.lastRunAt ?? Date.now() - intervalHours * 3_600_000 + 60_000,
    });
    await i.reply({ flags: EPH, embeds: [ui.statusEmbed(cfg, store, guild).setTitle('✅ 자동백업 설정 완료')] });
    store.applyRetention(guild.id, keep).catch(() => {});
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdAutoOff(i) {
    const cfg = await store.patchConfig(i.guild.id, { guildName: i.guild.name, enabled: false });
    await i.reply({ flags: EPH, embeds: [ui.statusEmbed(cfg, store, i.guild).setTitle('⛔ 자동백업 꺼짐')] });
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdAutoStatus(i) {
    await i.reply({ flags: EPH, embeds: [ui.statusEmbed(store.getConfig(i.guild.id), store, i.guild)] });
  }

  /** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} i */
  async function cmdAutoResume(i) {
    await ensureConfig(store, i.guild, 0);
    await store.patchConfig(i.guild.id, {
      enabled: true,
      paused: false,
      pauseReason: null,
      skipSanityOnce: true,
      lastRunAt: 0,
    });
    await i.reply({
      flags: EPH,
      embeds: [ui.ok('▶️ 자동백업 재개', '1분 안에 지금 서버 상태로 새 백업을 만들고, 그걸 새 기준으로 삼아요.')],
    });
    setTimeout(() => scheduler?.tick().catch(() => {}), 3000);
  }

  const routes = {
    '백업/생성': cmdCreate,
    '백업/목록': cmdList,
    '백업/정보': cmdInfo,
    '백업/복구': cmdRestore,
    '백업/다운로드': cmdDownload,
    '백업/삭제': cmdDelete,
    '자동백업/설정': cmdAutoSet,
    '자동백업/끄기': cmdAutoOff,
    '자동백업/상태': cmdAutoStatus,
    '자동백업/재개': cmdAutoResume,
  };

  /** @param {import('discord.js').Interaction} i */
  return async function handleInteraction(i) {
    try {
      if (i.isAutocomplete()) return await onAutocomplete(i);
      if (i.isButton()) {
        if (!i.inCachedGuild()) return;
        return await onButton(i);
      }
      if (!i.isChatInputCommand()) return;
      if (!i.inCachedGuild()) return i.reply({ flags: EPH, content: '서버 안에서만 쓸 수 있어요.' });
      const route = routes[`${i.commandName}/${i.options.getSubcommand()}`];
      if (route) await route(i);
    } catch (e) {
      warn('[interaction]', e);
      if (!i.isRepliable()) return;
      const payload = { embeds: [ui.fail(errText(e))], components: [] };
      if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
      else await i.reply({ ...payload, flags: EPH }).catch(() => {});
    }
  };
}

module.exports = { createInteractionHandler };
