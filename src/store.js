import { mkdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, sha256Hex } from "./crypto-util.js";
import { IntegrityError } from "./errors.js";

/**
 * 仅追加的事件日志（JSONL）。
 * 每行是一个带序号与哈希的事件信封，哈希覆盖前驱哈希，形成哈希链；
 * 进程重启后重放日志即可重建全部状态，并可发现任何篡改或缺行。
 */
export class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    /** cmdId -> 首次出现的事件序号，用于命令幂等与重复提交归并。 */
    this.cmdIndex = new Map();
    this._chain = Promise.resolve();
  }

  load() {
    this.events = [];
    this.cmdIndex.clear();
    if (!this.file || !existsSync(this.file)) {
      return this.events;
    }
    const text = readFileSync(this.file, "utf8");
    let prevHash = "0".repeat(64);
    const lines = text.split("\n");
    for (const [idx, line] of lines.entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (cause) {
        throw new IntegrityError(`事件日志第 ${idx + 1} 行不是合法 JSON`, { cause });
      }
      const expectedSeq = this.events.length + 1;
      if (event.seq !== expectedSeq) {
        throw new IntegrityError(`事件日志序号断裂：期望 ${expectedSeq}，实际 ${event.seq}`);
      }
      if (event.prevHash !== prevHash) {
        throw new IntegrityError(`事件 ${event.seq} 的前驱哈希不匹配，日志可能被篡改`);
      }
      if (event.hash !== hashEvent(event)) {
        throw new IntegrityError(`事件 ${event.seq} 的内容哈希不匹配，日志可能被篡改`);
      }
      prevHash = event.hash;
      this.events.push(event);
      if (event.cmdId) {
        if (!this.cmdIndex.has(event.cmdId)) this.cmdIndex.set(event.cmdId, event.seq);
      }
    }
    return this.events;
  }

  /** 串行化所有写入：并发命令按到达顺序决出唯一成功者，其余得到冲突。 */
  async append(type, data, { cmdId = null, timestamp = new Date().toISOString() } = {}) {
    const run = this._chain.then(() => this._appendSync(type, data, cmdId, timestamp));
    // 队列本身不因业务失败而断裂。
    this._chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * 串行临界区：fn 内部读取到的状态不会被其他写入穿插，
   * “先查重再追加观察、再判定阈值冻结”这类复合命令在此完成。
   */
  runExclusive(fn) {
    const run = this._chain.then(() =>
      fn({
        append: (type, data, { cmdId = null, timestamp = new Date().toISOString() } = {}) =>
          this._appendSync(type, data, cmdId, timestamp)
      })
    );
    this._chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  _appendSync(type, data, cmdId, timestamp) {
    if (cmdId && this.cmdIndex.has(cmdId)) {
      const seq = this.cmdIndex.get(cmdId);
      return { event: this.events[seq - 1], duplicated: true };
    }
    const seq = this.events.length + 1;
    const prevHash = seq === 1 ? "0".repeat(64) : this.events[seq - 2].hash;
    const event = { seq, type, timestamp, cmdId: cmdId ?? null, data, prevHash, hash: "" };
    event.hash = hashEvent(event);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    }
    this.events.push(event);
    if (cmdId) this.cmdIndex.set(cmdId, seq);
    return { event, duplicated: false };
  }

  headHash() {
    return this.events.length ? this.events[this.events.length - 1].hash : "0".repeat(64);
  }
}

export function hashEvent(event) {
  const body = canonicalize({
    seq: event.seq,
    type: event.type,
    timestamp: event.timestamp,
    cmdId: event.cmdId ?? null,
    data: event.data,
    prevHash: event.prevHash
  });
  return sha256Hex(body);
}
