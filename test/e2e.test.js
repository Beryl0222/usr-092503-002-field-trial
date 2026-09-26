/**
 * 单次自动化验证：通过真实 HTTP 接口跑完整活动，并覆盖
 *  1. 装备并发领用第二个被拒；
 *  2. 离线/乱序/重复观察归并为同一事实并归到正确路段；
 *  3. 安全阈值触发后冻结抢占普通操作，独立安全员才能恢复/终止；
 *  4. 进程关闭后用同一数据目录重启，小队流程可接续；
 *  另含：计划资源/互斥冲突、保管链延续、健康信息不进品牌口径、
 *  品牌结论可落回原始观察但不可反查身份。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { createServer } from "../src/http/server.js";

// 固定墙上时钟：晚于情景中所有事实时间，保证"冻结前/冻结后"判定与时区无关。
const FIXED_NOW = "2026-09-26T12:00:00+08:00";

async function newHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "field-trial-"));
  const app = await createApp({ dir, clock: () => FIXED_NOW });
  const server = createServer(app.service);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { dir, app, server, base };
}

async function restartHarness(h) {
  await new Promise((resolve) => h.server.close(resolve));
  const app = await createApp({ dir: h.dir, clock: () => FIXED_NOW });
  const server = createServer(app.service);
  await new Promise((resolve) => server.listen(0, resolve));
  h.base = `http://127.0.0.1:${server.address().port}`;
  h.app = app;
  h.server = server;
  return app;
}

async function api(h, method, url, body, headers = {}) {
  const res = await fetch(h.base + url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}
const post = (h, url, body, headers) => api(h, "POST", url, body, headers);
const get = (h, url) => api(h, "GET", url);

const SAFETY = { "x-actor-id": "safety-officer", "x-actor-role": "safety" };

test("端到端：并发拒领、离线去重、冻结抢占、重启接续、双口径溯源", async (t) => {
  const h = await newHarness();
  t.after(async () => {
    await new Promise((resolve) => h.server.close(resolve)).catch(() => {});
    await fs.rm(h.dir, { recursive: true, force: true });
  });

  /* ---------- 1. 出发前登记 ---------- */
  for (const p of [
    { id: "p-alice", name: "Alice", qualifications: ["high_altitude", "gear_lead"] },
    { id: "p-bob", name: "Bob", qualifications: ["high_altitude"] },
    { id: "p-carol", name: "Carol", qualifications: [] }
  ]) {
    const r = await post(h, "/register/people", p);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const rta = await post(h, "/register/teams", {
    id: "t-a", name: "甲队", capabilities: ["alpine"], memberIds: ["p-alice", "p-bob"]
  });
  assert.equal(rta.status, 201);
  assert.deepEqual(rta.body.memberIds.sort(), ["p-alice", "p-bob"]);
  assert.equal((await post(h, "/register/teams", {
    id: "t-b", name: "乙队", capabilities: ["day_hike"], memberIds: ["p-carol"]
  })).status, 201);

  for (const seg of [
    { id: "seg-a", name: "高山草甸", order: 1, terrain: "草甸", elevation: 3200 },
    { id: "seg-b", name: "碎石下坡", order: 2, terrain: "碎石下坡", elevation: 3400, hazards: ["rain"] },
    { id: "seg-c", name: "林下缓路", order: 3, terrain: "缓路", elevation: 2900 }
  ]) {
    assert.equal((await post(h, "/register/segments", seg)).status, 201);
  }
  for (const s of [
    { id: "s-tent-01", brand: "NorthX", model: "帐篷-A", mutexGroup: "shelter", requirements: ["high_altitude"], capabilityNeeded: "alpine" },
    { id: "s-tent-02", brand: "NorthX", model: "帐篷-B", mutexGroup: "shelter", requirements: ["high_altitude"], capabilityNeeded: "alpine" },
    { id: "s-shell-01", brand: "RainY", model: "外壳-C" }
  ]) {
    assert.equal((await post(h, "/register/samples", s)).status, 201);
  }
  for (const m of [
    { id: "m-waterproof", name: "防水表现", metricClass: "gear", brandVisible: true, unit: "score" },
    { id: "m-comfort", name: "佩戴舒适", metricClass: "gear", brandVisible: true, unit: "score" },
    { id: "m-spo2", name: "血氧", metricClass: "health", brandVisible: false, unit: "%" }
  ]) {
    assert.equal((await post(h, "/register/metrics", m)).status, 201);
  }
  // 健康指标不可能登记为品牌可见
  const badMetric = await post(h, "/register/metrics", {
    id: "m-hr-bad", name: "心率", metricClass: "health", brandVisible: true
  });
  assert.equal(badMetric.status, 400);

  /* ---------- 2. 计划：互斥与资源冲突在出发前可见 ---------- */
  const plan1 = await post(h, "/plans", {
    id: "plan-1",
    windowStart: "2026-09-26T08:00:00+08:00",
    windowEnd: "2026-09-26T12:00:00+08:00",
    teams: ["t-a", "t-b"],
    items: [{ sampleId: "s-tent-01" }, { sampleId: "s-tent-02" }]
  });
  assert.equal(plan1.status, 201);
  assert.equal(plan1.body.assignments.length, 1, "互斥组内只能分给同队一件");
  assert.deepEqual(
    { sampleId: plan1.body.assignments[0].sampleId, personId: plan1.body.assignments[0].personId },
    { sampleId: "s-tent-01", personId: "p-alice" }
  );
  assert.ok(plan1.body.conflicts.some((c) => String(c.reason).includes("互斥")),
    "互斥冲突必须呈现给组织者");

  const plan2 = await post(h, "/plans", {
    id: "plan-2",
    windowStart: "2026-09-26T09:00:00+08:00",
    windowEnd: "2026-09-26T10:00:00+08:00",
    teams: ["t-a"],
    items: [{ sampleId: "s-tent-01" }]
  });
  assert.ok(plan2.body.conflicts.some((c) => String(c.reason).includes("时间窗冲突")),
    "同一样品重叠时间窗必须报资源冲突");

  /* ---------- 3. 按计划领用 + 并发领用被拒 ---------- */
  const ok = await post(h, "/custody/check-out", {
    sampleId: "s-tent-01", personId: "p-alice", planId: "plan-1"
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.holderId, "p-alice");

  // 与计划不符的领用被拒
  const mismatch = await post(h, "/custody/check-out", {
    sampleId: "s-tent-01", personId: "p-bob", planId: "plan-1"
  });
  assert.equal(mismatch.status, 409);

  // 真正的并发：两个请求同一时刻发出，串行事务下必须一成一拒
  const concurrent = await Promise.all([
    post(h, "/custody/check-out", { sampleId: "s-shell-01", personId: "p-alice" }),
    post(h, "/custody/check-out", { sampleId: "s-shell-01", personId: "p-bob" })
  ]);
  const statuses = concurrent.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const rejected = concurrent.find((r) => r.status === 409);
  assert.equal(rejected.body.code, "sample_in_use");

  /* ---------- 4. 小队行进时间窗（离线归属依据） ---------- */
  await post(h, "/teams/t-a/progress", {
    segmentId: "seg-a", enteredAt: "2026-09-26T09:00:00+08:00", leftAt: "2026-09-26T10:00:00+08:00"
  });
  await post(h, "/teams/t-a/progress", {
    segmentId: "seg-b", enteredAt: "2026-09-26T10:00:00+08:00", leftAt: "2026-09-26T11:00:00+08:00"
  });

  /* ---------- 5. 离线/乱序/重复观察归并 ---------- */
  // 5a. 重复补传（同一 clientId，分片字段）→ 同一事实
  const d1 = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:20:00+08:00", clientId: "dev-bob:o-1",
    payload: { value: 9, weather: "rain" }
  });
  assert.equal(d1.status, 202);
  assert.equal(d1.body.deduplicated, false);
  assert.equal(d1.body.segmentId, "seg-a", "按行进时间窗而非上传时刻归属路段");
  const d1dup = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:20:00+08:00", clientId: "dev-bob:o-1",
    payload: { value: 9, leak: "seam" }
  });
  assert.equal(d1dup.body.deduplicated, true);
  assert.equal(d1dup.body.observationId, d1.body.observationId, "重复补传归并为同一事实");

  // 5b. 无 clientId 的重发：指纹去重
  const fp1 = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:40:00+08:00", payload: { value: 7 }
  });
  const fp2 = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:40:00+08:00", payload: { value: 7 }
  });
  assert.equal(fp2.body.deduplicated, true);
  assert.equal(fp2.body.observationId, fp1.body.observationId);

  // 5c. 乱序：先传晚的，再传早的，各自归到正确路段
  const late = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T10:40:00+08:00", payload: { value: 5 }
  });
  const early = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:55:00+08:00", payload: { value: 6 }
  });
  assert.equal(late.body.segmentId, "seg-b");
  assert.equal(early.body.segmentId, "seg-a");

  /* ---------- 6. 阈值触发 → 冻结抢占普通操作 → 独立复核 ---------- */
  // 装备失效（STOP）：样品及其互斥组备选同时冻结
  const gearRisk = await post(h, "/risk-signals", {
    personId: "p-alice", sampleId: "s-tent-01", segmentId: "seg-b",
    level: 2, note: "帐杆开裂", observedAt: "2026-09-26T10:45:00+08:00"
  });
  assert.equal(gearRisk.status, 202);
  assert.ok(gearRisk.body.freeze, "达到 STOP 必须自动冻结");
  const freeze1 = gearRisk.body.freeze;
  assert.ok(freeze1.sampleIds.includes("s-tent-01"));
  assert.ok(freeze1.sampleIds.includes("s-tent-02"), "互斥组备选一并冻结");
  assert.ok(freeze1.segmentIds.includes("seg-c"), "碎石下坡连下游路段");

  // 普通操作被抢占
  const blockedTransfer = await post(h, "/custody/transfer", {
    sampleId: "s-tent-01", toPersonId: "p-bob"
  });
  assert.equal(blockedTransfer.status, 423);
  assert.equal(blockedTransfer.body.code, "frozen");
  const blockedCheckout = await post(h, "/custody/check-out", {
    sampleId: "s-tent-02", personId: "p-alice"
  });
  assert.equal(blockedCheckout.status, 423);

  // 损坏是安全/事实记录，冻结期间仍延续同一条保管链
  const damage = await post(h, "/custody/damage", {
    sampleId: "s-tent-01", personId: "p-alice", reason: "帐杆开裂"
  });
  assert.equal(damage.status, 200);
  assert.equal(damage.body.id, "chain:s-tent-01");

  // 非安全员不能复核
  const rogueReview = await post(h, `/freezes/${freeze1.id}/review`,
    { decision: "resume" }, { "x-actor-id": "p-alice", "x-actor-role": "member" });
  assert.notEqual(rogueReview.status, 200);
  assert.equal(rogueReview.body.code, "not_safety_officer");

  // 独立安全员恢复
  const resume = await post(h, `/freezes/${freeze1.id}/review`,
    { decision: "resume", note: "更换帐杆后恢复" }, SAFETY);
  assert.equal(resume.status, 200);
  assert.equal(resume.body.state, "resumed");

  // 恢复后普通操作放行，仍是同一条保管链
  const transfer = await post(h, "/custody/transfer", {
    sampleId: "s-tent-01", fromPersonId: "p-alice", toPersonId: "p-bob"
  });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.holderId, "p-bob");
  const kinds = transfer.body.custody.map((c) => c.kind);
  assert.deepEqual(kinds, ["check_out", "damaged", "transfer"], "损坏与转交延续同一保管记录");

  // 撤离与退出同样落在各自唯一的保管链上
  const evac = await post(h, "/custody/evacuate", {
    sampleId: "s-shell-01", personId: "p-alice", reason: "队员轻微高反紧急撤离"
  });
  assert.equal(evac.status, 200);
  assert.equal(evac.body.id, "chain:s-shell-01");
  assert.equal(evac.body.custody[0].kind, "check_out");
  const tent2 = await post(h, "/custody/check-out", { sampleId: "s-tent-02", personId: "p-alice" });
  assert.equal(tent2.status, 201);
  const withdraw = await post(h, "/custody/withdraw", {
    sampleId: "s-tent-02", personId: "p-alice", reason: "队员退出"
  });
  assert.equal(withdraw.body.id, tent2.body.chainId);

  /* ---------- 7. 健康阈值（血氧）→ 终止，之后数据排除 ---------- */
  const healthRisk = await post(h, "/risk-signals", {
    personId: "p-bob", metricId: "m-spo2", segmentId: "seg-b",
    value: 79, observedAt: "2026-09-26T10:50:00+08:00"
  });
  assert.equal(healthRisk.status, 202);
  assert.equal(healthRisk.body.freeze.target, "evacuate");
  const terminate = await post(h, `/freezes/${healthRisk.body.freeze.id}/review`,
    { decision: "terminate", note: "天气与海拔风险，终止该路段" }, SAFETY);
  assert.equal(terminate.body.state, "terminated");

  // 终止后该路段的观察不被汇总采纳
  await post(h, "/observations", {
    personId: "p-bob", metricId: "m-waterproof", sampleId: "s-tent-01",
    segmentId: "seg-b", payload: { value: 1 }
  });
  // 通不过完整性检查的观察也不采纳
  await post(h, "/observations", { personId: "p-bob", payload: { note: "缺指标缺时间" } });

  /* ---------- 8. 双口径报告 ---------- */
  const org = (await get(h, "/reports/organization")).body;
  const orgTent1 = org.samples.find((s) => s.sampleId === "s-tent-01");
  assert.equal(orgTent1.metrics["m-waterproof"].observationCount, 4,
    "冻结前 4 条有效事实（9/7/6/5），终止后与缺字段记录排除");
  assert.equal(orgTent1.metrics["m-waterproof"].average, 6.75);
  assert.equal(org.health.restricted, true);
  assert.ok(org.health.count >= 1, "组织口径可见健康信号");
  assert.ok(org.health.rows.some((r) => r.personId === "p-bob"));

  const brand = (await get(h, "/reports/brand")).body;
  const brandText = JSON.stringify(brand);
  assert.ok(!brandText.includes("p-bob") && !brandText.includes("p-alice"),
    "品牌结果不得含参与者身份");
  assert.ok(!brandText.includes("spo2") && !brandText.includes("m-spo2"),
    "健康信息不得进入品牌口径");
  const brandTent1 = brand.samples.find((s) => s.sampleId === "s-tent-01");
  assert.equal(brandTent1.metrics["m-waterproof"].observationCount, 4);
  assert.equal(brandTent1.holderId, undefined, "品牌口径无持有人");

  // 品牌结论可落回原始观察
  const refId = brandTent1.metrics["m-waterproof"].observations[0].observationId;
  const traced = await get(h, `/trace/${refId}`);
  assert.equal(traced.status, 200);
  assert.equal(traced.body.observationId, refId);
  assert.equal(traced.body.personId, undefined, "溯源回包里不能反查到人");
  assert.equal(traced.body.sampleId, "s-tent-01");

  // 健康观察对品牌溯源关闭
  const healthObsId = org.health.rows.find((r) => r.metricId === "m-spo2").observationId;
  const traceDenied = await get(h, `/trace/${healthObsId}`);
  assert.equal(traceDenied.status, 409);
  assert.equal(traceDenied.body.code, "observation_restricted");

  /* ---------- 9. 进程重启：同目录重放，接续小队流程 ---------- */
  const replayed = await restartHarness(h);
  assert.ok(replayed.replayed > 0, "重启后重放既有事件");
  const chainAfter = (await get(h, "/custody/s-tent-01")).body;
  assert.equal(chainAfter.holderId, "p-bob", "重启后保管链接续");
  assert.equal(chainAfter.custody.length, 3);
  const planAfter = (await get(h, "/plans/plan-1")).body;
  assert.equal(planAfter.assignments[0].personId, "p-alice", "重启后计划仍可查");

  // 接续：恢复后小队继续补一条装备体验
  const more = await post(h, "/observations", {
    personId: "p-bob", metricId: "m-comfort", sampleId: "s-tent-01",
    observedAt: "2026-09-26T09:10:00+08:00", payload: { value: 8 }
  });
  assert.equal(more.status, 202);
  const org2 = (await get(h, "/reports/organization")).body;
  const t1b = org2.samples.find((s) => s.sampleId === "s-tent-01");
  assert.equal(t1b.metrics["m-comfort"].observationCount, 1);

  /* ---------- 10. 管理命令导出（独立进程读同一日志） ---------- */
  const orgFile = path.join(h.dir, "org-report.json");
  const brandFile = path.join(h.dir, "brand-report.json");
  await runCli(["export-report", "--dir", h.dir, "--view", "organization", "--out", orgFile]);
  await runCli(["export-report", "--dir", h.dir, "--view", "brand", "--out", brandFile]);
  const exportedBrand = JSON.parse(await fs.readFile(brandFile, "utf8"));
  const exportedOrg = JSON.parse(await fs.readFile(orgFile, "utf8"));
  assert.ok(!JSON.stringify(exportedBrand).includes("p-bob"));
  assert.equal(exportedOrg.health.restricted, true);
  const replayInfo = JSON.parse(await runCli(["replay-info", "--dir", h.dir]));
  assert.ok(replayInfo.replayed > 0);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], { cwd: process.cwd() });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`))));
  });
}
