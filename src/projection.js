import { EventType } from "./index.js";

/**
 * 纯函数投影：把事件日志折叠成当前状态。
 * 进程重启后对全部历史事件重放一次，即可接续活动，不依赖任何外部数据库。
 */
export function createState() {
  return {
    people: new Map(),
    teams: new Map(),
    segments: new Map(),
    samples: new Map(),
    metrics: new Map(),
    plan: null,
    facts: new Map(), // observationId -> 归并后的事实
    factByKey: new Map(), // 幂等键 -> observationId
    freezes: new Map(), // freezeId -> 冻结记录
    riskSignals: [],
    reviews: [],
    sequences: { observation: 0 }
  };
}

export function applyEvent(state, event) {
  const { type, data, timestamp, seq, hash } = event;
  switch (type) {
    case EventType.PERSON_REGISTERED:
      state.people.set(data.id, {
        id: data.id,
        name: data.name,
        organization: data.organization,
        qualifications: new Set(data.qualifications ?? []),
        active: true,
        registeredAt: timestamp
      });
      break;

    case EventType.TEAM_REGISTERED:
      state.teams.set(data.id, {
        id: data.id,
        name: data.name,
        qualifications: new Set(data.qualifications ?? []),
        capacity: data.capacity ?? 2,
        memberIds: new Set(data.memberIds ?? []),
        registeredAt: timestamp
      });
      break;

    case EventType.SEGMENT_REGISTERED:
      state.segments.set(data.id, {
        id: data.id,
        name: data.name,
        order: data.order,
        start: data.start ?? null,
        end: data.end ?? null,
        elevationGainM: data.elevationGainM ?? 0,
        terrain: data.terrain ?? [],
        terminated: false
      });
      break;

    case EventType.SAMPLE_REGISTERED:
      state.samples.set(data.id, {
        id: data.id,
        brand: data.brand,
        item: data.item,
        mutexGroup: data.mutexGroup ?? null,
        requiredQualification: data.requiredQualification ?? null,
        status: "available",
        damaged: false,
        currentHolder: null,
        currentTeamId: null,
        custody: [],
        registeredAt: timestamp
      });
      break;

    case EventType.METRIC_REGISTERED:
      state.metrics.set(data.id, {
        id: data.id,
        name: data.name,
        kind: data.kind,
        unit: data.unit ?? null,
        brandVisible: data.kind === "health" ? false : data.brandVisible !== false,
        thresholds: data.thresholds ?? {}
      });
      break;

    case EventType.PLAN_GENERATED:
      state.plan = {
        planId: data.planId,
        generatedAt: timestamp,
        entries: data.entries.map((e) => ({ ...e }))
      };
      break;

    case EventType.CHECK_OUT:
    case EventType.TRANSFER:
    case EventType.RETURN:
    case EventType.DAMAGE: {
      const sample = state.samples.get(data.sampleId);
      if (!sample) break;
      const entry = {
        seq,
        eventType: type,
        fromUserId: data.fromUserId ?? null,
        userId: data.userId ?? null, // 接手人/退回经办人
        teamId: data.teamId ?? null,
        segmentId: data.segmentId ?? null,
        timestamp,
        note: data.note ?? null
      };
      sample.custody.push(entry);
      if (type === EventType.CHECK_OUT) {
        sample.status = "checked_out";
        sample.currentHolder = data.userId;
        sample.currentTeamId = data.teamId;
      } else if (type === EventType.TRANSFER) {
        sample.status = "checked_out";
        sample.currentHolder = data.userId;
        sample.currentTeamId = data.teamId ?? sample.currentTeamId;
      } else if (type === EventType.RETURN) {
        sample.status = "returned";
        sample.currentHolder = null;
        sample.currentTeamId = null;
      } else if (type === EventType.DAMAGE) {
        sample.damaged = true;
      }
      break;
    }

    case EventType.EXIT:
    case EventType.EVACUATE: {
      const person = state.people.get(data.userId);
      if (person) person.active = false;
      break;
    }

    case EventType.OBSERVATION: {
      if (data.duplicateOf) {
        const canonical = state.facts.get(data.duplicateOf);
        if (canonical && data.clientId) canonical.duplicateClientIds.push(data.clientId);
        break;
      }
      state.sequences.observation += 1;
      state.facts.set(data.observationId, {
        ...data,
        seq,
        sourceEventHash: data.sourceEventHash ?? hash,
        duplicateClientIds: [...(data.duplicateClientIds ?? [])]
      });
      if (data.dedupeKey) state.factByKey.set(data.dedupeKey, data.observationId);
      break;
    }

    case EventType.RISK_SIGNAL:
      state.riskSignals.push({ ...data, seq, timestamp });
      break;

    case EventType.FREEZE_IMPOSED:
      state.freezes.set(data.freezeId, {
        freezeId: data.freezeId,
        level: data.level,
        scope: data.scope,
        segmentId: data.segmentId ?? null,
        sampleIds: [...(data.sampleIds ?? [])],
        reason: data.reason,
        riskEventId: data.riskEventId ?? null,
        reporterId: data.reporterId ?? null,
        imposedAt: timestamp,
        status: "active",
        decision: null,
        resolvedAt: null,
        reviewerId: null
      });
      break;

    case EventType.FREEZE_RESOLVED: {
      const freeze = state.freezes.get(data.freezeId);
      if (!freeze) break;
      freeze.status = "resolved";
      freeze.decision = data.decision;
      freeze.reviewerId = data.reviewerId;
      freeze.resolvedAt = timestamp;
      freeze.note = data.note ?? null;
      if (data.decision === "terminate" && freeze.segmentId) {
        const seg = state.segments.get(freeze.segmentId);
        if (seg) seg.terminated = true;
      }
      break;
    }

    default:
      break;
  }
  return state;
}

export function replay(events) {
  const state = createState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** 某时刻仍覆盖指定路段/样品的冻结（用于按时间排除冻结区间内的数据）。 */
export function activeFreezesAt(state, whenIso, segmentId, sampleId) {
  const t = Date.parse(whenIso);
  const out = [];
  for (const f of state.freezes.values()) {
    if (t < Date.parse(f.imposedAt)) continue;
    // 复核恢复：恢复时刻起解除；复核终止：永久覆盖；未复核：持续生效。
    const resolved = f.resolvedAt ? Date.parse(f.resolvedAt) : null;
    const stillFrozenAt =
      f.status === "active" ||
      f.decision === "terminate" ||
      (f.decision === "restore" && (resolved === null || t < resolved));
    if (!stillFrozenAt) continue;
    const hitSeg = f.segmentId && f.segmentId === segmentId;
    const hitSample = sampleId && f.sampleIds.includes(sampleId);
    if (hitSeg || hitSample) out.push(f);
  }
  return out;
}

/** 命令时刻是否仍被冻结：生效中或已判定终止（路段/样品永久封闭）；恢复后解除。 */
export function findBlockingFreeze(state, { segmentId = null, sampleId = null } = {}) {
  for (const f of state.freezes.values()) {
    if (f.status === "resolved" && f.decision === "restore") continue;
    if (segmentId && f.segmentId === segmentId) return f;
    if (sampleId && f.sampleIds.includes(sampleId)) return f;
  }
  return null;
}
