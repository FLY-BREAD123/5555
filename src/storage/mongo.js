const { MongoClient, Binary } = require('mongodb');

const toBuffer = (value) => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Binary) return Buffer.from(value.buffer);
  if (value.buffer) return Buffer.from(value.buffer);
  return null;
};

const strip = (doc) => {
  if (!doc) return doc;
  const { _id, data, ...rest } = doc;
  return rest;
};

/** MongoDB Atlas 무료(M0) 저장소. Render 재시작에도 백업이 안 날아감. */
class MongoDriver {
  constructor(uri, dbName) {
    this.kind = 'mongo';
    this.durable = true;
    this.uri = uri;
    this.dbName = dbName;
  }

  async init() {
    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: 15_000,
      appName: 'DarkBackup',
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.backups = this.db.collection('backups');
    this.assets = this.db.collection('assets');
    this.configs = this.db.collection('configs');
    this.links = this.db.collection('links');
    await this.backups.createIndex({ guildId: 1, createdAt: -1 });
    await this.db.command({ ping: 1 });
  }

  async close() {
    await this.client?.close().catch(() => {});
  }

  // ---------- 백업 ----------
  async listBackupMetas() {
    const docs = await this.backups.find({}, { projection: { data: 0 } }).toArray();
    return docs.map(strip);
  }

  async putBackup(meta, dataGz) {
    await this.backups.replaceOne({ _id: meta.id }, { ...meta, data: new Binary(dataGz) }, { upsert: true });
  }

  async getBackupData(id) {
    const doc = await this.backups.findOne({ _id: id }, { projection: { data: 1 } });
    return doc ? toBuffer(doc.data) : null;
  }

  async deleteBackup(id) {
    await this.backups.deleteOne({ _id: id });
  }

  // ---------- 에셋 ----------
  async existingAssets(shas) {
    if (!shas.length) return new Set();
    const docs = await this.assets.find({ _id: { $in: shas } }, { projection: { _id: 1 } }).toArray();
    return new Set(docs.map((d) => d._id));
  }

  async putAsset(sha, buf) {
    await this.assets.updateOne(
      { _id: sha },
      { $setOnInsert: { data: new Binary(buf), size: buf.length, createdAt: Date.now() } },
      { upsert: true },
    );
  }

  async getAssets(shas) {
    const map = new Map();
    if (!shas.length) return map;
    const docs = await this.assets.find({ _id: { $in: shas } }).toArray();
    for (const d of docs) map.set(d._id, toBuffer(d.data));
    return map;
  }

  async deleteAssetsExcept(keep) {
    const res = await this.assets.deleteMany({ _id: { $nin: [...keep] } });
    return res.deletedCount || 0;
  }

  // ---------- 서버별 설정 ----------
  async listConfigs() {
    return (await this.configs.find({}).toArray()).map(strip);
  }

  async putConfig(cfg) {
    await this.configs.replaceOne({ _id: cfg.guildId }, { ...cfg }, { upsert: true });
  }

  // ---------- 재입장 역할 지급 정보 ----------
  async listLinks() {
    return (await this.links.find({}).toArray()).map(strip);
  }

  async putLink(link) {
    await this.links.replaceOne({ _id: link.guildId }, { ...link }, { upsert: true });
  }

  async deleteLink(guildId) {
    await this.links.deleteOne({ _id: guildId });
  }
}

module.exports = { MongoDriver };
