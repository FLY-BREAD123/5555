const config = require('../config');
const { gzip, gunzip, newId, fmtBytes, log } = require('../util');
const { FileDriver } = require('./file');
const { MongoDriver } = require('./mongo');

class AssetMissingError extends Error {
  constructor() {
    super('저장소에서 에셋을 찾을 수 없음');
    this.name = 'AssetMissingError';
  }
}

/**
 * 저장소 공통 레이어.
 * - 백업 메타데이터/설정은 메모리에 들고 있어서 목록·자동완성이 즉시 응답됨
 * - 이모지/아이콘 이미지는 해시로 한 번만 저장 (백업마다 중복 저장 X)
 */
class Store {
  constructor(driver) {
    this.driver = driver;
    this.metas = new Map();
    this.configs = new Map();
    this.links = new Map();
    this.memo = new Map(); // guildId -> Map(assetKey -> sha)
    this.queue = Promise.resolve();
  }

  get kind() {
    return this.driver.kind;
  }

  get durable() {
    return this.driver.durable;
  }

  async init() {
    await this.driver.init();
    for (const meta of await this.driver.listBackupMetas()) this.metas.set(meta.id, meta);
    for (const cfg of await this.driver.listConfigs()) this.configs.set(cfg.guildId, cfg);
    for (const link of await this.driver.listLinks()) {
      if (link.expiresAt && link.expiresAt < Date.now()) await this.driver.deleteLink(link.guildId);
      else this.links.set(link.guildId, link);
    }
    log(`[storage] ${this.kind} 준비 완료 · 백업 ${this.metas.size}개 · 서버 설정 ${this.configs.size}개`);
  }

  close() {
    return this.driver.close();
  }

  /** 저장/삭제/GC가 서로 꼬이지 않게 한 줄로 실행 */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ===================== 백업 =====================
  newBackupId() {
    let id;
    do id = newId(8);
    while (this.metas.has(id));
    return id;
  }

  /** bundle = { meta, data, assets: Map<sha, Buffer|null> } (null = 이미 저장된 에셋 재사용) */
  saveBundle(bundle) {
    return this.serial(async () => {
      const { meta, data, assets } = bundle;
      const gz = await gzip(Buffer.from(JSON.stringify(data)), { level: 9 });
      if (gz.length > config.limits.maxDataBytes) {
        throw new Error(`백업 데이터가 너무 큼 (${fmtBytes(gz.length)}). 메시지 개수를 줄여주세요.`);
      }
      const shas = [...assets.keys()];
      const existing = await this.driver.existingAssets(shas);
      let assetBytes = 0;
      for (const [sha, buf] of assets) {
        if (existing.has(sha)) continue;
        if (!buf) throw new AssetMissingError();
        await this.driver.putAsset(sha, buf);
      }
      for (const buf of assets.values()) if (buf) assetBytes += buf.length;
      meta.size = gz.length;
      meta.assetBytes = assetBytes;
      meta.assets = shas;
      await this.driver.putBackup(meta, gz);
      this.metas.set(meta.id, meta);
      return meta;
    });
  }

  async loadBundle(id) {
    const meta = this.metas.get(id);
    if (!meta) return null;
    const gz = await this.driver.getBackupData(id);
    if (!gz) return null;
    const data = JSON.parse((await gunzip(gz)).toString('utf8'));
    const assets = await this.driver.getAssets(meta.assets || []);
    return { meta, data, assets };
  }

  deleteBackup(id, { gc = true } = {}) {
    return this.serial(async () => {
      await this.driver.deleteBackup(id);
      this.metas.delete(id);
      if (gc) await this.gcUnsafe();
    });
  }

  async gcUnsafe() {
    const keep = new Set();
    for (const m of this.metas.values()) for (const sha of m.assets || []) keep.add(sha);
    for (const memo of this.memo.values()) for (const sha of memo.values()) keep.add(sha);
    const removed = await this.driver.deleteAssetsExcept(keep);
    if (removed) log(`[storage] 안 쓰는 이미지 ${removed}개 정리`);
  }

  gc() {
    return this.serial(() => this.gcUnsafe());
  }

  /** 자동백업 보관 개수 넘는 오래된 자동백업 삭제 (수동 백업은 절대 안 지움) */
  async applyRetention(guildId, keep) {
    const autos = this.listForGuild(guildId).filter((m) => m.type === 'auto');
    const extra = autos.slice(keep);
    if (!extra.length) return 0;
    for (const m of extra) await this.deleteBackup(m.id, { gc: false });
    await this.gc();
    return extra.length;
  }

  listForGuild(guildId) {
    return [...this.metas.values()].filter((m) => m.guildId === guildId).sort((a, b) => b.createdAt - a.createdAt);
  }

  latestForGuild(guildId) {
    return this.listForGuild(guildId)[0] || null;
  }

  /**
   * 이 유저가 볼 수 있는 백업:
   *  - 봇 주인(BOT_OWNER_IDS) → 전부
   *  - 백업 당시 서버 주인 / 백업 만든 사람
   *  - 지금 이 서버 관리자 → 이 서버 백업
   */
  listAccessible({ userId, guildId = null, adminHere = false }) {
    const isOwner = config.ownerIds.includes(userId);
    return [...this.metas.values()]
      .filter((m) => isOwner || m.ownerId === userId || m.creatorId === userId || (adminHere && guildId && m.guildId === guildId))
      .sort((a, b) => {
        const here = Number(b.guildId === guildId) - Number(a.guildId === guildId);
        return here || b.createdAt - a.createdAt;
      });
  }

  canAccess(meta, { userId, guildId = null, adminHere = false }) {
    if (!meta) return false;
    if (config.ownerIds.includes(userId)) return true;
    if (meta.ownerId === userId || meta.creatorId === userId) return true;
    return Boolean(adminHere && guildId && meta.guildId === guildId);
  }

  getMemo(guildId) {
    return this.memo.get(guildId) || new Map();
  }

  setMemo(guildId, map) {
    this.memo.set(guildId, map);
  }

  // ===================== 서버별 자동백업 설정 =====================
  getConfig(guildId) {
    return this.configs.get(guildId) || null;
  }

  allConfigs() {
    return [...this.configs.values()];
  }

  async saveConfig(cfg) {
    this.configs.set(cfg.guildId, cfg);
    await this.driver.putConfig(cfg);
    return cfg;
  }

  async patchConfig(guildId, patch) {
    const cfg = { ...(this.getConfig(guildId) || { guildId }), ...patch };
    return this.saveConfig(cfg);
  }

  // ===================== 재입장 역할 지급 =====================
  getLink(guildId) {
    const link = this.links.get(guildId);
    if (!link) return null;
    if (link.expiresAt && link.expiresAt < Date.now()) {
      this.links.delete(guildId);
      this.driver.deleteLink(guildId).catch(() => {});
      return null;
    }
    return link;
  }

  async saveLink(link) {
    this.links.set(link.guildId, link);
    await this.driver.putLink(link);
  }

  async deleteLink(guildId) {
    this.links.delete(guildId);
    await this.driver.deleteLink(guildId);
  }
}

function createStore() {
  if (config.mongoUri) return new Store(new MongoDriver(config.mongoUri, config.mongoDb));
  return new Store(new FileDriver(config.dataDir, { durable: !config.onRender }));
}

module.exports = { createStore, Store, AssetMissingError };
