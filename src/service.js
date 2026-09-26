import { EventType, RiskLevel, ObservationKind, FreezeDecision, assertCode } from "./index.js";
import { replay, findBlockingFreeze } from "./projection.js";
import { attributeSegment } from "./geo.js";
import { canonicalize, sha256Hex, hmacHex, shortId } from "./crypto-util.js";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  FrozenError,
  AuthorizationError
} from "./errors.js";

/** 安全员所需资质；有此资质且与上报人不同者才能复核冻结。 */
export const SAFETY_QUALIFICATION = "safety_officer";

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === "") {
      throw new ValidationError(`缺少必填字段：${f}`);
    }
  }
}

/**
 * 领域服务：所有写命令都在事件存储的串行临界区内执行，
 * “检查状态 → 判定冲突/冻结 → 追加事件”原子完成，
 * 因此并发领用同一装备时只有一条成功，其余得到 409/423。
 */
export class FieldService {
  constructor(store, { pseudonymSecret = "field-trial-secret" } = {}) {
    this.store = store;
    this.secret = pseudonymSecret;
    this.store.load();
  }

  /** 每次取状态都从事件日志重放，保证与落盘内容一致；重启后天然接续。 */
  state() {
    return replay(this.store.events);
  }

  async _exclusive(fn) {
    return this.store.runExclusive((writer) => fn(replay(this.store.events), writer));
  }

  _append(writer, type, data, cmdId, timestamp = new Date().toISOString()) {
    return writer.append(type, data, { cmdId: cmdId ?? null, timestamp }).event;
  }

  /** 命令幂等：同一 cmdId 重放返回首次事件，不重复执行业务。 */
  _replayed(cmdId) {
    if (!cmdId) return null;
    return this.store.events.find((e) => e.cmdId === cmdId) ?? null;
  }

  // ---------- 登记 ----------

  async registerPerson(input, meta = {}) {
    requireFields(input, ["id", "name"]);
    assertCode(input.id, "人员编号");
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      if (state.people.has(input.id)) throw new ConflictError(`人员已登记：${input.id}`);
      const data = {
        id: input.id,
        name: input.name,
        organization: input.organization ?? null,
        qualifications: [...new Set(input.qualifications ?? [])]
      };
      return this._append(w, EventType.PERSON_REGISTERED, data, meta.cmdId, meta.timestamp);
    });
  }

  async registerTeam(input, meta = {}) {
    requireFields(input, ["id", "name", "memberIds"]);
    assertCode(input.id, "小队编号");
    if (!Array.isArray(input.memberIds) || input.memberIds.length === 0) {
      throw new ValidationError("小队至少需要一名成员");
    }
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      if (state.teams.has(input.id)) throw new ConflictError(`小队已登记：${input.id}`);
      for (const mid of input.memberIds) {
        if (!state.people.has(mid)) throw new ValidationError(`成员未登记：${mid}`);
      }
      const memberIds = [...new Set(input.memberIds)];
      const data = {
        id: input.id,
        name: input.name,
        memberIds,
        qualifications: [...new Set(input.qualifications ?? [])],
        capacity: input.capacity ?? memberIds.length
      };
      return this._append(w, EventType.TEAM_REGISTERED, data, meta.cmdId, meta.timestamp);
    });
  }

  async registerSegment(input, meta = {}) {
    requireFields(input, ["id", "name", "order"]);
    assertCode(input.id, "路段编号");
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      if (state.segments.has(input.id)) throw new ConflictError(`路段已登记：${input.id}`);
      for (const seg of state.segments.values()) {
        if (seg.order === input.order) throw new ConflictError(`路段顺序冲突：${input.order}`);
      }
      const data = {
        id: input.id,
        name: input.name,
        order: input.order,
        start: input.start ?? null,
        end: input.end ?? null,
        elevationGainM: input.elevationGainM ?? 0,
        terrain: input.terrain ?? []
      };
      return this._append(w, EventType.SEGMENT_REGISTERED, data, meta.cmdId, meta.timestamp);
    });
  }

  async registerSample(input, meta = {}) {
    requireFields(input, ["id", "brand", "item"]);
    assertCode(input.id, "装备编号");
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      if (state.samples.has(input.id)) throw new ConflictError(`装备已登记：${input.id}`);
      const data = {
        id: input.id,
        brand: input.brand,
        item: input.item,
        mutexGroup: input.mutexGroup ?? null,
        requiredQualification: input.requiredQualification ?? null
      };
      return this._append(w, EventType.SAMPLE_REGISTERED, data, meta.cmdId, meta.timestamp);
    });
  }

  /**
   * @param {string} input.kind location|environment|gear|health
   * health 类指标强制 brandVisible=false，品牌侧永远看不到。
   * @param {Array}  input.thresholds [{level:2, op:">=", value:90}]
   */
  async registerMetric(input, meta = {}) {
    requireFields(input, ["id", "name", "kind"]);
    assertCode(input.id, "指标编号");
    if (!Object.values(ObservationKind).includes(input.kind)) {
      throw new ValidationError(`未知观察类别：${input.kind}`);
    }
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      if (state.metrics.has(input.id)) throw new ConflictError(`指标已登记：${input.id}`);
      for (const rule of input.thresholds ?? []) {
        if (![">=", "<="].includes(rule.op) || typeof rule.value !== "number") {
          throw new ValidationError("阈值规则需要 op（>= 或 <=）与数值 value");
        }
        if (![RiskLevel.WATCH, RiskLevel.STOP, RiskLevel.EVACUATE].includes(rule.level)) {
          throw new ValidationError("阈值等级只能是 WATCH/STOP/EVACUATE");
        }
      }
      const data = {
        id: input.id,
        name: input.name,
        kind: input.kind,
        unit: input.unit ?? null,
        brandVisible: input.kind === ObservationKind.HEALTH ? false : input.brandVisible !== false,
        thresholds: input.thresholds ?? []
      };
      return this._append(w, EventType.METRIC_REGISTERED, data, meta.cmdId, meta.timestamp);
    });
  }

  // ---------- 领用计划 ----------

  /**
   * 按小队能力与样品互斥规则生成领用计划：
   * - 样品有 requiredQualification 时，只能分给具备该资质的小队，持有人也须持证；
   * - 同一 mutexGroup 的两件样品不能进入同一小队；
   * - 小队同时持有量不超过 capacity；
   * - 同一成员出现在两支小队（资源冲突）在出发前即可见。
   */
  generatePlan(state) {
    const teams = [...state.teams.values()];
    const load = new Map(teams.map((t) => [t.id, 0]));
    const groupByTeam = new Map(teams.map((t) => [t.id, new Set()]));
    const entries = [];
    const conflicts = [];

    const seenMembers = new Map();
    for (const t of teams) {
      for (const m of t.memberIds) {
        if (seenMembers.has(m)) {
          conflicts.push({
            type: "member_double_booked",
            personId: m,
            teams: [seenMembers.get(m), t.id]
          });
        } else seenMembers.set(m, t.id);
      }
    }

    const segmentIds = [...state.segments.values()]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id);

    // 有资质要求的样品更难安排，优先排入。
    const samples = [...state.samples.values()].sort(
      (a, b) => Number(Boolean(b.requiredQualification)) - Number(Boolean(a.requiredQualification))
    );

    for (const sample of samples) {
      let placed = false;
      for (const team of teams) {
        if ((load.get(team.id) ?? 0) >= team.capacity) continue;
        if (sample.mutexGroup && groupByTeam.get(team.id).has(sample.mutexGroup)) continue;
        if (
          sample.requiredQualification &&
          !team.qualifications.has(sample.requiredQualification)
        ) {
          continue;
        }
        const holder = [...team.memberIds].find((m) => {
          const person = state.people.get(m);
          return (
            person?.active &&
            (!sample.requiredQualification || person.qualifications.has(sample.requiredQualification))
          );
        });
        if (!holder) continue;
        entries.push({ sampleId: sample.id, teamId: team.id, userId: holder, segmentIds });
        load.set(team.id, (load.get(team.id) ?? 0) + 1);
        if (sample.mutexGroup) groupByTeam.get(team.id).add(sample.mutexGroup);
        placed = true;
        break;
      }
      if (!placed) {
        conflicts.push({
          type: "sample_unassignable",
          sampleId: sample.id,
          reason: sample.requiredQualification
            ? `没有小队同时具备资质 ${sample.requiredQualification} 且有余量`
            : "所有小队容量或互斥规则均不满足"
        });
      }
    }
    return { entries, conflicts };
  }

  async plan(meta = {}) {
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) {
        return {
          event: prior,
          planId: prior.data.planId,
          entries: prior.data.entries,
          conflicts: prior.data.conflicts
        };
      }
      const { entries, conflicts } = this.generatePlan(state);
      const planId = shortId("plan", canonicalize({ entries, conflicts }));
      const event = this._append(
        w,
        EventType.PLAN_GENERATED,
        { planId, entries, conflicts },
        meta.cmdId,
        meta.timestamp
      );
      return { event, planId, entries, conflicts };
    });
  }

  // ---------- 保管链 ----------

  _planEntryFor(state, sampleId, userId, teamId, segmentId) {
    if (!state.plan) return null;
    return (
      state.plan.entries.find(
        (e) =>
          e.sampleId === sampleId &&
          e.userId === userId &&
          e.teamId === teamId &&
          (!segmentId || e.segmentIds.includes(segmentId))
      ) ?? null
    );
  }

  async checkOut(input, meta = {}) {
    requireFields(input, ["sampleId", "userId", "teamId"]);
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      const sample = state.samples.get(input.sampleId);
      if (!sample) throw new NotFoundError(`装备不存在：${input.sampleId}`);
      const person = state.people.get(input.userId);
      if (!person) throw new NotFoundError(`人员不存在：${input.userId}`);
      if (!state.teams.has(input.teamId)) throw new NotFoundError(`小队不存在：${input.teamId}`);
      // 安全冻结抢占一切普通操作，优先于其余业务校验。
      const blockedByFreeze = findBlockingFreeze(state, {
        segmentId: input.segmentId,
        sampleId: sample.id
      });
      if (blockedByFreeze) {
        throw new FrozenError(`安全冻结 ${blockedByFreeze.freezeId} 生效中，领用被抢占`);
      }
      if (!person.active) throw new ConflictError(`人员已退出或撤离，不能领用：${input.userId}`);
      if (sample.damaged) throw new ConflictError("损坏装备不能领用");
      if (sample.status === "checked_out") {
        // 并发领用：同一时刻只有一个持有人，第二个请求在此被拒。
        throw new ConflictError(
          `装备 ${input.sampleId} 已由 ${sample.currentHolder} 领用，并发领用被拒`
        );
      }
      if (sample.requiredQualification && !person.qualifications.has(sample.requiredQualification)) {
        throw new AuthorizationError(`人员 ${input.userId} 缺少资质 ${sample.requiredQualification}`);
      }
      if (!this._planEntryFor(state, sample.id, input.userId, input.teamId, input.segmentId)) {
        throw new ConflictError("领用不在生效计划内，拒绝出库");
      }

      return this._append(
        w,
        EventType.CHECK_OUT,
        {
          sampleId: sample.id,
          userId: input.userId,
          teamId: input.teamId,
          segmentId: input.segmentId ?? null,
          note: input.note ?? null
        },
        meta.cmdId,
        meta.timestamp
      );
    });
  }

  async transfer(input, meta = {}) {
    requireFields(input, ["sampleId", "fromUserId", "toUserId"]);
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      const sample = state.samples.get(input.sampleId);
      if (!sample) throw new NotFoundError(`装备不存在：${input.sampleId}`);
      if (sample.currentHolder !== input.fromUserId) {
        throw new ConflictError("转交人不是当前持有人，保管链不能跳跃");
      }
      const to = state.people.get(input.toUserId);
      if (!to) throw new NotFoundError(`接手人不存在：${input.toUserId}`);
      const blockedByFreeze = findBlockingFreeze(state, { segmentId: input.segmentId, sampleId: sample.id });
      if (blockedByFreeze) {
        throw new FrozenError(`安全冻结 ${blockedByFreeze.freezeId} 生效中，装备不得转交`);
      }
      if (!to.active) throw new ConflictError("接手人已退出或撤离");
      if (sample.requiredQualification && !to.qualifications.has(sample.requiredQualification)) {
        throw new AuthorizationError(`接手人缺少资质 ${sample.requiredQualification}`);
      }
      return this._append(
        w,
        EventType.TRANSFER,
        {
          sampleId: sample.id,
          fromUserId: input.fromUserId,
          userId: input.toUserId,
          teamId: input.teamId ?? sample.currentTeamId,
          segmentId: input.segmentId ?? null,
          note: input.note ?? null
        },
        meta.cmdId,
        meta.timestamp
      );
    });
  }

  async reportDamage(input, meta = {}) {
    requireFields(input, ["sampleId", "userId"]);
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      const sample = state.samples.get(input.sampleId);
      if (!sample) throw new NotFoundError(`装备不存在：${input.sampleId}`);
      return this._append(
        w,
        EventType.DAMAGE,
        {
          sampleId: sample.id,
          userId: input.userId,
          teamId: sample.currentTeamId,
          segmentId: input.segmentId ?? null,
          note: input.note ?? null
        },
        meta.cmdId,
        meta.timestamp
      );
    });
  }

  async returnSample(input, meta = {}) {
    requireFields(input, ["sampleId", "userId"]);
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      const sample = state.samples.get(input.sampleId);
      if (!sample) throw new NotFoundError(`装备不存在：${input.sampleId}`);
      if (sample.status !== "checked_out") {
        throw new ConflictError("装备不在领用状态，无法归还");
      }
      return this._append(
        w,
        EventType.RETURN,
        {
          sampleId: sample.id,
          userId: input.userId,
          fromUserId: sample.currentHolder,
          teamId: sample.currentTeamId,
          segmentId: input.segmentId ?? null,
          note: input.note ?? null
        },
        meta.cmdId,
        meta.timestamp
      );
    });
  }

  /** 退出或撤离：持有中的装备逐条转交或归还，全部延续在同一条保管链上，再落人员事件。 */
  async _leave(kind, input, meta) {
    const eventType = kind === "evacuate" ? EventType.EVACUATE : EventType.EXIT;
    return this._exclusive((state, w) => {
      const priorEvent = meta.cmdId
        ? this.store.events.find((e) => e.type === eventType && e.cmdId === meta.cmdId)
        : null;
      if (priorEvent) return priorEvent;
      const person = state.people.get(input.userId);
      if (!person) throw new NotFoundError(`人员不存在：${input.userId}`);
      if (!person.active) throw new ConflictError("人员已退出或撤离");
      const ts = meta.timestamp ?? new Date().toISOString();

      for (const sample of [...state.samples.values()].filter(
        (s) => s.currentHolder === input.userId
      )) {
        const handover = (input.handover ?? []).find((h) => h.sampleId === sample.id);
        if (handover?.toUserId) {
          const to = state.people.get(handover.toUserId);
          if (!to || !to.active) throw new ConflictError(`接手人无效：${handover.toUserId}`);
          if (sample.requiredQualification && !to.qualifications.has(sample.requiredQualification)) {
            throw new AuthorizationError(`接手人缺少资质 ${sample.requiredQualification}`);
          }
          this._append(
            w,
            EventType.TRANSFER,
            {
              sampleId: sample.id,
              fromUserId: input.userId,
              userId: handover.toUserId,
              teamId: sample.currentTeamId,
              segmentId: handover.segmentId ?? null,
              note: handover.note ?? (kind === "evacuate" ? "撤离前转交" : "退出前转交")
            },
            null,
            ts
          );
        } else {
          this._append(
            w,
            EventType.RETURN,
            {
              sampleId: sample.id,
              userId: input.userId,
              fromUserId: input.userId,
              teamId: sample.currentTeamId,
              segmentId: handover?.segmentId ?? null,
              note: kind === "evacuate" ? "紧急撤离时归还" : "退出时归还"
            },
            null,
            ts
          );
        }
      }
      return this._append(
        w,
        eventType,
        {
          userId: input.userId,
          teamId: input.teamId ?? null,
          reason: input.reason ?? null
        },
        meta.cmdId,
        ts
      );
    });
  }

  exitParticipant(input, meta = {}) {
    return this._leave("exit", input, meta);
  }

  evacuate(input, meta = {}) {
    return this._leave("evacuate", input, meta);
  }

  // ---------- 观察上传：乱序归并、去重、路段归因、阈值冻结 ----------

  /**
   * 上传一条观察。clientId 是设备端离线生成的编号，重传/多端补传保持不变；
   * 未带 clientId 时按“人+指标+样品+观测时刻+值”派生内容键。
   * 乱序到达都归并到同一事实，重复上传只追加 duplicate 记录，不产生新事实。
   */
  async submitObservation(input, meta = {}) {
    requireFields(input, ["userId", "metricId", "observedAt"]);
    if (typeof input.value !== "number") throw new ValidationError("观察值 value 必须是数字");
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior && prior.type === EventType.OBSERVATION) {
        // 同一命令重传：无论首次是事实还是重复归并，都原样返回，不再落事件。
        return prior.data.duplicateOf
          ? { duplicated: true, observationId: prior.data.duplicateOf, event: prior }
          : { duplicated: false, observationId: prior.data.observationId, event: prior };
      }
      const person = state.people.get(input.userId);
      if (!person) throw new NotFoundError(`人员不存在：${input.userId}`);
      const metric = state.metrics.get(input.metricId);
      if (!metric) throw new NotFoundError(`指标不存在：${input.metricId}`);
      if (input.sampleId && !state.samples.has(input.sampleId)) {
        throw new NotFoundError(`装备不存在：${input.sampleId}`);
      }

      const dedupeSource = input.clientId
        ? `client:${input.clientId}`
        : canonicalize([input.userId, input.metricId, input.sampleId ?? null, input.observedAt, input.value]);
      const dedupeKey = sha256Hex(dedupeSource);
      const existingId = state.factByKey.get(dedupeKey);
      const ts = meta.timestamp ?? new Date().toISOString();
      if (existingId) {
        // 重复/离线补传：归并到既有事实，只登记本次上传的客户端编号。
        const event = this._append(
          w,
          EventType.OBSERVATION,
          { duplicateOf: existingId, clientId: input.clientId ?? null, userId: input.userId },
          meta.cmdId ?? null,
          ts
        );
        return { duplicated: true, observationId: existingId, event };
      }

      // 路段归因只依赖预先登记的路线几何，与上传先后无关。
      const { segmentId, outsideCorridor } = attributeSegment(input.point, [
        ...state.segments.values()
      ]);

      const seq = state.sequences.observation + 1;
      const observationId = `obs-${String(seq).padStart(5, "0")}-${sha256Hex(dedupeKey).slice(0, 8)}`;
      const fact = {
        observationId,
        dedupeKey,
        clientId: input.clientId ?? null,
        userId: input.userId,
        teamId: input.teamId ?? personTeam(state, input.userId),
        metricId: input.metricId,
        kind: metric.kind,
        sampleId: input.sampleId ?? null,
        segmentId,
        point: input.point ?? null,
        outsideCorridor,
        value: input.value,
        unit: metric.unit,
        observedAt: input.observedAt
      };
      const event = this._append(w, EventType.OBSERVATION, fact, meta.cmdId ?? null, ts);

      // 阈值判定：命中 STOP/EVACUATE 即冻结受影响路段与该小队持有的样品。
      const triggered = evaluateThreshold(metric, input.value);
      let freeze = null;
      if (triggered.level >= RiskLevel.STOP) {
        const fresh = replay(this.store.events);
        const already = findBlockingFreeze(fresh, { segmentId: fact.segmentId, sampleId: fact.sampleId });
        if (!already) {
          const affectedSampleIds = [
            ...new Set([
              ...(fact.sampleId ? [fact.sampleId] : []),
              ...[...fresh.samples.values()]
                .filter((s) => s.currentTeamId === fact.teamId)
                .map((s) => s.id)
            ])
          ];
          const riskEvent = this._append(
            w,
            EventType.RISK_SIGNAL,
            {
              riskId: shortId("risk", observationId),
              level: triggered.level,
              metricId: metric.id,
              observationId,
              segmentId: fact.segmentId,
              sampleIds: affectedSampleIds,
              value: input.value,
              reporterId: input.userId,
              reason: triggered.message ?? `指标 ${metric.id} 触发 ${triggered.level} 级阈值`
            },
            null,
            ts
          );
          const freezeEvent = this._append(
            w,
            EventType.FREEZE_IMPOSED,
            {
              freezeId: shortId("frz", observationId),
              level: triggered.level,
              scope: fact.segmentId ? "segment_and_samples" : "samples",
              segmentId: fact.segmentId,
              sampleIds: affectedSampleIds,
              reason: riskEvent.data.reason,
              riskEventId: riskEvent.data.riskId,
              reporterId: input.userId
            },
            null,
            ts
          );
          freeze = freezeEvent.data;
        }
      }
      return { duplicated: false, observationId, event, fact, freeze };
    });
  }

  // ---------- 人工风险上报与独立复核 ----------

  async reportRisk(input, meta = {}) {
    requireFields(input, ["reporterId", "level", "reason"]);
    return this._exclusive((state, w) => {
      const prior = meta.cmdId
        ? this.store.events.find((e) => e.type === EventType.RISK_SIGNAL && e.cmdId === meta.cmdId)
        : null;
      if (prior) return { riskId: prior.data.riskId, freeze: null, replayed: true };
      if (!state.people.has(input.reporterId)) throw new NotFoundError("上报人不存在");
      if (![RiskLevel.WATCH, RiskLevel.STOP, RiskLevel.EVACUATE].includes(input.level)) {
        throw new ValidationError("风险等级非法");
      }
      const ts = meta.timestamp ?? new Date().toISOString();
      const riskId = shortId(
        "risk",
        [input.reporterId, input.segmentId ?? "", input.reason, ts].join("|")
      );
      this._append(
        w,
        EventType.RISK_SIGNAL,
        {
          riskId,
          level: input.level,
          metricId: input.metricId ?? null,
          observationId: input.observationId ?? null,
          segmentId: input.segmentId ?? null,
          sampleIds: input.sampleIds ?? [],
          value: input.value ?? null,
          reporterId: input.reporterId,
          reason: input.reason
        },
        meta.cmdId ?? null,
        ts
      );
      let freeze = null;
      if (input.level >= RiskLevel.STOP) {
        const fresh = replay(this.store.events);
        const already = findBlockingFreeze(fresh, {
          segmentId: input.segmentId,
          sampleId: (input.sampleIds ?? [])[0]
        });
        if (!already) {
          const event = this._append(
            w,
            EventType.FREEZE_IMPOSED,
            {
              freezeId: shortId("frz", riskId),
              level: input.level,
              scope: input.segmentId ? "segment_and_samples" : "samples",
              segmentId: input.segmentId ?? null,
              sampleIds: input.sampleIds ?? [],
              reason: input.reason,
              riskEventId: riskId,
              reporterId: input.reporterId
            },
            null,
            ts
          );
          freeze = event.data;
        }
      }
      return { riskId, freeze };
    });
  }

  /** 恢复或终止只能由独立安全员复核：持证，且不是冻结上报人本人。 */
  async resolveFreeze(input, meta = {}) {
    requireFields(input, ["freezeId", "decision", "reviewerId"]);
    if (![FreezeDecision.RESTORE, FreezeDecision.TERMINATE].includes(input.decision)) {
      throw new ValidationError("复核结论只能是 restore 或 terminate");
    }
    return this._exclusive((state, w) => {
      const prior = this._replayed(meta.cmdId);
      if (prior) return prior;
      const freeze = state.freezes.get(input.freezeId);
      if (!freeze) throw new NotFoundError(`冻结不存在：${input.freezeId}`);
      if (freeze.status !== "active") throw new ConflictError(`冻结 ${input.freezeId} 已复核`);
      const reviewer = state.people.get(input.reviewerId);
      if (!reviewer) throw new NotFoundError("复核人不存在");
      if (!reviewer.qualifications.has(SAFETY_QUALIFICATION)) {
        throw new AuthorizationError("复核人不具备安全员资质");
      }
      if (reviewer.id === freeze.reporterId) {
        throw new AuthorizationError("安全员不能复核自己上报的冻结，必须独立复核");
      }
      return this._append(
        w,
        EventType.FREEZE_RESOLVED,
        {
          freezeId: freeze.freezeId,
          decision: input.decision,
          reviewerId: input.reviewerId,
          note: input.note ?? null
        },
        meta.cmdId,
        meta.timestamp
      );
    });
  }

  // ---------- 查询 ----------

  custodyOf(sampleId) {
    const state = this.state();
    const sample = state.samples.get(sampleId);
    if (!sample) throw new NotFoundError(`装备不存在：${sampleId}`);
    return {
      sampleId: sample.id,
      brand: sample.brand,
      item: sample.item,
      status: sample.status,
      damaged: sample.damaged,
      currentHolder: sample.currentHolder,
      currentTeamId: sample.currentTeamId,
      chain: sample.custody
    };
  }

  pseudonym(kind, id) {
    return hmacHex(this.secret, `${kind}:${id}`).slice(0, 16);
  }
}

function personTeam(state, userId) {
  for (const t of state.teams.values()) if (t.memberIds.has(userId)) return t.id;
  return null;
}

function evaluateThreshold(metric, value) {
  let best = null;
  for (const rule of metric.thresholds ?? []) {
    const hit = rule.op === ">=" ? value >= rule.value : value <= rule.value;
    if (hit && (!best || rule.level > best.level)) {
      best = { level: rule.level, message: `${metric.name} ${rule.op} ${rule.value}（实测 ${value}）` };
    }
  }
  return best ?? { level: RiskLevel.NORMAL };
}
