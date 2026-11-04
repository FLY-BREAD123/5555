/**
 * 진행 상황 메시지를 여러 곳(명령어 답장, DM)에 동시에, 너무 자주 안 되게 수정
 */
class LiveMessage {
  constructor(render, { interval = 3000 } = {}) {
    this.render = render;
    this.interval = interval;
    this.targets = [];
    this.timer = null;
    this.last = 0;
    this.dirty = false;
    this.chain = Promise.resolve();
  }

  /** target: { edit(payload): Promise, until?: number } */
  add(target) {
    this.targets.push({ ...target, dead: false });
  }

  update() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.interval - (Date.now() - this.last));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  flush(payload = null) {
    this.chain = this.chain.then(async () => {
      if (!payload && !this.dirty) return;
      this.dirty = false;
      this.last = Date.now();
      const body = payload || this.render();
      const now = Date.now();
      await Promise.all(
        this.targets
          .filter((t) => !t.dead && (!t.until || t.until > now))
          .map((t) =>
            t.edit(body).catch(() => {
              t.dead = true;
            }),
          ),
      );
    });
    return this.chain;
  }

  async finish(payload) {
    clearTimeout(this.timer);
    this.timer = null;
    await this.flush(payload);
  }

  get alive() {
    const now = Date.now();
    return this.targets.filter((t) => !t.dead && (!t.until || t.until > now)).length;
  }
}

module.exports = { LiveMessage };
