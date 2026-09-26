/**
 * 领域模型：所有可变状态都只由事件归约得到，不接受直接赋值。
 * 事件是 append-only 的事实；本文件提供初始状态与 applyEvent 纯函数。
 */
import { EventType, RiskLevel } from "../index.js";

export const ChainStatus = Object.freeze({
  HELD: "held",
  TRANSFERRED: "transferred",
  DAMAGED: "damaged",
  WITHDRAWN: "withdrawn",
  EVACUATED: "evacuated",
  RETURNED: "returned"
});

export const FreezeState = Object.freeze({
  FROZEN: "frozen",
  RESUMED: "resumed",
  TERMINATED: "terminated"
});

/** 保管链终态：处于这些状态时不能再登记新的持用/转交。 */
const TERMINAL_CHAIN = new Set([
  ChainStatus.WITHDRAWN,
  ChainStatus.EVACUATED,
  ChainStatus.RETURNED
]);

export function initialState() {
  return {
    people: new Map(), // personId -> { id, name, qualifications:[] , teamId, active:boolean }
    teams: new Map(), // teamId -> { id, name, capabilities:[], memberIds:[] }
    segments: new Map(), // segmentId -> { id, name, order, terrain, elevation, hazards:[] }
    samples: new Map(), // sampleId -> { id, brand, model, mutexGroup, requirements:[] }
    metrics: new Map(), // metricId -> { id, name, brandVisible, unit }
    progress: new Map(), // `${teamId}|${segmentId}` -> { enteredAt, leftAt, fromDistance, toDistance }
    plans: new Map(), // planId -> plan 记录（含版本）
    chains: new Map(), // chainId -> 保管链（一件样品一条）
    chainBySample: new Map(), // sampleId -> chainId
    observations: new Map(), // dedupKey -> canonical observation
    obsIndex: [], // 归并后的观察，按到达顺序
    freezes: new Map(), // freezeId -> 冻结记录
    segmentFreeze: new Map(), // segmentId -> 当前生效 freezeId
    sampleFreeze: new Map(), // sampleId -> 当前生效 freezeId
    reviews: [], // 安全员复核记录
    eventSeq: 0
  };
}

/**
 * 归约一个事件。返回新状态（浅拷贝集合，便于测试比较），
 * 命令合法性由 service 层在写入前校验，这里只做事实投影。
 */
export function applyEvent(state, event) {
  const s = { ...state };
  const cp = (m) => new Map(m);
  switch (event.type) {
    case EventType.PERSON_REGISTERED: {
      s.people = cp(state.people);
      s.people.set(event.person.id, { ...event.person, teamId: null, active: true });
      break;
    }
    case EventType.TEAM_REGISTERED: {
      s.teams = cp(state.teams);
      const team = { ...event.team, memberIds: [...(event.memberIds ?? event.team.memberIds ?? [])] };
      s.teams.set(team.id, team);
      s.people = cp(state.people);
      for (const pid of team.memberIds) {
        const p = s.people.get(pid);
        if (p) s.people.set(pid, { ...p, teamId: team.id });
      }
      break;
    }
    case EventType.TEAM_MEMBER_ASSIGNED: {
      s.teams = cp(state.teams);
      const team = s.teams.get(event.teamId);
      if (team && !team.memberIds.includes(event.personId)) {
        s.teams.set(event.teamId, { ...team, memberIds: [...team.memberIds, event.personId] });
      }
      const p = state.people.get(event.personId);
      if (p) {
        s.people = s.people ?? cp(state.people);
        s.people.set(event.personId, { ...p, teamId: event.teamId });
      }
      break;
    }
    case EventType.SEGMENT_REGISTERED: {
      s.segments = cp(state.segments);
      s.segments.set(event.segment.id, { ...event.segment });
      break;
    }
    case EventType.TEAM_SEGMENT_PROGRESS: {
      // 小队进入/离开某路段；离开时间窗用于离线观察归属。乱序到达时取最早进入、最晚离开。
      s.progress = new Map(state.progress);
      const key = `${event.teamId}|${event.segmentId}`;
      const prev = s.progress.get(key);
      const enteredAt = prev?.enteredAt && event.enteredAt
        ? (new Date(prev.enteredAt) <= new Date(event.enteredAt) ? prev.enteredAt : event.enteredAt)
        : (event.enteredAt ?? prev?.enteredAt ?? null);
      const leftAt = prev?.leftAt && event.leftAt
        ? (new Date(prev.leftAt) >= new Date(event.leftAt) ? prev.leftAt : event.leftAt)
        : (event.leftAt ?? prev?.leftAt ?? null);
      s.progress.set(key, {
        teamId: event.teamId,
        segmentId: event.segmentId,
        enteredAt,
        leftAt,
        fromDistance: event.fromDistance ?? prev?.fromDistance ?? null,
        toDistance: event.toDistance ?? prev?.toDistance ?? null
      });
      break;
    }
    case EventType.SAMPLE_REGISTERED: {
      s.samples = cp(state.samples);
      s.samples.set(event.sample.id, { ...event.sample });
      break;
    }
    case EventType.METRIC_REGISTERED: {
      s.metrics = cp(state.metrics);
      s.metrics.set(event.metric.id, { ...event.metric });
      break;
    }
    case EventType.PLAN_GENERATED: {
      s.plans = cp(state.plans);
      s.plans.set(event.plan.id, { ...event.plan });
      break;
    }
    case EventType.CHECK_OUT: {
      s.chains = cp(state.chains);
      s.chainBySample = cp(state.chainBySample);
      const chain = {
        id: event.chainId,
        sampleId: event.sampleId,
        teamId: event.teamId,
        startedAt: event.occurredAt,
        status: ChainStatus.HELD,
        holderId: event.personId,
        custody: [{
          kind: "check_out",
          personId: event.personId,
          at: event.occurredAt,
          note: event.note ?? null
        }]
      };
      s.chains.set(chain.id, chain);
      s.chainBySample.set(event.sampleId, chain.id);
      break;
    }
    case EventType.TRANSFER: {
      s.chains = cp(state.chains);
      const chain = state.chains.get(event.chainId);
      const next = {
        ...chain,
        holderId: event.toPersonId,
        status: ChainStatus.TRANSFERRED,
        custody: [...chain.custody, {
          kind: "transfer",
          fromPersonId: event.fromPersonId,
          personId: event.toPersonId,
          at: event.occurredAt,
          note: event.note ?? null
        }]
      };
      s.chains.set(chain.id, next);
      break;
    }
    case EventType.DAMAGED: {
      s.chains = cp(state.chains);
      const chain = state.chains.get(event.chainId);
      s.chains.set(chain.id, {
        ...chain,
        status: ChainStatus.DAMAGED,
        damage: { at: event.occurredAt, reason: event.reason, personId: event.personId },
        custody: [...chain.custody, {
          kind: "damaged",
          personId: event.personId ?? chain.holderId,
          at: event.occurredAt,
          reason: event.reason
        }]
      });
      break;
    }
    case EventType.WITHDRAWN: {
      s.chains = cp(state.chains);
      const chain = state.chains.get(event.chainId);
      s.chains.set(chain.id, {
        ...chain,
        status: ChainStatus.WITHDRAWN,
        custody: [...chain.custody, {
          kind: "withdrawn",
          personId: event.personId ?? chain.holderId,
          at: event.occurredAt,
          reason: event.reason ?? null
        }]
      });
      break;
    }
    case EventType.EVACUATED: {
      s.chains = cp(state.chains);
      const chain = state.chains.get(event.chainId);
      s.chains.set(chain.id, {
        ...chain,
        status: ChainStatus.EVACUATED,
        custody: [...chain.custody, {
          kind: "evacuated",
          personId: event.personId ?? chain.holderId,
          at: event.occurredAt,
          reason: event.reason ?? null
        }]
      });
      break;
    }
    case EventType.RETURN: {
      s.chains = cp(state.chains);
      const chain = state.chains.get(event.chainId);
      s.chains.set(chain.id, {
        ...chain,
        status: ChainStatus.RETURNED,
        holderId: null,
        custody: [...chain.custody, {
          kind: "return",
          personId: event.personId ?? chain.holderId,
          at: event.occurredAt,
          note: event.note ?? null
        }]
      });
      break;
    }
    case EventType.OBSERVATION: {
      const obs = event.observation;
      s.observations = new Map(state.observations);
      s.obsIndex = state.obsIndex.slice();
      const existing = s.observations.get(obs.dedupKey);
      if (existing) {
        // 归并：已被完整性检查判废的事实不复活；其余字段以更"完整"的记录为准。
        const merged = mergeObservation(existing, obs);
        s.observations.set(obs.dedupKey, merged);
        const idx = s.obsIndex.findIndex((o) => o.dedupKey === obs.dedupKey);
        if (idx >= 0) s.obsIndex[idx] = merged;
      } else {
        s.observations.set(obs.dedupKey, obs);
        s.obsIndex.push(obs);
      }
      break;
    }
    case EventType.RISK_SIGNAL: {
      // 风险信号本身也作为观察类事实保存（健康类仅安全口径）
      s.observations = new Map(state.observations);
      s.obsIndex = state.obsIndex.slice();
      if (!s.observations.has(event.signal.dedupKey)) {
        s.observations.set(event.signal.dedupKey, event.signal);
        s.obsIndex.push(event.signal);
      }
      break;
    }
    case EventType.FREEZE: {
      s.freezes = cp(state.freezes);
      s.segmentFreeze = cp(state.segmentFreeze);
      s.sampleFreeze = cp(state.sampleFreeze);
      const f = { ...event.freeze, state: FreezeState.FROZEN };
      s.freezes.set(f.id, f);
      for (const seg of f.segmentIds ?? []) {
        // 同一路段已有冻结则保持更强的一条（终止 > 冻结由后续复核处理）
        if (!s.segmentFreeze.has(seg)) s.segmentFreeze.set(seg, f.id);
      }
      for (const smp of f.sampleIds ?? []) {
        if (!s.sampleFreeze.has(smp)) s.sampleFreeze.set(smp, f.id);
      }
      break;
    }
    case EventType.FREEZE_REVIEWED: {
      s.freezes = cp(state.freezes);
      s.segmentFreeze = cp(state.segmentFreeze);
      s.sampleFreeze = cp(state.sampleFreeze);
      const prev = state.freezes.get(event.freezeId);
      const next = {
        ...prev,
        state: event.decision === "resume" ? FreezeState.RESUMED : FreezeState.TERMINATED,
        reviewedBy: event.reviewerId,
        reviewedAt: event.reviewedAt,
        reviewNote: event.note ?? null
      };
      s.freezes.set(event.freezeId, next);
      const lift = (map) => {
        for (const [k, v] of map) if (v === event.freezeId) map.delete(k);
      };
      if (event.decision === "resume") {
        lift(s.segmentFreeze);
        lift(s.sampleFreeze);
      }
      s.reviews = [...state.reviews, {
        freezeId: event.freezeId,
        decision: event.decision,
        reviewerId: event.reviewerId,
        reviewerToken: event.reviewerToken,
        at: event.reviewedAt,
        note: event.note ?? null
      }];
      break;
    }
    default:
      // 未知事件类型不改变状态，向前兼容
      break;
  }
  s.eventSeq = state.eventSeq + 1;
  return s;
}

/**
 * 乱序/重复归并规则：
 * - 同一 dedupKey 视为同一事实；
 * - 已标记 integrity=invalid 的事实不被后到记录复活；
 * - payload 做字段级合并（后到非空值补齐，不覆盖已有非空值，保证乱序等价）；
 * - arrivedAt 保留首次到达；observedAt 取最早（设备时钟为准的事实时间）。
 */
function mergeObservation(a, b) {
  if (a.integrity?.status === "invalid" || b.integrity?.status === "invalid") {
    const invalid = a.integrity?.status === "invalid" ? a : b;
    const other = invalid === a ? b : a;
    return {
      ...other,
      ...invalid,
      payload: mergePayload(other.payload, invalid.payload),
      arrivedAt: earlier(a.arrivedAt, b.arrivedAt)
    };
  }
  const payload = mergePayload(a.payload, b.payload);
  const merged = {
    ...a,
    ...b,
    payload,
    observedAt: earlier(a.observedAt, b.observedAt),
    arrivedAt: earlier(a.arrivedAt, b.arrivedAt)
  };
  // 位置以更精确（更多小数位/非空）的一版补齐
  return merged;
}

function mergePayload(p1 = {}, p2 = {}) {
  const out = { ...p1 };
  for (const [k, v] of Object.entries(p2)) {
    if (v !== null && v !== undefined && v !== "" && out[k] === undefined) out[k] = v;
  }
  return out;
}

function earlier(t1, t2) {
  if (!t1) return t2;
  if (!t2) return t1;
  return new Date(t1).getTime() <= new Date(t2).getTime() ? t1 : t2;
}

export function isChainTerminal(chain) {
  return TERMINAL_CHAIN.has(chain.status);
}
