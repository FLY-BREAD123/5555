const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * 로컬 파일 저장소 (PC에서 테스트할 때용).
 * Render 무료 서버는 재시작/재배포 때 파일이 지워지므로 실서버에선 MongoDB를 쓰세요.
 */
class FileDriver {
  constructor(dir, { durable = true } = {}) {
    this.kind = 'file';
    this.durable = durable;
    this.dir = path.resolve(dir);
    this.backupDir = path.join(this.dir, 'backups');
    this.assetDir = path.join(this.dir, 'assets');
    this.linkDir = path.join(this.dir, 'links');
    this.configFile = path.join(this.dir, 'configs.json');
    this.configs = {};
  }

  async init() {
    for (const d of [this.dir, this.backupDir, this.assetDir, this.linkDir]) await fsp.mkdir(d, { recursive: true });
    try {
      this.configs = JSON.parse(await fsp.readFile(this.configFile, 'utf8'));
    } catch {
      this.configs = {};
    }
  }

  async close() {}

  async writeAtomic(file, content) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
  }

  // ---------- 백업 ----------
  async listBackupMetas() {
    const files = (await fsp.readdir(this.backupDir)).filter((f) => f.endsWith('.meta.json'));
    const out = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(this.backupDir, f), 'utf8')));
      } catch {
        /* 깨진 파일 무시 */
      }
    }
    return out;
  }

  async putBackup(meta, dataGz) {
    await this.writeAtomic(path.join(this.backupDir, `${meta.id}.data.gz`), dataGz);
    await this.writeAtomic(path.join(this.backupDir, `${meta.id}.meta.json`), JSON.stringify(meta));
  }

  async getBackupData(id) {
    try {
      return await fsp.readFile(path.join(this.backupDir, `${id}.data.gz`));
    } catch {
      return null;
    }
  }

  async deleteBackup(id) {
    await fsp.rm(path.join(this.backupDir, `${id}.meta.json`), { force: true });
    await fsp.rm(path.join(this.backupDir, `${id}.data.gz`), { force: true });
  }

  // ---------- 에셋(아이콘/이모지 이미지) ----------
  async existingAssets(shas) {
    const set = new Set();
    for (const sha of shas) if (fs.existsSync(path.join(this.assetDir, sha))) set.add(sha);
    return set;
  }

  async putAsset(sha, buf) {
    const file = path.join(this.assetDir, sha);
    if (!fs.existsSync(file)) await this.writeAtomic(file, buf);
  }

  async getAssets(shas) {
    const map = new Map();
    for (const sha of shas) {
      try {
        map.set(sha, await fsp.readFile(path.join(this.assetDir, sha)));
      } catch {
        /* 없는 에셋 */
      }
    }
    return map;
  }

  async deleteAssetsExcept(keep) {
    let removed = 0;
    for (const f of await fsp.readdir(this.assetDir)) {
      if (f.endsWith('.tmp') || keep.has(f)) continue;
      await fsp.rm(path.join(this.assetDir, f), { force: true });
      removed++;
    }
    return removed;
  }

  // ---------- 서버별 설정 ----------
  async listConfigs() {
    return Object.values(this.configs);
  }

  async putConfig(cfg) {
    this.configs[cfg.guildId] = cfg;
    await this.writeAtomic(this.configFile, JSON.stringify(this.configs, null, 2));
  }

  // ---------- 재입장 역할 지급 정보 ----------
  async listLinks() {
    const out = [];
    for (const f of await fsp.readdir(this.linkDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(this.linkDir, f), 'utf8')));
      } catch {
        /* 무시 */
      }
    }
    return out;
  }

  async putLink(link) {
    await this.writeAtomic(path.join(this.linkDir, `${link.guildId}.json`), JSON.stringify(link));
  }

  async deleteLink(guildId) {
    await fsp.rm(path.join(this.linkDir, `${guildId}.json`), { force: true });
  }
}

module.exports = { FileDriver };
