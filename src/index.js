const http = require('node:http');
const { Client, GatewayIntentBits, Events, ActivityType, ApplicationFlags } = require('discord.js');
const config = require('./config');
const commands = require('./commands');
const { createStore } = require('./storage');
const { createScheduler, ensureConfig } = require('./scheduler');
const { createInteractionHandler } = require('./interactions');
const { setupGuard } = require('./guard');
const { setupRejoin } = require('./rejoin');
const { log, warn } = require('./util');

let client = null;
let store = null;

// ---------------------------------------------------------------- Render용 HTTP (헬스체크 + 잠들기 방지)
function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          bot: client?.user?.tag ?? null,
          ready: Boolean(client?.isReady()),
          guilds: client?.guilds.cache.size ?? 0,
          storage: store ? store.kind : null,
          backups: store ? store.metas.size : 0,
          uptime: Math.round(process.uptime()),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.port, '0.0.0.0', () => log(`[http] ${config.port} 포트에서 대기 중`));
  return server;
}

// Render 무료 서버는 15분 동안 들어오는 요청이 없으면 잠들어서 봇이 꺼짐 → 5분마다 자기 주소를 찔러서 깨워둠
function startSelfPing() {
  if (!config.selfPingUrl) {
    if (config.onRender) warn('[ping] RENDER_EXTERNAL_URL이 없어서 셀프핑을 못 해요. SELF_PING_URL을 직접 넣어주세요.');
    return;
  }
  const url = `${config.selfPingUrl}/health`;
  setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => warn(`[ping] 실패: ${e.message}`));
  }, 5 * 60_000).unref();
  log(`[ping] 5분마다 ${url} 호출 (Render 잠들기 방지)`);
}

async function main() {
  startHttp();
  startSelfPing();

  if (!config.token) {
    warn('DISCORD_TOKEN이 없어요. Render → Environment 에 봇 토큰을 넣어주세요.');
    return;
  }

  store = createStore();
  try {
    await store.init();
  } catch (e) {
    warn('저장소 연결 실패!', e.message);
    if (config.mongoUri) {
      warn('→ MongoDB Atlas에서 Network Access에 0.0.0.0/0 허용했는지, MONGODB_URI의 비밀번호가 맞는지 확인하세요.');
    }
    process.exit(1);
  }
  if (!store.durable) {
    warn('==================================================================');
    warn(' MONGODB_URI가 없어서 임시 파일에 저장 중이에요.');
    warn(' Render는 재시작/재배포 때 파일을 지우니까 백업이 다 사라져요!');
    warn(' README의 MongoDB 설정을 꼭 해주세요.');
    warn('==================================================================');
  }

  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
    allowedMentions: { parse: [] },
    rest: {
      // 이모지 업로드 제한(길면 몇 시간)에 걸리면 기다리지 말고 건너뛰기
      rejectOnRateLimit: (data) => data.route.includes('/emojis') && data.timeToReset > 60_000,
    },
  });

  const scheduler = createScheduler({ client, store });
  const handleInteraction = createInteractionHandler({ client, store, scheduler });
  setupGuard({ client, store });
  setupRejoin({ client, store });

  client.once(Events.ClientReady, async (c) => {
    log(`[bot] ${c.user.tag} 로그인 · 서버 ${c.guilds.cache.size}개`);
    try {
      await c.application.fetch();
      const flags = c.application.flags;
      if (!flags.has(ApplicationFlags.GatewayMessageContent) && !flags.has(ApplicationFlags.GatewayMessageContentLimited)) {
        warn('[bot] MESSAGE CONTENT INTENT가 꺼져 있어요 → 메시지 내용이 빈칸으로 백업돼요. 개발자 포털 → Bot에서 켜주세요.');
      }
      await c.application.commands.set(commands);
      log('[bot] 슬래시 명령어 등록 완료 (/백업, /자동백업)');
    } catch (e) {
      warn('[bot] 명령어 등록 실패', e);
    }
    for (const guild of c.guilds.cache.values()) {
      await ensureConfig(store, guild, 2 * 60_000).catch((e) => warn('[bot] 설정 생성 실패', e));
    }
    c.user.setActivity('서버 백업 지키는 중 · /백업', { type: ActivityType.Custom });
  });

  client.on(Events.GuildCreate, (guild) => {
    log(`[bot] 새 서버 들어옴: ${guild.name} (${guild.id})`);
    // 새 서버에 초대된 직후엔 복구부터 할 수도 있으니 첫 자동백업은 15분 뒤
    ensureConfig(store, guild, 15 * 60_000).catch((e) => warn('[bot] 설정 생성 실패', e));
  });
  client.on(Events.GuildDelete, (guild) => {
    log(`[bot] 서버에서 나가짐/서버 삭제됨: ${guild.name ?? guild.id} — 백업은 그대로 보관돼요`);
  });
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (e) => warn('[bot] client error', e));
  client.on(Events.ShardDisconnect, (_, id) => warn(`[bot] 게이트웨이 연결 끊김 (shard ${id}) — 자동 재연결 시도`));

  const login = async (attempt = 0) => {
    try {
      await client.login(config.token);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/disallowed intents|privileged intent/i.test(msg)) {
        warn('==================================================================');
        warn(' 로그인 실패: 개발자 포털에서 인텐트를 켜야 해요!');
        warn(' https://discord.com/developers/applications → 봇 선택 → Bot 메뉴');
        warn(' → SERVER MEMBERS INTENT, MESSAGE CONTENT INTENT 둘 다 켜고 저장 → Render에서 재시작');
        warn('==================================================================');
        return;
      }
      if (/token/i.test(msg)) {
        warn('로그인 실패: DISCORD_TOKEN이 틀렸어요. 개발자 포털에서 Reset Token 후 다시 넣어주세요.');
        return;
      }
      // 네트워크 문제 등은 잠깐 기다렸다 다시
      const wait = Math.min(300_000, 15_000 * 2 ** attempt);
      warn(`로그인 실패 (${msg}) → ${Math.round(wait / 1000)}초 뒤 다시 시도`);
      setTimeout(() => login(attempt + 1), wait);
    }
  };
  await login();
}

async function shutdown(signal) {
  log(`[bot] ${signal} 받음 → 종료`);
  try {
    await client?.destroy();
  } catch {
    /* 무시 */
  }
  try {
    await store?.close();
  } catch {
    /* 무시 */
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => warn('[process] unhandledRejection', e));
process.on('uncaughtException', (e) => warn('[process] uncaughtException', e));

main();
