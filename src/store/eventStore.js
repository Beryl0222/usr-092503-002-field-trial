/**
 * JSONL 事件存储：append-only 日志。
 * 进程重启后从头重放事件即可完整重建状态（事件数量在单次活动规模内）。
 * 零依赖，使用 node:fs。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, "events.log");
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    // 不存在则创建空日志，保证首次读取稳定
    await fs.appendFile(this.logPath, "", { flag: "a" });
  }

  /** 追加一条事件。单进程内由 Service 的串行队列保证无并发交错。 */
  async append(event) {
    await fs.appendFile(this.logPath, JSON.stringify(event) + "\n", { flag: "a" });
  }

  /** 按顺序读取全部事件。损坏行会抛出，提示日志被破坏而非静默丢事实。 */
  async *readEvents() {
    const raw = await fs.readFile(this.logPath, "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo += 1;
      const t = line.trim();
      if (!t) continue;
      try {
        yield JSON.parse(t);
      } catch (err) {
        throw new Error(`事件日志第 ${lineNo} 行无法解析: ${err.message}`);
      }
    }
  }
}
