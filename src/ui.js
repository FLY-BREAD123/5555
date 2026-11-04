const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const { fmtBytes, ts, fmtDuration, truncate } = require('./util');
const { PHASES } = require('./restore');

const TYPE_LABEL = { auto: '자동', manual: '수동', file: '파일' };
const MODE_LABEL = { sync: '전체 복구', add: '추가만' };
const PHASE_ICON = { wait: '▫️', run: '⏳', done: '✅', warn: '⚠️', skip: '➖' };

const base = (color) => new EmbedBuilder().setColor(color).setFooter({ text: 'DarkBackup' });
const info = (title, desc = null) => base(config.color.main).setTitle(title).setDescription(desc);
const ok = (title, desc = null) => base(config.color.ok).setTitle(title).setDescription(desc);
const caution = (title, desc = null) => base(config.color.warn).setTitle(title).setDescription(desc);
const fail = (desc) => base(config.color.err).setTitle('❌ 실패').setDescription(desc);

function statsLine(s = {}) {
  return [
    `역할 ${s.roles ?? 0}`,
    `채널 ${s.channels ?? 0}`,
    s.messages ? `메시지 ${s.messages}` : null,
    s.posts ? `포럼글 ${s.posts}` : null,
    s.emojis ? `이모지 ${s.emojis}` : null,
    s.bans ? `밴 ${s.bans}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const storageLine = (store) =>
  store.durable
    ? store.kind === 'mongo'
      ? '🟢 MongoDB (재시작해도 안전)'
      : '🟢 로컬 파일'
    : '🔴 **임시 파일** — Render가 재시작하면 백업이 전부 사라져요! `MONGODB_URI`를 설정하세요';

function backupDoneEmbed(meta, warnings = [], store) {
  const e = ok('✅ 백업 완료')
    .setDescription(
      [
        `**ID** \`${meta.id}\` · ${TYPE_LABEL[meta.type] || meta.type}${meta.note ? ` · ${truncate(meta.note, 60)}` : ''}`,
        statsLine(meta.stats),
        `용량 ${fmtBytes(meta.size)}${meta.assetBytes ? ` (+ 새 이미지 ${fmtBytes(meta.assetBytes)})` : ''}`,
        '',
        `복구할 땐 \`/백업 복구 아이디:${meta.id}\``,
        '서버가 통째로 날아가면 → 새 서버에 봇 초대 → 같은 명령어로 복구하면 돼요.',
      ].join('\n'),
    );
  if (store && !store.durable) e.addFields({ name: '저장소 경고', value: storageLine(store) });
  if (warnings.length) e.addFields({ name: `참고 (${warnings.length})`, value: truncate(warnings.slice(0, 6).map((w) => `• ${w}`).join('\n'), 1000) });
  return e;
}

function backupLine(m, showGuild) {
  return `\`${m.id}\` ${TYPE_LABEL[m.type] || m.type} · ${ts(m.createdAt, 'R')} · ${statsLine(m.stats)}${showGuild ? ` · **${truncate(m.guildName, 30)}**` : ''}${m.note ? ` · _${truncate(m.note, 30)}_` : ''}`;
}

function listEmbed(metas, guildId) {
  if (!metas.length) {
    return info('📦 백업 목록', '아직 백업이 없어요. `/백업 생성`으로 만들거나 자동백업을 기다려 주세요.');
  }
  const here = metas.filter((m) => m.guildId === guildId);
  const other = metas.filter((m) => m.guildId !== guildId);
  const lines = [];
  if (here.length) {
    lines.push('**이 서버**');
    lines.push(...here.slice(0, 15).map((m) => backupLine(m, false)));
    if (here.length > 15) lines.push(`… 외 ${here.length - 15}개`);
  }
  if (other.length) {
    if (lines.length) lines.push('');
    lines.push('**다른 서버 (내가 주인/만든 사람)**');
    lines.push(...other.slice(0, 10).map((m) => backupLine(m, true)));
    if (other.length > 10) lines.push(`… 외 ${other.length - 10}개`);
  }
  return info(`📦 백업 목록 (${metas.length}개)`, truncate(lines.join('\n'), 4000)).addFields({
    name: '사용법',
    value: '`/백업 정보` 자세히 · `/백업 복구` 복구 · `/백업 다운로드` 파일로 받기',
  });
}

function treePreview(data) {
  const cats = data.channels.filter((c) => c.type === 4);
  const lines = [];
  const loose = data.channels.filter((c) => c.type !== 4 && !c.parentId).length;
  if (loose) lines.push(`📄 카테고리 없음 (${loose})`);
  for (const cat of cats.slice(0, 15)) {
    const n = data.channels.filter((c) => c.parentId === cat.id).length;
    lines.push(`📁 ${truncate(cat.name, 40)} (${n})`);
  }
  if (cats.length > 15) lines.push(`… 외 카테고리 ${cats.length - 15}개`);
  return lines.join('\n') || '(채널 없음)';
}

function infoEmbed(meta, data) {
  const s = meta.stats || {};
  const e = info(`📦 백업 \`${meta.id}\``).addFields(
    { name: '서버', value: `${truncate(meta.guildName, 80)}\n\`${meta.guildId}\``, inline: true },
    { name: '종류', value: `${TYPE_LABEL[meta.type] || meta.type}${meta.creatorId ? `\n<@${meta.creatorId}>` : ''}`, inline: true },
    { name: '만든 시간', value: `${ts(meta.createdAt, 'f')}\n${ts(meta.createdAt, 'R')}`, inline: true },
    {
      name: '내용',
      value: [
        `역할 ${s.roles} · 카테고리 ${s.categories} · 채널 ${s.channels}`,
        `메시지 ${s.messages} · 포럼 글 ${s.posts || 0} · 이모지 ${s.emojis}`,
        `밴 ${s.bans} · 역할 저장된 멤버 ${s.members}`,
      ].join('\n'),
    },
    { name: '채널 구조', value: truncate(treePreview(data), 1000) },
    { name: '용량', value: `${fmtBytes(meta.size)}`, inline: true },
    { name: '복구', value: `\`/백업 복구 아이디:${meta.id}\``, inline: true },
  );
  if (meta.note) e.setDescription(`메모: ${truncate(meta.note, 200)}`);
  if (meta.guildIconUrl) e.setThumbnail(meta.guildIconUrl);
  return e;
}

function confirmEmbed({ meta, guild, options, preview, warnings, sameGuild }) {
  const lines = [
    `**백업** \`${meta.id}\` · ${truncate(meta.guildName, 40)} · ${ts(meta.createdAt, 'f')} (${ts(meta.createdAt, 'R')})`,
    statsLine(meta.stats),
    '',
  ];
  if (options.mode === 'sync') {
    if (sameGuild) {
      lines.push('**모드: 전체 복구** — 백업 시점이랑 똑같이 맞춰요.');
      lines.push('• 남아있는 채널·역할은 그대로 두고 설정만 되돌려요 (메시지 기록 유지)');
      lines.push('• 없어진 채널·역할·이모지는 다시 만들어요');
    } else {
      lines.push('**모드: 전체 복구** — 이 서버를 백업한 서버랑 똑같이 만들어요.');
    }
    lines.push(
      `• 백업에 없는 채널 **${preview.deleteChannels}개**, 역할 **${preview.deleteRoles}개**는 **삭제**돼요`,
      '• 서버 이름 · 아이콘 · 기본 설정도 백업대로 바뀌어요',
    );
  } else {
    lines.push('**모드: 추가만** — 아무것도 안 지우고, 없는 역할·채널·이모지만 추가해요.');
  }
  lines.push(
    '',
    `메시지 복구: ${options.messages ? '켬 (새로 만든 채널에 웹훅으로)' : '끔'}`,
    `밴 목록: 백업에 있던 밴 다시 적용${options.unban ? ' + **백업 이후 생긴 밴 해제**' : ''}`,
    '멤버 역할: 지금 있는 멤버는 바로, 나중에 들어오는 멤버는 들어올 때 자동 지급',
  );
  const e = caution(`⚠️ ${truncate(guild.name, 60)} 복구할까요?`, lines.join('\n'));
  if (warnings.length) e.addFields({ name: '주의', value: truncate(warnings.map((w) => `• ${w}`).join('\n'), 1000) });
  e.addFields({ name: '​', value: '3분 안에 **복구 시작**을 눌러주세요. 진행 상황은 DM으로도 보내드려요.' });
  return e;
}

function progressEmbed(ctx) {
  const finished = Boolean(ctx.finished);
  const title = ctx.error
    ? '❌ 복구 실패'
    : !finished
      ? '♻️ 서버 복구 중…'
      : ctx.warnings.length
        ? '✅ 복구 완료 (참고사항 있음)'
        : '✅ 복구 완료';
  const color = ctx.error ? config.color.err : finished ? config.color.ok : config.color.main;
  const lines = PHASES.map(([key, label]) => {
    const p = ctx.phase[key] || { status: 'wait', text: null };
    return `${PHASE_ICON[p.status] || '▫️'} **${label}**${p.text ? ` — ${p.text}` : ''}`;
  });
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(
      [
        `서버 **${truncate(ctx.guild.name, 50)}** ← 백업 \`${ctx.meta?.id ?? '?'}\` (${truncate(ctx.data.guild.name, 40)})`,
        `모드: ${MODE_LABEL[ctx.opts.mode] || ctx.opts.mode}`,
        '',
        ...lines,
      ].join('\n'),
    )
    .setFooter({ text: `DarkBackup · ${fmtDuration((ctx.finished || Date.now()) - ctx.started)}` });
  if (ctx.error) e.addFields({ name: '오류', value: truncate(String(ctx.error.message || ctx.error), 1000) });
  if (finished && ctx.warnings.length) {
    const shown = ctx.warnings.slice(0, 10).map((w) => `• ${truncate(w, 180)}`);
    if (ctx.warnings.length > 10) shown.push(`… 외 ${ctx.warnings.length - 10}개`);
    e.addFields({ name: `참고 (${ctx.warnings.length})`, value: truncate(shown.join('\n'), 1024) });
  }
  if (finished && !ctx.error && ctx.stats.members.later) {
    e.addFields({
      name: '나중에 들어오는 멤버',
      value: `${ctx.stats.members.later}명은 지금 서버에 없어서, **${config.rejoinDays}일 안에** 들어오면 원래 역할을 자동으로 받아요.`,
    });
  }
  return e;
}

function statusEmbed(cfg, store, guild) {
  const list = store.listForGuild(guild.id);
  const autos = list.filter((m) => m.type === 'auto').length;
  const manuals = list.filter((m) => m.type === 'manual').length;
  const latest = list[0];
  const intervalMs = (cfg?.intervalHours || config.defaults.intervalHours) * 3_600_000;
  let state;
  if (!cfg || !cfg.enabled) state = '⛔ 꺼짐 — `/자동백업 설정`으로 켜기';
  else if (cfg.paused) state = `⏸ **일시정지** — ${cfg.pauseReason || '사유 없음'}\n정상이면 \`/자동백업 재개\``;
  else state = '✅ 켜짐';
  const next = cfg?.enabled && !cfg.paused ? Math.max(Date.now(), (cfg.lastRunAt || 0) + intervalMs) : null;
  const e = info('⚙️ 자동백업 상태').addFields(
    { name: '상태', value: state },
    {
      name: '설정',
      value: `${cfg?.intervalHours ?? config.defaults.intervalHours}시간마다 · 자동백업 ${cfg?.keep ?? config.defaults.keep}개 보관 · 채널당 메시지 ${cfg?.messageLimit ?? config.defaults.messageLimit}개`,
    },
    { name: '최근 백업', value: latest ? `\`${latest.id}\` ${TYPE_LABEL[latest.type]} · ${ts(latest.createdAt, 'R')}` : '아직 없음', inline: true },
    { name: '다음 자동백업', value: next ? ts(next, 'R') : '-', inline: true },
    { name: '저장된 백업', value: `자동 ${autos} · 수동 ${manuals}`, inline: true },
    { name: '저장소', value: storageLine(store) },
  );
  if (cfg?.lastError) e.addFields({ name: '마지막 오류', value: truncate(cfg.lastError, 500) });
  return e;
}

module.exports = {
  TYPE_LABEL,
  MODE_LABEL,
  info,
  ok,
  caution,
  fail,
  statsLine,
  storageLine,
  backupDoneEmbed,
  listEmbed,
  infoEmbed,
  confirmEmbed,
  progressEmbed,
  statusEmbed,
};
