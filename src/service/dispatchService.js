/**
 * 应用服务：命令校验 → 事件落盘 → 归约。
 * 关键不变量：
 *  1. 所有写命令经同一串行队列执行，装备并发领用必然表现为"第一个成功、第二个被拒"；
 *  2. 安全冻结在普通操作之前判定，冻结面内的领用/转交/归还一律抢占拒绝；
 *  3. 健康类指标强制品牌不可见，任何写入路径都无法覆盖；
 *  4. 恢复/终止只能由独立安全员复核。
 */
import { randomUUID } from "node:crypto";
import {
  EventType, RiskLevel, assertEventId, assertEntityId, assertSampleId,
  assertMetricVisibility, MetricClass
} from "../index.js";
import { initialState, applyEvent, isChainTerminal, ChainStatus, FreezeState } from "../domain/model.js";
import {
  ValidationError, ConflictError, generatePlan, attributeSegment,
  evaluateThreshold, impactedScope, integrityCheck,
  buildOrganizationReport, buildBrandReport
} from "../domain/rules.js";

const ROLE = Object.freeze({
  ORGANIZER: "organizer",
  SAFETY: "safety",
  BRAND: "brand",
  MEMBER: "member"
});

export class DispatchService {
  /**
   * @param store EventStore
   * @param options { safetyOfficerId, thresholds?:{}, clock?:()=>ISOString }
   */
  constructor(store, options = {}) {
    this.store = store;
    this.safetyOfficerId = options.safetyOfficerId ?? "safety-officer";
    this.thresholds = options.thresholds ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.state = initialState();
    this.#tail = Promise.resolve();
  }

  #tail;

  /* ---------------- 启动与重放 ---------------- */

  async start() {
    await this.store.init();
    let seq = 0;
    for await (const event of this.store.readEvents()) {
      this.state = applyEvent(this.state, event);
      seq = event.seq;
    }
    this.#lastSeq = seq;
    return { replayed: seq };
  }

  #lastSeq = 0;

  /** 串行执行一个事务：读状态→校验→落盘→归约，期间没有别的命令交错。 */
  async #transact(fn) {
    const run = this.#tail.then(() => fn());
    // 失败也释放队列
    this.#tail = run.then(() => {}, () => {});
    return run;
  }

  async #commit(type, payload) {
    this.#lastSeq += 1;
    const event = {
      seq: this.#lastSeq,
      id: `evt:${String(this.#lastSeq).padStart(6, "0")}:${randomUUID()}`,
      type,
      occurredAt: this.clock(),
      ...payload
    };
    assertEventId(event.id);
    await this.store.append(event); // 先持久化
    this.state = applyEvent(this.state, event); // 再更新内存
    return event;
  }

  /* ---------------- 登记 ---------------- */

  registerPerson(input, actor = {}) {
    return this.#transact(() => this.#registerPerson(input, actor));
  }
  async #registerPerson(input) {
    assertEntityId(input.id, "人员编号");
    requireText(input.name, "姓名");
    if (this.state.people.has(input.id)) throw new ConflictError("人员已登记");
    const person = {
      id: input.id,
      name: input.name,
      qualifications: StringArray(input.qualifications),
      role: input.role ?? ROLE.MEMBER
    };
    await this.#commit(EventType.PERSON_REGISTERED, { person });
    return person;
  }

  registerTeam(input) {
    return this.#transact(() => this.#registerTeam(input));
  }
  async #registerTeam(input) {
    assertEntityId(input.id, "小队编号");
    requireText(input.name, "小队名称");
    if (this.state.teams.has(input.id)) throw new ConflictError("小队已登记");
    const memberIds = StringArray(input.memberIds);
    for (const pid of memberIds) {
      if (!this.state.people.has(pid)) throw new ValidationError(`队员未登记: ${pid}`);
    }
    const team = {
      id: input.id,
      name: input.name,
      capabilities: StringArray(input.capabilities),
      memberIds
    };
    await this.#commit(EventType.TEAM_REGISTERED, { team, memberIds });
    return team;
  }

  assignTeamMember(input) {
    return this.#transact(() => this.#assignTeamMember(input));
  }
  async #assignTeamMember(input) {
    assertEntityId(input.teamId, "小队编号");
    assertEntityId(input.personId, "人员编号");
    if (!this.state.teams.has(input.teamId)) throw new ValidationError("小队未登记");
    if (!this.state.people.has(input.personId)) throw new ValidationError("人员未登记");
    await this.#commit(EventType.TEAM_MEMBER_ASSIGNED, input);
    return input;
  }

  registerSegment(input) {
    return this.#transact(() => this.#registerSegment(input));
  }
  async #registerSegment(input) {
    assertEntityId(input.id, "路段编号");
    requireText(input.name, "路段名称");
    if (this.state.segments.has(input.id)) throw new ConflictError("路段已登记");
    if (typeof input.order !== "number") throw new ValidationError("路段需要顺序号 order");
    const segment = {
      id: input.id,
      name: input.name,
      order: input.order,
      terrain: input.terrain ?? null,
      elevation: input.elevation ?? null,
      hazards: StringArray(input.hazards)
    };
    await this.#commit(EventType.SEGMENT_REGISTERED, { segment });
    return segment;
  }

  registerSample(input) {
    return this.#transact(() => this.#registerSample(input));
  }
  async #registerSample(input) {
    assertSampleId(input.id);
    requireText(input.brand, "品牌");
    requireText(input.model, "型号");
    if (this.state.samples.has(input.id)) throw new ConflictError("装备编号已登记");
    const sample = {
      id: input.id,
      brand: input.brand,
      model: input.model,
      mutexGroup: input.mutexGroup ?? null,
      requirements: StringArray(input.requirements),
      capabilityNeeded: input.capabilityNeeded ?? null
    };
    await this.#commit(EventType.SAMPLE_REGISTERED, { sample });
    return sample;
  }

  registerMetric(input) {
    return this.#transact(() => this.#registerMetric(input));
  }
  async #registerMetric(input) {
    assertEntityId(input.id, "指标编号");
    requireText(input.name, "指标名称");
    const metric = {
      id: input.id,
      name: input.name,
      metricClass: input.metricClass ?? MetricClass.GEAR_EXPERIENCE,
      brandVisible: input.brandVisible !== false,
      unit: input.unit ?? null
    };
    // 健康指标强制品牌不可见（契约规则在服务层映射为 400）
    if (metric.metricClass === MetricClass.HEALTH && metric.brandVisible !== false) {
      throw new ValidationError("健康指标必须登记为品牌不可见");
    }
    assertMetricVisibility(metric);
    if (this.state.metrics.has(input.id)) throw new ConflictError("指标已登记");
    await this.#commit(EventType.METRIC_REGISTERED, { metric });
    return metric;
  }

  /* ---------------- 小队行进（离线路段归属依据） ---------------- */

  reportProgress(input) {
    return this.#transact(() => this.#reportProgress(input));
  }
  async #reportProgress(input) {
    assertEntityId(input.teamId, "小队编号");
    assertEntityId(input.segmentId, "路段编号");
    if (!this.state.teams.has(input.teamId)) throw new ValidationError("小队未登记");
    if (!this.state.segments.has(input.segmentId)) throw new ValidationError("路段未登记");
    await this.#commit(EventType.TEAM_SEGMENT_PROGRESS, {
      teamId: input.teamId,
      segmentId: input.segmentId,
      enteredAt: input.enteredAt ?? null,
      leftAt: input.leftAt ?? null,
      fromDistance: input.fromDistance ?? null,
      toDistance: input.toDistance ?? null
    });
    return input;
  }

  /* ---------------- 领用计划 ---------------- */

  generatePlan(input) {
    return this.#transact(() => this.#generatePlan(input));
  }
  async #generatePlan(input) {
    assertEntityId(input.id, "计划编号");
    if (this.state.plans.has(input.id)) throw new ConflictError("计划编号已存在");
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ValidationError("计划至少包含一件样品");
    }
    if (!Array.isArray(input.teams) || input.teams.length === 0) {
      throw new ValidationError("计划至少指定一支候选小队");
    }
    for (const t of input.teams) {
      if (!this.state.teams.has(t)) throw new ValidationError(`小队未登记: ${t}`);
    }
    const result = generatePlan(this.state, input);
    const plan = {
      id: input.id,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      segmentIds: input.segmentIds ?? null,
      assignments: result.assignments,
      conflicts: result.conflicts,
      createdAt: this.clock()
    };
    await this.#commit(EventType.PLAN_GENERATED, { plan });
    return plan;
  }

  /* ---------------- 保管链 ---------------- */

  checkOut(input) {
    return this.#transact(() => this.#checkOut(input));
  }
  async #checkOut(input) {
    assertSampleId(input.sampleId);
    assertEntityId(input.personId, "人员编号");
    const sample = this.state.samples.get(input.sampleId);
    if (!sample) throw new ValidationError("装备未登记");
    const person = this.state.people.get(input.personId);
    if (!person) throw new ValidationError("人员未登记");
    if (person.active === false) throw new ConflictError("该队员已退出，不能领用");
    const teamId = input.teamId ?? person.teamId;
    const team = this.state.teams.get(teamId);
    if (!team) throw new ValidationError("小队未登记");
    if (!team.memberIds.includes(input.personId)) {
      throw new ValidationError("领用人不在该小队");
    }
    // 资源冲突：同一样品已有保管链且未终结即被占用 —— 并发领用的第二个请求在此被拒。
    const existingChainId = this.state.chainBySample.get(input.sampleId);
    if (existingChainId) {
      const existing = this.state.chains.get(existingChainId);
      if (!isChainTerminal(existing)) {
        throw new ConflictError(
          `装备 ${input.sampleId} 已由 ${existing.holderId} 持用，并发领用被拒`,
          "sample_in_use"
        );
      }
      throw new ConflictError(`装备 ${input.sampleId} 的保管链已关闭，不能重复领用`, "chain_closed");
    }
    // 冻结抢占：受冻结的样品不能领用
    this.#assertNotFrozen({ sampleId: input.sampleId });
    // 计划核对（可选）
    if (input.planId) {
      const plan = this.state.plans.get(input.planId);
      if (!plan) throw new ValidationError("计划不存在");
      const a = plan.assignments.find((x) => x.sampleId === input.sampleId);
      if (!a || a.personId !== input.personId || a.teamId !== teamId) {
        throw new ConflictError("实际领用与计划分配不符", "plan_mismatch");
      }
    }
    const occurredAt = input.occurredAt ?? this.clock();
    const chainId = `chain:${input.sampleId}`;
    await this.#commit(EventType.CHECK_OUT, {
      chainId, sampleId: input.sampleId, teamId, personId: input.personId,
      occurredAt, note: input.note ?? null
    });
    return { chainId, sampleId: input.sampleId, holderId: input.personId, teamId, status: ChainStatus.HELD };
  }

  transfer(input) {
    return this.#transact(() => this.#custodyMove(EventType.TRANSFER, input));
  }
  reportDamage(input) {
    return this.#transact(() => this.#custodyMove(EventType.DAMAGED, input));
  }
  withdraw(input) {
    return this.#transact(() => this.#custodyMove(EventType.WITHDRAWN, input));
  }
  evacuate(input) {
    return this.#transact(() => this.#custodyMove(EventType.EVACUATED, input));
  }
  returnSample(input) {
    return this.#transact(() => this.#custodyMove(EventType.RETURN, input));
  }

  async #custodyMove(type, input) {
    const chain = this.#requireActiveChain(input);
    if (type === EventType.TRANSFER) {
      assertEntityId(input.toPersonId, "接收人编号");
      const to = this.state.people.get(input.toPersonId);
      if (!to) throw new ValidationError("接收人未登记");
      if (to.active === false) throw new ConflictError("接收人已退出");
      if (input.fromPersonId && chain.holderId !== input.fromPersonId) {
        throw new ConflictError("转交人不是当前持有人", "not_holder");
      }
      this.#assertNotFrozen({ sampleId: chain.sampleId });
      await this.#commit(type, {
        chainId: chain.id, fromPersonId: chain.holderId, toPersonId: input.toPersonId,
        occurredAt: input.occurredAt ?? this.clock(), note: input.note ?? null
      });
    } else if (type === EventType.RETURN) {
      this.#assertNotFrozen({ sampleId: chain.sampleId });
      await this.#commit(type, {
        chainId: chain.id, personId: input.personId ?? chain.holderId,
        occurredAt: input.occurredAt ?? this.clock(), note: input.note ?? null
      });
    } else {
      // DAMAGED / WITHDRAWN / EVACUATED：安全与事实优先，冻结期间也允许延续保管记录
      await this.#commit(type, {
        chainId: chain.id, personId: input.personId ?? chain.holderId,
        reason: input.reason ?? null,
        occurredAt: input.occurredAt ?? this.clock()
      });
    }
    return this.state.chains.get(chain.id);
  }

  #requireActiveChain(input) {
    const chain = input.chainId
      ? this.state.chains.get(input.chainId)
      : this.state.chains.get(this.state.chainBySample.get(input.sampleId));
    if (!chain) throw new ValidationError("该装备尚无保管链");
    if (isChainTerminal(chain)) throw new ConflictError(`保管链已终结(${chain.status})`, "chain_terminal");
    return chain;
  }

  /* ---------------- 观察上传与归并 ---------------- */

  recordObservation(input) {
    return this.#transact(() => this.#recordObservation(input));
  }
  async #recordObservation(input) {
    assertEntityId(input.personId, "人员编号");
    const person = this.state.people.get(input.personId);
    if (!person) throw new ValidationError("人员未登记");
    if (input.metricId != null) {
      assertEntityId(input.metricId, "指标编号");
      if (!this.state.metrics.has(input.metricId)) throw new ValidationError("指标未登记");
    }
    if (input.sampleId != null && !this.state.samples.has(input.sampleId)) {
      throw new ValidationError("装备未登记");
    }
    const arrivedAt = this.clock();
    const observedAt = input.observedAt ?? arrivedAt; // 离线补传时 observedAt 早于 arrivedAt
    const teamId = person.teamId;
    // 归到正确路段：用该小队的行进时间窗；离线/乱序都按事实时间归属
    const segmentId = input.segmentId ?? this.#attributeFor(teamId, { ...input, observedAt });
    if (segmentId && !this.state.segments.has(segmentId)) {
      throw new ValidationError("观察归属的路段不存在");
    }
    const dedupKey = input.clientId ?? dedupFingerprint({
      personId: input.personId, metricId: input.metricId ?? null,
      sampleId: input.sampleId ?? null, observedAt, payload: input.payload ?? null
    });
    const integrity = integrityCheck(
      { ...input, observedAt, personId: input.personId },
      { now: arrivedAt }
    );
    const wasDuplicate = this.state.observations.has(dedupKey);
    const observation = {
      id: wasDuplicate ? this.state.observations.get(dedupKey).id : `obs:${dedupKey}`,
      kind: "observation",
      dedupKey, clientId: input.clientId ?? null,
      personId: input.personId, teamId,
      sampleId: input.sampleId ?? null,
      metricId: input.metricId ?? null,
      segmentId: segmentId ?? null,
      observedAt, arrivedAt,
      payload: input.payload ?? {},
      integrity
    };
    await this.#commit(EventType.OBSERVATION, { observation });
    return {
      deduplicated: wasDuplicate,
      observationId: observation.id,
      segmentId: observation.segmentId,
      integrity: observation.integrity
    };
  }

  /** 风险信号：可能触发阈值；一旦命中，同事务内立即冻结受影响路段与样品。 */
  recordRiskSignal(input) {
    return this.#transact(() => this.#recordRiskSignal(input));
  }
  async #recordRiskSignal(input) {
    assertEntityId(input.personId, "人员编号");
    if (!this.state.people.has(input.personId)) throw new ValidationError("人员未登记");
    if (input.metricId != null && !this.state.metrics.has(input.metricId)) {
      throw new ValidationError("指标未登记");
    }
    const arrivedAt = this.clock();
    const observedAt = input.observedAt ?? arrivedAt;
    const person = this.state.people.get(input.personId);
    const segmentId = input.segmentId ?? this.#attributeFor(person.teamId, { ...input, observedAt });
    const dedupKey = input.clientId ?? dedupFingerprint({
      personId: input.personId, metricId: input.metricId ?? null,
      sampleId: input.sampleId ?? null, observedAt, payload: { level: input.level, value: input.value }
    });
    const wasDuplicate = this.state.observations.has(dedupKey);
    const signal = {
      id: wasDuplicate ? this.state.observations.get(dedupKey).id : `risk:${dedupKey}`,
      kind: "risk_signal",
      dedupKey, clientId: input.clientId ?? null,
      personId: input.personId, teamId: person.teamId,
      metricId: input.metricId ?? null, domain: input.domain ?? null,
      sampleId: input.sampleId ?? null, segmentId: segmentId ?? null,
      level: input.level ?? RiskLevel.NORMAL, value: input.value ?? null,
      note: input.note ?? null, observedAt, arrivedAt
    };
    await this.#commit(EventType.RISK_SIGNAL, { signal });

    let freeze = null;
    if (!wasDuplicate) {
      const verdict = evaluateThreshold(signal, this.thresholds);
      if (verdict.hit) freeze = await this.#raiseFreeze({
        reason: input.note ?? `阈值触发(${signal.metricId ?? signal.domain ?? "risk"}=${signal.value ?? signal.level})`,
        triggeredBy: signal.id,
        source: signal,
        target: verdict.target
      });
    }
    return { deduplicated: wasDuplicate, signalId: signal.id, segmentId: signal.segmentId, freeze };
  }

  /** 组织者/安全员也可手动冻结。 */
  freeze(input, actor = {}) {
    return this.#transact(() => this.#raiseFreeze({
      reason: input.reason,
      segmentIds: input.segmentIds ?? [],
      sampleIds: input.sampleIds ?? [],
      triggeredBy: actor.actorId ?? "manual",
      source: null,
      target: input.target ?? "stop"
    }));
  }

  async #raiseFreeze({ reason, segmentIds, sampleIds, triggeredBy, source, target }) {
    if (source) {
      const scope = impactedScope(this.state, source);
      segmentIds = scope.segmentIds;
      sampleIds = scope.sampleIds;
    }
    const freeze = {
      id: `freeze:${String(this.#lastSeq + 1).padStart(6, "0")}:${randomUUID().slice(0, 8)}`,
      reason: reason ?? "安全阈值触发",
      target,
      segmentIds: [...new Set(segmentIds ?? [])],
      sampleIds: [...new Set(sampleIds ?? [])],
      triggeredBy,
      at: this.clock()
    };
    await this.#commit(EventType.FREEZE, { freeze });
    return this.state.freezes.get(freeze.id);
  }

  /** 恢复或终止只能由独立安全员复核。 */
  reviewFreeze(input, actor = {}) {
    return this.#transact(() => this.#reviewFreeze(input, actor));
  }
  async #reviewFreeze(input, actor) {
    if (actor.role !== ROLE.SAFETY || actor.actorId !== this.safetyOfficerId) {
      throw new ConflictError("只有独立安全员可以复核冻结", "not_safety_officer");
    }
    const freeze = this.state.freezes.get(input.freezeId);
    if (!freeze) throw new ValidationError("冻结记录不存在");
    if (freeze.state !== FreezeState.FROZEN) {
      throw new ConflictError(`冻结已复核(${freeze.state})`, "freeze_reviewed");
    }
    if (!["resume", "terminate"].includes(input.decision)) {
      throw new ValidationError("复核决定必须是 resume 或 terminate");
    }
    const reviewedAt = input.reviewedAt ?? this.clock();
    await this.#commit(EventType.FREEZE_REVIEWED, {
      freezeId: freeze.id, decision: input.decision,
      reviewerId: actor.actorId, reviewerToken: actor.token ?? null,
      reviewedAt, note: input.note ?? null
    });
    return this.state.freezes.get(freeze.id);
  }

  /* ---------------- 查询与报告 ---------------- */

  getChain(sampleIdOrChainId) {
    const chain = this.state.chains.has(sampleIdOrChainId)
      ? this.state.chains.get(sampleIdOrChainId)
      : this.state.chains.get(this.state.chainBySample.get(sampleIdOrChainId));
    return chain ? structuredClone(chain) : null;
  }

  getPlan(planId) {
    const plan = this.state.plans.get(planId);
    return plan ? structuredClone(plan) : null;
  }

  organizationReport() {
    return buildOrganizationReport(this.state, { now: this.clock() });
  }

  brandReport() {
    return buildBrandReport(this.state, { now: this.clock() });
  }

  /**
   * 品牌方用报告中的 observationId 落回原始观察：
   * 只返回去身份化字段，服务端确认该事实存在且为品牌可见指标。
   */
  traceObservation(observationId) {
    const obs = this.state.obsIndex.find((o) => o.id === observationId);
    if (!obs) return null;
    const metric = this.state.metrics.get(obs.metricId);
    if (!metric || metric.brandVisible === false || metric.metricClass === MetricClass.HEALTH) {
      throw new ConflictError("该观察不对品牌开放", "observation_restricted");
    }
    return {
      observationId: obs.id,
      sampleId: obs.sampleId,
      segmentId: obs.segmentId,
      metricId: obs.metricId,
      observedAt: obs.observedAt,
      value: obs.payload?.value ?? obs.value ?? null,
      payload: scrubIdentity(obs.payload)
    };
  }

  /* ---------------- 内部工具 ---------------- */

  #attributeFor(teamId, observation) {
    if (!teamId) return null;
    const windows = [];
    for (const w of this.state.progress.values()) {
      if (w.teamId !== teamId) continue;
      windows.push({
        segmentId: w.segmentId,
        enteredAt: w.enteredAt, leftAt: w.leftAt,
        fromDistance: w.fromDistance, toDistance: w.toDistance
      });
    }
    windows.sort((a, b) => {
      const sa = this.state.segments.get(a.segmentId);
      const sb = this.state.segments.get(b.segmentId);
      return (sa?.order ?? 0) - (sb?.order ?? 0);
    });
    return attributeSegment(observation, windows);
  }

  #assertNotFrozen({ sampleId = null, segmentId = null }) {
    if (sampleId && this.state.sampleFreeze.has(sampleId)) {
      const f = this.state.freezes.get(this.state.sampleFreeze.get(sampleId));
      throw new ConflictError(`装备 ${sampleId} 处于安全冻结中，普通操作被抢占`, "frozen", f?.id);
    }
    if (segmentId && this.state.segmentFreeze.has(segmentId)) {
      const f = this.state.freezes.get(this.state.segmentFreeze.get(segmentId));
      throw new ConflictError(`路段 ${segmentId} 处于安全冻结中，普通操作被抢占`, "frozen", f?.id);
    }
  }
}

export { ROLE };

/* ---------------- 纯工具 ---------------- */

function requireText(v, label) {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${label}不能为空`);
}

function StringArray(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError("应为字符串数组");
  return [...new Set(v.map(String))];
}

/** 去重指纹：同一设备同一次观察的重复/乱序补传归并为同一事实。 */
function dedupFingerprint({ personId, metricId, sampleId, observedAt, payload }) {
  const basis = {
    p: personId, m: metricId ?? null, s: sampleId ?? null,
    t: observedAt, v: stablePayload(payload)
  };
  return hashStable(JSON.stringify(basis));
}

function stablePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const k of Object.keys(payload).sort()) out[k] = payload[k];
  return out;
}

function hashStable(str) {
  // FNV-1a，确定且零依赖；只用于去重分桶，不作安全用途
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function scrubIdentity(payload = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (/person|user|name|phone|idc|身份证/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
