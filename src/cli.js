#!/usr/bin/env node
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { EventStore } from "./store.js";
import { FieldService } from "./service.js";
import { createHttpServer } from "./api.js";
import { organizerReport, brandReport } from "./reports.js";
import { IntegrityError } from "./errors.js";

const HELP = `山野装备实测调度服务

用法：
  field-trial serve   --event-file ./data/events.jsonl [--port 8080] [--tokens ./tokens.json]
  field-trial export  --event-file ./events.jsonl --report organizer [--out report.json]
                      --report brand --brand <品牌>
  field-trial custody --event-file ./events.jsonl --sample <装备编号>
  field-trial replay  --event-file ./events.jsonl

环境变量：
  FIELD_EVENT_FILE   事件日志路径
  FIELD_TOKENS_FILE  令牌配置（{ "token": { "role": "organizer" } }）
  FIELD_PSEUDONYM_SECRET  品牌假名 HMAC 密钥
  PORT               服务端口
`;

function options() {
  const { values, positionals } = parseArgs({
    options: {
      "event-file": { type: "string" },
      tokens: { type: "string" },
      port: { type: "string" },
      report: { type: "string" },
      brand: { type: "string" },
      sample: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false }
    },
    allowPositionals: true
  });
  return { values, positionals };
}

function loadTokens(path) {
  if (path) {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  }
  // 便于本地与自动化验证：未提供配置时给出固定开发令牌。
  return {
    "org-dev-token": { role: "organizer" },
    "safety-dev-token": { role: "safety" },
    "member-dev-token": { role: "member" },
    "brand-a-token": { role: "brand", brand: "Aurora" },
    "brand-b-token": { role: "brand", brand: "Nimbus" }
  };
}

function buildService(values) {
  const file = values["event-file"] ?? process.env.FIELD_EVENT_FILE;
  if (!file) throw new Error("需要 --event-file 或 FIELD_EVENT_FILE");
  const store = new EventStore(resolve(file));
  const service = new FieldService(store, {
    pseudonymSecret: process.env.FIELD_PSEUDONYM_SECRET ?? "field-trial-secret"
  });
  return { store, service };
}

async function main() {
  const { values, positionals } = options();
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "serve") {
    const { store, service } = buildService(values);
    const credentials = loadTokens(values.tokens ?? process.env.FIELD_TOKENS_FILE);
    const server = createHttpServer(service, credentials);
    const port = Number(values.port ?? process.env.PORT ?? 8080);
    await new Promise((done) => server.listen(port, done));
    process.stdout.write(
      `服务已启动：http://127.0.0.1:${port}，事件日志 ${store.file}，已重放 ${store.events.length} 个事件\n`
    );
    return;
  }

  if (command === "export") {
    const { service } = buildService(values);
    let output;
    if (values.report === "brand") {
      if (!values.brand) throw new Error("品牌报告需要 --brand");
      output = brandReport(service, service.state(), values.brand);
    } else {
      output = organizerReport(service.state(), { headHash: service.store.headHash() });
    }
    const text = JSON.stringify(output, null, 2);
    if (values.out) writeFileSync(resolve(values.out), text);
    process.stdout.write(text + "\n");
    return;
  }

  if (command === "custody") {
    if (!values.sample) throw new Error("需要 --sample");
    const { service } = buildService(values);
    process.stdout.write(JSON.stringify(service.custodyOf(values.sample), null, 2) + "\n");
    return;
  }

  if (command === "replay") {
    const { store } = buildService(values);
    // load 已在构造时执行并校验哈希链；这里显式复核一次。
    store.load();
    process.stdout.write(
      `哈希链校验通过：${store.events.length} 个事件，head=${store.headHash().slice(0, 16)}…\n`
    );
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((err) => {
  if (err instanceof IntegrityError) {
    process.stderr.write(`完整性校验失败：${err.message}\n`);
  } else {
    process.stderr.write(`${err.message}\n`);
  }
  process.exit(1);
});
