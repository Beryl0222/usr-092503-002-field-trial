import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { EventStore } from "../src/store.js";
import { FieldService } from "../src/service.js";
import { createHttpServer } from "../src/api.js";
import { IntegrityError } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = join(ROOT, "src", "cli.js");

const TOKENS = {
  "org-dev-token": { role: "organizer" },
  "safety-dev-token": { role: "safety" },
  "member-dev-token": { role: "member" },
  "brand-a-token": { role: "brand", brand: "Aurora" },
  "brand-b-token": { role: "brand", brand: "Nimbus" }
};
const AUTH = {
  org: "Bearer org-dev-token",
  safety: "Bearer safety-dev-token",
  member: "Bearer member-dev-token",
  aurora: "Bearer brand-a-token",
  nimbus: "Bearer brand-b-token"
};

/** 一次完整的三天两晚高海拔实测，在单个自动化验证中重现全部关键过程。 */
test("端到端：登记→计划→并发领用→离线去重→冻结抢占→独立复核→重启接续→可追溯脱敏报告", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "field-trial-"));
  const eventFile = join(dir, "events.jsonl");
  const store = new EventStore(eventFile);
  const service = new FieldService(store);
  const server = createHttpServer(service, TOKENS);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body, { auth = AUTH.member, key, at } = {}) {
    const headers = { authorization: auth };
    if (body) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    if (at) headers["x-observed-at"] = at;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }
  const post = (path, body, opts) => call("POST", path, body, opts);
  const get = (path, opts) => call("GET", path, null, opts);

  const S1 = { lat: 30.0, lng: 100.0 };
  const S1_END = { lat: 30.005, lng: 100.005 };
  const S2_END = { lat: 30.01, lng: 100.01 };
  const ON_S1 = { lat: 30.0025, lng: 100.0025 };
  const ON_S2 = { lat: 30.0075, lng: 100.0075 };

  // ---------- 1. 登记：人员资质、小队、路线分段、唯一装备、品牌不可见指标 ----------
  for (const p of [
    { id: "p1", name: "阿峰", qualifications: ["alpine"] },
    { id: "p2", name: "阿岚", qualifications: ["alpine", "safety_officer"] },
    { id: "p3", name: "阿岩", qualifications: ["safety_officer"] },
    { id: "p4", name: "阿禾", qualifications: [] }
  ]) {
    const r = await post("/register/person", p, { auth: AUTH.org });
    assert.equal(r.status, 201, `登记 ${p.id}`);
  }
  // 队员不能登记资源
  assert.equal((await post("/register/person", { id: "px", name: "X" })).status, 403);

  await post(
    "/register/team",
    { id: "t1", name: "雪豹队", memberIds: ["p1", "p4"], qualifications: ["alpine"], capacity: 2 },
    { auth: AUTH.org }
  );
  await post(
    "/register/team",
    { id: "t2", name: "岩羊队", memberIds: ["p2"], qualifications: ["alpine", "safety_officer"], capacity: 2 },
    { auth: AUTH.org }
  );
  await post(
    "/register/segment",
    { id: "s1", name: "杜鹃林", order: 1, start: S1, end: S1_END, terrain: ["mud", "rain"] },
    { auth: AUTH.org }
  );
  await post(
    "/register/segment",
    { id: "s2", name: "碎石下坡", order: 2, start: S1_END, end: S2_END, terrain: ["scree"] },
    { auth: AUTH.org }
  );
  for (const s of [
    { id: "g1", brand: "Aurora", item: "硬壳冲锋衣", mutexGroup: "shell", requiredQualification: "alpine" },
    { id: "g2", brand: "Aurora", item: "轻量冲锋衣", mutexGroup: "shell" },
    { id: "g3", brand: "Nimbus", item: "登山靴", requiredQualification: "alpine" },
    { id: "g4", brand: "Nimbus", item: "双层帐篷" },
    { id: "g5", brand: "Vertex", item: "冰爪", requiredQualification: "ice_climbing" }
  ]) {
    const r = await post("/register/sample", s, { auth: AUTH.org });
    assert.equal(r.status, 201);
  }
  await post(
    "/register/metric",
    { id: "rain", name: "降雨", kind: "environment", unit: "mm/h", brandVisible: true },
    { auth: AUTH.org }
  );
  await post(
    "/register/metric",
    {
      id: "leak",
      name: "渗水评分",
      kind: "gear",
      unit: "级",
      brandVisible: true,
      thresholds: [{ level: 2, op: ">=", value: 4 }]
    },
    { auth: AUTH.org }
  );
  // 健康指标即使误配 brandVisible，也强制对品牌不可见
  await post(
    "/register/metric",
    {
      id: "spo2",
      name: "血氧",
      kind: "health",
      unit: "%",
      brandVisible: true,
      thresholds: [{ level: 2, op: "<=", value: 85 }]
    },
    { auth: AUTH.org }
  );

  // 幂等键：同一命令重放不产生第二条事件
  const segOnce = await post(
    "/register/segment",
    { id: "s9", name: "备用段", order: 9, start: S2_END, end: { lat: 30.015, lng: 100.015 } },
    { auth: AUTH.org, key: "cmd-seg9" }
  );
  const segTwice = await post(
    "/register/segment",
    { id: "s9", name: "备用段", order: 9, start: S2_END, end: { lat: 30.015, lng: 100.015 } },
    { auth: AUTH.org, key: "cmd-seg9" }
  );
  assert.equal(segOnce.body.seq, segTwice.body.seq);

  // ---------- 2. 生成领用计划：资质 + 互斥 + 容量；无法安排的冲突出发前可见 ----------
  const plan = await post("/plan", {}, { auth: AUTH.org });
  assert.equal(plan.status, 201);
  const bySample = Object.fromEntries(plan.body.entries.map((e) => [e.sampleId, e]));
  assert.equal(bySample.g1.teamId, "t1"); // 需 alpine
  assert.equal(bySample.g1.userId, "p1");
  assert.equal(bySample.g2.teamId, "t2"); // 与 g1 同互斥组，被挤到另一小队
  assert.notEqual(bySample.g2.teamId, bySample.g1.teamId);
  assert.ok(bySample.g3, "g3 可安排");
  const unassignable = plan.body.conflicts.find((c) => c.sampleId === "g5");
  assert.ok(unassignable, "无人持冰攀资质，g5 冲突在出发前可见");

  // 无资质领用被拒
  const noQual = await post(
    "/custody/checkout",
    { sampleId: "g1", userId: "p4", teamId: "t1", segmentId: "s1" }
  );
  assert.equal(noQual.status, 403);

  // ---------- 3. 并发领用同一装备：只有一条成功 ----------
  const [win, lose] = await Promise.all([
    post("/custody/checkout", { sampleId: "g1", userId: "p1", teamId: "t1", segmentId: "s1" }, { key: "co-1" }),
    post("/custody/checkout", { sampleId: "g1", userId: "p1", teamId: "t1", segmentId: "s1" }, { key: "co-2" })
  ]);
  const statuses = [win.status, lose.status].sort();
  assert.deepEqual(statuses, [201, 409], "并发领用：一成一冲突");
  assert.match(lose.status === 409 ? lose.body.message : win.body.message, /并发领用被拒/);

  const custodyAfterCo = await get("/custody/g1", { auth: AUTH.org });
  assert.equal(custodyAfterCo.body.currentHolder, "p1");
  assert.equal(custodyAfterCo.body.chain.at(-1).eventType, "check_out");

  // ---------- 4. 离线乱序 + 重复补传：归并为同一事实，并归到正确路段 ----------
  // 故意先传 10:30，再补 10:00 与 10:15；10:00 重传一次。
  const c = await post(
    "/observations",
    { userId: "p1", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T10:30:00Z", value: 2, point: ON_S1, clientId: "tab-c" },
    { at: "2026-09-26T10:30:00Z" }
  );
  assert.equal(c.status, 201);
  const a1 = await post(
    "/observations",
    { userId: "p1", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T10:00:00Z", value: 2, point: ON_S1, clientId: "tab-a" },
    { at: "2026-09-26T10:00:00Z" }
  );
  const a2 = await post(
    "/observations",
    { userId: "p1", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T10:00:00Z", value: 2, point: ON_S1, clientId: "tab-a" },
    { at: "2026-09-26T10:00:05Z" }
  );
  assert.equal(a1.body.duplicated, false);
  assert.equal(a2.body.duplicated, true, "同一 clientId 补传归并");
  assert.equal(a2.body.observationId, a1.body.observationId);
  await post(
    "/observations",
    { userId: "p1", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T10:15:00Z", value: 3, point: ON_S1, clientId: "tab-b" },
    { at: "2026-09-26T10:15:00Z" }
  );
  await post(
    "/observations",
    { userId: "p4", metricId: "rain", observedAt: "2026-09-26T09:50:00Z", value: 18, point: ON_S1, clientId: "tab-env" },
    { at: "2026-09-26T09:50:00Z" }
  );

  // ---------- 5. 健康阈值触发：受影响路段与样品立即冻结，抢占普通操作 ----------
  const health = await post(
    "/observations",
    { userId: "p4", metricId: "spo2", observedAt: "2026-09-26T11:00:00Z", value: 82, point: ON_S2, clientId: "tab-spo2" },
    { at: "2026-09-26T11:00:00Z" }
  );
  assert.equal(health.status, 201);
  assert.ok(health.body.freeze, "血氧跌破阈值自动冻结");
  assert.equal(health.body.freeze.segmentId, "s2", "按 GPS 归因到碎石下坡");
  assert.deepEqual(health.body.freeze.sampleIds, ["g1"], "冻结波及该小队现场持有的样品");
  const freezeS2 = health.body.freeze.freezeId;

  // 冻结生效期间：普通领用与转交一律被抢占（423）
  const blockedCheckout = await post(
    "/custody/checkout",
    { sampleId: "g2", userId: "p2", teamId: "t2", segmentId: "s2" }
  );
  assert.equal(blockedCheckout.status, 423);
  const blockedTransfer = await post("/custody/transfer", {
    sampleId: "g1",
    fromUserId: "p1",
    toUserId: "p2"
  });
  assert.equal(blockedTransfer.status, 423);

  // 复核必须独立：上报人本人 / 无资质者均被拒
  assert.equal(
    (await post("/freezes/resolve", { freezeId: freezeS2, decision: "restore", reviewerId: "p4" }, { auth: AUTH.safety }))
      .status,
    403,
    "无资质不能复核"
  );
  assert.equal(
    (await post("/freezes/resolve", { freezeId: freezeS2, decision: "restore", reviewerId: "p4" }, { auth: AUTH.org }))
      .status,
    403,
    "组织者角色也不能代替安全员复核"
  );
  const restore = await post(
    "/freezes/resolve",
    { freezeId: freezeS2, decision: "restore", reviewerId: "p3", note: "血氧复测恢复，解除冻结" },
    { auth: AUTH.safety, at: "2026-09-26T11:40:00Z" }
  );
  assert.equal(restore.status, 201, "独立安全员 p3（持证、非上报人）复核恢复");

  // 恢复后普通操作继续：g2 在 s2 出库，恢复后的观察有效
  const g2out = await post(
    "/custody/checkout",
    { sampleId: "g2", userId: "p2", teamId: "t2", segmentId: "s2" },
    { at: "2026-09-26T12:02:00Z" }
  );
  assert.equal(g2out.status, 201);
  await post(
    "/observations",
    { userId: "p2", metricId: "leak", sampleId: "g2", observedAt: "2026-09-26T12:05:00Z", value: 1, point: ON_S2, clientId: "tab-d" },
    { at: "2026-09-26T12:05:00Z" }
  );

  // ---------- 6. 损坏与转交延续同一条保管链 ----------
  assert.equal(
    (await post("/custody/damage", { sampleId: "g1", userId: "p1", note: "袖口撕裂" }, { at: "2026-09-26T12:20:00Z" }))
      .status,
    201
  );
  // 转交给无资质队员被拒，保管链不跳跃
  assert.equal(
    (await post("/custody/transfer", { sampleId: "g1", fromUserId: "p1", toUserId: "p4" })).status,
    403
  );
  assert.equal(
    (await post(
      "/custody/transfer",
      { sampleId: "g1", fromUserId: "p1", toUserId: "p2", note: "换人持用" },
      { at: "2026-09-26T12:25:00Z" }
    )).status,
    201
  );
  await post(
    "/observations",
    { userId: "p2", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T12:30:00Z", value: 3, point: ON_S1, clientId: "tab-f" },
    { at: "2026-09-26T12:30:00Z" }
  );

  // ---------- 7. 人工风险→终止复核：路段永久封闭，之后数据不采纳 ----------
  const manual = await post(
    "/risk",
    {
      reporterId: "p1",
      level: 3,
      segmentId: "s1",
      sampleIds: ["g1"],
      reason: "持续降雨，林道出现滑坡迹象"
    },
    { auth: AUTH.member, at: "2026-09-26T13:00:00Z" }
  );
  assert.equal(manual.status, 201);
  assert.ok(manual.body.freeze);
  const freezeS1 = manual.body.freeze.freezeId;
  // 上报人不能自复核
  assert.equal(
    (await post(
      "/freezes/resolve",
      { freezeId: freezeS1, decision: "terminate", reviewerId: "p1" },
      { auth: AUTH.safety }
    )).status,
    403
  );
  assert.equal(
    (await post(
      "/freezes/resolve",
      { freezeId: freezeS1, decision: "terminate", reviewerId: "p3", note: "现场确认，终止 s1" },
      { auth: AUTH.safety, at: "2026-09-26T13:10:00Z" }
    )).status,
    201
  );
  // 终止后普通操作仍被抢占
  assert.equal(
    (await post("/custody/checkout", { sampleId: "g3", userId: "p1", teamId: "t1", segmentId: "s1" }))
      .status,
    423
  );
  // 终止后的观察：上传成功，但汇总阶段不采纳
  const afterTerm = await post(
    "/observations",
    { userId: "p2", metricId: "leak", sampleId: "g1", observedAt: "2026-09-26T13:30:00Z", value: 5, point: ON_S1, clientId: "tab-g" },
    { at: "2026-09-26T13:30:00Z" }
  );
  assert.equal(afterTerm.status, 201);

  // ---------- 8. 队员退出 ----------
  assert.equal((await post("/custody/exit", { userId: "p4", reason: "体力不支" })).status, 201);
  assert.equal(
    (await post("/custody/checkout", { sampleId: "g3", userId: "p4", teamId: "t1", segmentId: "s2" }))
      .status,
    409,
    "已退出队员不能再领用"
  );

  // ---------- 9. 组织者报告：完整性检查 + 冻结区间排除 ----------
  const headBeforeRestart = (await get("/health", { auth: AUTH.org })).body.headHash;
  const org = await get("/reports/organizer", { auth: AUTH.org });
  assert.equal(org.status, 200);
  const acceptedIds = new Set(org.body.observations.accepted.map((f) => f.observationId));
  const rejected = org.body.observations.rejected;
  assert.ok(!acceptedIds.has(afterTerm.body.observationId), "终止后的观察被排除");
  assert.ok(!acceptedIds.has(health.body.observationId), "健康观察落于冻结区间，被排除");
  assert.ok(rejected.some((r) => /终止|冻结/.test(r.reasons.join(" "))));
  // 去重后唯一事实：rain + leak a/b/c/d/f/g + spo2 = 8 条（tab-a 补传不产生新事实）
  assert.equal(
    org.body.observations.acceptedCount + org.body.observations.rejectedCount,
    8
  );
  assert.equal(org.body.observations.acceptedCount, 6);
  assert.equal(org.body.observations.rejectedCount, 2);
  assert.equal(org.body.integrity.headHash, headBeforeRestart);

  // ---------- 10. 品牌报告：结论可落回原始观察，且不可反查参与者 ----------
  const brand = await get("/reports/brand/Aurora", { auth: AUTH.aurora });
  assert.equal(brand.status, 200);
  const raw = JSON.stringify(brand.body);
  for (const banned of ["阿峰", "阿岚", "阿禾", "阿岩", "spo2", "health", '"p1"', '"p2"', '"p4"', "血氧"]) {
    assert.ok(!raw.includes(banned), `品牌报告不得出现：${banned}`);
  }
  const g1Conclusion = brand.body.conclusions.find((c) => c.sampleId === "g1");
  assert.equal(g1Conclusion.validObservationCount, 4, "g1 采纳冻结前 4 条（10:00/10:15/10:30/12:30）");
  const leakMetric = g1Conclusion.metrics.find((m) => m.metricId === "leak");
  assert.equal(leakMetric.count, 4);
  assert.equal(leakMetric.average, 2.5);
  assert.ok(leakMetric.evidence.includes(a1.body.observationId), "结论可落回观察编号");

  // 每条品牌证据都能在组织者侧找到原始观察，且哈希一致
  for (const ev of brand.body.evidence) {
    const source = org.body.observations.accepted.find((f) => f.observationId === ev.observationId);
    assert.ok(source, `证据 ${ev.observationId} 可回溯`);
    assert.equal(ev.sourceEventHash, source.sourceEventHash, "证据哈希可校验");
    assert.notEqual(ev.subjectPseudonym, source.userId, "主体已假名化");
  }
  // 品牌隔离：Aurora 看不到 Nimbus 样品的装备结论，反之亦然
  assert.ok(brand.body.evidence.every((e) => !e.sampleId || ["g1", "g2"].includes(e.sampleId)));
  assert.equal((await get("/reports/brand/Nimbus", { auth: AUTH.aurora })).status, 403);
  assert.equal((await get("/reports/organizer", { auth: AUTH.aurora })).status, 403);
  const nimbus = await get("/reports/brand/Nimbus", { auth: AUTH.nimbus });
  assert.ok(nimbus.body.evidence.every((e) => !["g1", "g2"].includes(e.sampleId)));

  // ---------- 11. 进程重启：CLI 起新进程重放日志，接续小队与保管链 ----------
  await new Promise((done) => server.close(done));
  const cliPort = 21080 + (process.pid % 1000);
  const child = spawn(
    process.execPath,
    [CLI, "serve", "--event-file", eventFile, "--port", String(cliPort)],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.setEncoding("utf8");
  let started = "";
  await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error("CLI 服务启动超时：" + started)), 8000);
    child.stdout.on("data", (chunk) => {
      started += chunk;
      if (started.includes("服务已启动")) {
        clearTimeout(timer);
        resolveStart();
      }
    });
    child.on("exit", (code) => rejectStart(new Error(`CLI 提前退出 ${code}: ${started}`)));
  });

  const health2 = await (await fetch(`http://127.0.0.1:${cliPort}/health`)).json();
  assert.equal(health2.headHash, headBeforeRestart, "重启后哈希链首尾一致");

  // 紧急撤离 p2：g1 现场转交 p1、g2 归还——新进程里延续同一条保管记录
  const evacRes = await fetch(`http://127.0.0.1:${cliPort}/custody/evacuate`, {
    method: "POST",
    headers: { authorization: AUTH.member, "content-type": "application/json" },
    body: JSON.stringify({
      userId: "p2",
      teamId: "t2",
      reason: "膝伤紧急撤离",
      handover: [{ sampleId: "g1", toUserId: "p1", note: "撤离现场转交" }]
    })
  });
  const evac = await evacRes.json();
  assert.equal(evacRes.status, 201);
  assert.equal(evac.type, "evacuate");

  const custodyG1 = await (
    await fetch(`http://127.0.0.1:${cliPort}/custody/g1`, {
      headers: { authorization: AUTH.org }
    })
  ).json();
  assert.deepEqual(
    custodyG1.chain.map((e) => e.eventType),
    ["check_out", "damage", "transfer", "transfer"],
    "损坏、转交、撤离交接在重启后仍是同一条保管链"
  );
  assert.equal(custodyG1.currentHolder, "p1");

  child.kill("SIGTERM");
  await once(child, "exit");

  // ---------- 12. 管理命令导出可追溯报告 ----------
  const brandOut = join(dir, "aurora-report.json");
  const cliExport = spawnSync(process.execPath, [
    CLI,
    "export",
    "--event-file",
    eventFile,
    "--report",
    "brand",
    "--brand",
    "Aurora",
    "--out",
    brandOut
  ], { encoding: "utf8" });
  assert.equal(cliExport.status, 0, cliExport.stderr);
  const exported = JSON.parse(readFileSync(brandOut, "utf8"));
  assert.equal(exported.report, "brand");
  assert.equal(
    exported.conclusions.find((c) => c.sampleId === "g1").validObservationCount,
    4,
    "导出文件与在线报告一致"
  );

  const cliCustody = spawnSync(
    process.execPath,
    [CLI, "custody", "--event-file", eventFile, "--sample", "g1"],
    { encoding: "utf8" }
  );
  assert.equal(cliCustody.status, 0);
  assert.ok(cliCustody.stdout.includes("check_out"));
  assert.match(cliCustody.stdout, /"eventType": "check_out"[\s\S]*"eventType": "transfer"/);

  // ---------- 13. 哈希链防篡改：改动一行即无法重放 ----------
  const tampered = join(dir, "tampered.jsonl");
  copyFileSync(eventFile, tampered);
  const lines = readFileSync(tampered, "utf8").split("\n");
  // 第一行是人员登记事件，改动其数据字段即破坏该行内容哈希。
  assert.ok(lines[0].includes("阿峰"), "前置条件：首行为 p1 登记事件");
  lines[0] = lines[0].replace("阿峰", "被篡改的名字");
  writeFileSync(tampered, lines.join("\n"));
  assert.throws(
    () => new FieldService(new EventStore(tampered)),
    (err) => err instanceof IntegrityError && /篡改|哈希/.test(err.message)
  );
});
