/**
 * 领域规则：纯函数，不碰存储。
 *  - 领用计划生成（小队能力 × 样品要求 × 互斥组 × 时间/路段冲突）
 *  - 离线观察归属正确路段
 *  - 安全阈值判定与冻结影响面
 *  - 双口径报告（组织全量 / 品牌脱敏）
 */
import { RiskLevel, MetricClass } from "../index.js";
import { FreezeState } from "./model.js";

export class ValidationError extends Error {
  constructor(message, code = "validation_error") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export class ConflictError extends Error {
  constructor(message, code = "conflict", details = null) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
    if (details) this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* 路线分段与离线归属                                                  */
/* ------------------------------------------------------------------ */

/**
 * 把一个观察时间（可能离线补传、乱序）归到正确路段。
 * 规则：观察事实时间落在路段时间窗 [enteredAt, leftAt) 内即归属该段；
 * 若提供了沿线里程/海拔位置则用分段边界兜底；都无法判定归 null（待人工）。
 */
export function attributeSegment(observation, segmentWindows) {
  const t = observation.observedAt ? new Date(observation.observedAt).getTime() : NaN;
  if (Number.isFinite(t)) {
    for (const w of segmentWindows) {
      const from = w.enteredAt ? new Date(w.enteredAt).getTime() : -Infinity;
      const to = w.leftAt ? new Date(w.leftAt).getTime() : Infinity;
      if (t >= from && t < to) return w.segmentId;
    }
  }
  // 位置兜底：沿路线顺序的里程/海拔边界
  const pos = observation.payload?.alongDistance;
  if (typeof pos === "number") {
    for (const w of segmentWindows) {
      const lo = w.fromDistance ?? -Infinity;
      const hi = w.toDistance ?? Infinity;
      if (pos >= lo && pos < hi) return w.segmentId;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 领用计划生成                                                        */
/* ------------------------------------------------------------------ */

/**
 * 根据登记信息生成领用计划。
 * @param state 归约状态
 * @param {object} input { planId, windowStart, windowEnd, segmentIds?,
 *   items:[{sampleId, requiredQualifications?:[], capabilityNeeded?:}], teams:[teamId] }
 * @returns {{ assignments:[], conflicts:[] }}
 * 互斥规则：同一互斥组的样品在重叠时间窗不能分给同一小队；
 * 能力规则：小队能力需覆盖样品 capabilityNeeded；队员资质需覆盖样品要求。
 */
export function generatePlan(state, input) {
  const assignments = [];
  const conflicts = [];
  const teams = input.teams.map((id) => state.teams.get(id)).filter(Boolean);
  // 已存在计划中占用的 (sample, window) 视为资源冲突
  const busy = buildBusyIndex(state);

  for (const item of input.items) {
    const sample = state.samples.get(item.sampleId);
    if (!sample) {
      conflicts.push({ sampleId: item.sampleId, reason: "样品未登记" });
      continue;
    }
    const requiredQual = unique([...(sample.requirements ?? []), ...(item.requiredQualifications ?? [])]);
    const neededCap = item.capabilityNeeded ?? sample.capabilityNeeded ?? null;

    // 资源时间窗冲突：同一样品在重叠窗口已被其他计划领用
    for (const b of busy.get(sample.id) ?? []) {
      if (windowsOverlap(input.windowStart, input.windowEnd, b.start, b.end)) {
        conflicts.push({
          sampleId: sample.id,
          reason: "样品时间窗冲突",
          existingPlanId: b.planId,
          teamId: b.teamId
        });
      }
    }

    const candidates = [];
    for (const team of teams) {
      const problems = [];
      if (neededCap && !team.capabilities.includes(neededCap)) {
        problems.push(`小队缺少能力:${neededCap}`);
      }
      // 资质：队内至少一人具备全部所需资质
      const qualifiedMembers = (team.memberIds ?? [])
        .map((pid) => state.people.get(pid))
        .filter((p) => p && p.active !== false);
      const holder = qualifiedMembers.find((p) =>
        requiredQual.every((q) => p.qualifications.includes(q))
      );
      if (requiredQual.length > 0 && !holder) {
        problems.push("队内无满足全部资质的队员");
      }
      // 互斥组：同队在重叠窗口不能持用同组"另一样品"（同一样品由时间窗冲突表达）
      if (sample.mutexGroup) {
        for (const other of assignments) {
          if (other.teamId !== team.id || other.sampleId === sample.id) continue;
          const otherSample = state.samples.get(other.sampleId);
          if (otherSample?.mutexGroup && otherSample.mutexGroup === sample.mutexGroup) {
            problems.push(`互斥组冲突:${sample.mutexGroup}`);
          }
        }
        for (const b of busyByTeamMutex(state, team.id, sample.mutexGroup, sample.id, input)) {
          problems.push(`互斥组时间窗冲突:${b.planId}`);
        }
      }
      if (problems.length === 0 && holder) {
        candidates.push({ team, holder });
      } else if (problems.length > 0) {
        conflicts.push({ sampleId: sample.id, teamId: team.id, reason: problems.join(";") });
      }
    }

    if (candidates.length > 0) {
      // 确定性选择：队员最多（储备深）的小队，再按编号排序
      candidates.sort((a, b) =>
        (b.team.memberIds.length - a.team.memberIds.length) ||
        a.team.id.localeCompare(b.team.id)
      );
      const pick = candidates[0];
      assignments.push({
        sampleId: sample.id,
        teamId: pick.team.id,
        personId: pick.holder.id,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        segmentIds: input.segmentIds ?? null
      });
    } else if (!conflicts.some((c) => c.sampleId === sample.id && !c.teamId)) {
      conflicts.push({ sampleId: sample.id, reason: "没有可胜任的小队" });
    }
  }
  return { assignments, conflicts };
}

function buildBusyIndex(state) {
  const busy = new Map();
  for (const plan of state.plans.values()) {
    for (const a of plan.assignments ?? []) {
      const list = busy.get(a.sampleId) ?? [];
      list.push({
        planId: plan.id,
        teamId: a.teamId,
        start: a.windowStart,
        end: a.windowEnd,
        mutexGroup: state.samples.get(a.sampleId)?.mutexGroup ?? null
      });
      busy.set(a.sampleId, list);
    }
  }
  return busy;
}

function busyByTeamMutex(state, teamId, mutexGroup, sampleIdRef, input) {
  const out = [];
  for (const plan of state.plans.values()) {
    for (const a of plan.assignments ?? []) {
      if (a.teamId !== teamId) continue;
      const smp = state.samples.get(a.sampleId);
      if (smp?.mutexGroup === mutexGroup && a.sampleId !== sampleIdRef &&
        windowsOverlap(input.windowStart, input.windowEnd, a.windowStart, a.windowEnd)) {
        out.push({ planId: plan.id });
      }
    }
  }
  return out;
}

function windowsOverlap(s1, e1, s2, e2) {
  const t = (x) => (x ? new Date(x).getTime() : null);
  const [a, b, c, d] = [t(s1), t(e1), t(s2), t(e2)];
  if (a === null && d === null) return true;
  if (a === null) return b === null || b > c;
  if (c === null) return d === null || d > a;
  return a < d && c < b;
}

function unique(arr) {
  return [...new Set(arr)];
}

/* ------------------------------------------------------------------ */
/* 安全阈值与冻结影响面                                                */
/* ------------------------------------------------------------------ */

/**
 * 评估风险信号是否达到阈值。
 * thresholds: { metricId/domain: { stop: level|value, evacuate?: } }
 * 健康信号（心率/血氧/高山反应等）达到 STOP 即触发。
 */
export function evaluateThreshold(signal, thresholds = {}) {
  const level = signal.level ?? RiskLevel.NORMAL;
  if (level >= RiskLevel.EVACUATE) return { hit: true, target: "evacuate" };
  if (level >= RiskLevel.STOP) return { hit: true, target: "stop" };
  const rule = thresholds[signal.metricId] ?? thresholds[signal.domain] ?? null;
  if (rule && typeof signal.value === "number") {
    if (rule.evacuate !== undefined &&
      ((rule.direction === "below" && signal.value <= rule.evacuate) ||
       signal.value >= rule.evacuate)) {
      return { hit: true, target: "evacuate" };
    }
    if (rule.stop !== undefined &&
      ((rule.direction === "below" && signal.value <= rule.stop) ||
       (rule.direction !== "below" && signal.value >= rule.stop))) {
      return { hit: true, target: "stop" };
    }
  }
  return { hit: false };
}

/**
 * 计算冻结影响的路段与样品：
 *  - 风险信号所在路段必然受影响；
 *  - 碎石下坡等危险地形连带其下游紧邻路段（直至安全地形）；
 *  - 信号涉及的样品（装备失效）连同其同互斥组备选一起冻结。
 */
export function impactedScope(state, signal) {
  const segmentIds = new Set();
  if (signal.segmentId) segmentIds.add(signal.segmentId);
  const seg = signal.segmentId ? state.segments.get(signal.segmentId) : null;
  if (seg && ["碎石下坡", "scree", "steep"].includes(seg.terrain)) {
    const ordered = [...state.segments.values()].sort((a, b) => a.order - b.order);
    for (let i = ordered.findIndex((x) => x.id === seg.id) + 1; i < ordered.length; i += 1) {
      segmentIds.add(ordered[i].id);
      if (!["碎石下坡", "scree", "steep"].includes(ordered[i].terrain)) break;
    }
  }
  const sampleIds = new Set();
  if (signal.sampleId) {
    sampleIds.add(signal.sampleId);
    const smp = state.samples.get(signal.sampleId);
    if (smp?.mutexGroup) {
      for (const other of state.samples.values()) {
        if (other.mutexGroup === smp.mutexGroup) sampleIds.add(other.id);
      }
    }
  }
  return { segmentIds: [...segmentIds], sampleIds: [...sampleIds] };
}

/* ------------------------------------------------------------------ */
/* 完整性检查                                                          */
/* ------------------------------------------------------------------ */

/**
 * 观察完整性检查：
 *  - 必填：observedAt、metricId（位置类可省 metricId 但需坐标）、上传者
 *  - 设备时钟漂移过大（observedAt 晚于接收时间 + 容差）判无效
 *  - 重复归并后仍缺归属路段的，标记 unattributed（仍保留，但不进品牌汇总）
 */
export function integrityCheck(obs, { now = new Date().toISOString(), clockSkewMs = 5 * 60 * 1000 } = {}) {
  const problems = [];
  if (!obs.observedAt) problems.push("缺少观察时间");
  if (!obs.personId) problems.push("缺少上传者");
  const metric = obs.metricId ? { id: obs.metricId } : null;
  if (!metric && !(obs.payload?.lat != null && obs.payload?.lon != null)) {
    problems.push("缺少指标或坐标");
  }
  if (obs.observedAt) {
    const skew = new Date(obs.observedAt).getTime() - new Date(now).getTime();
    if (skew > clockSkewMs) problems.push("设备时钟超前过多");
  }
  return {
    status: problems.length === 0 ? "valid" : "invalid",
    checkedAt: now,
    problems
  };
}

/* ------------------------------------------------------------------ */
/* 报告投影                                                            */
/* ------------------------------------------------------------------ */

/**
 * 组织口径：全量可追溯。只采纳"冻结前有效且通过完整性检查"的数据。
 * 冻结前 = 观察事实时间早于该路段/样品当前或历史冻结的生效时间；
 * 被终止（terminated）的冻结，其生效后数据一律不采纳；
 * 被恢复（resumed）的冻结，仅冻结窗内数据排除。
 */
export function buildOrganizationReport(state, { now = new Date().toISOString() } = {}) {
  const effective = selectEffectiveObservations(state);
  return {
    generatedAt: now,
    samples: [...state.samples.values()].map((smp) => projectSample(state, smp, effective, false)),
    custody: [...state.chains.values()].map((c) => projectChain(state, c)),
    freezes: [...state.freezes.values()].map((f) => ({
      id: f.id,
      reason: f.reason,
      state: f.state,
      segmentIds: f.segmentIds,
      sampleIds: f.sampleIds,
      triggeredBy: f.triggeredBy,
      at: f.at,
      reviewedBy: f.reviewedBy ?? null,
      reviewedAt: f.reviewedAt ?? null,
      decision: f.state === FreezeState.FROZEN ? null : (f.state === FreezeState.RESUMED ? "resume" : "terminate")
    })),
    health: projectHealth(state, effective),
    excludedCount: state.obsIndex.length - effective.length
  };
}

/**
 * 品牌口径：可落回原始观察（观察编号+样品+路段+时间+值），
 * 但不能反查参与者——移除 personId/teamId/健康数据/坐标精度降级。
 */
export function buildBrandReport(state, { now = new Date().toISOString(), coordGrid = 0.01 } = {}) {
  const effective = selectEffectiveObservations(state);
  return {
    generatedAt: now,
    samples: [...state.samples.values()].map((smp) => projectSample(state, smp, effective, true, coordGrid)),
    traceabilityNote: "每条结论可通过 observationId 经组织端核对原始观察，品牌端不含参与者身份"
  };
}

function selectEffectiveObservations(state) {
  // 构建 (segmentId|sampleId) -> 排除时间区间集合
  const excludeSeg = new Map();
  const excludeSmp = new Map();
  const addExcl = (map, key, from, to) => {
    const list = map.get(key) ?? [];
    list.push([from, to]);
    map.set(key, list);
  };
  for (const f of state.freezes.values()) {
    if (f.state === FreezeState.TERMINATED) {
      // 终止：生效时刻之后全部排除（to = Infinity）
      for (const sid of f.segmentIds ?? []) addExcl(excludeSeg, sid, f.at, null);
      for (const sid of f.sampleIds ?? []) addExcl(excludeSmp, sid, f.at, null);
    } else if (f.state === FreezeState.RESUMED) {
      for (const sid of f.segmentIds ?? []) addExcl(excludeSeg, sid, f.at, f.reviewedAt);
      for (const sid of f.sampleIds ?? []) addExcl(excludeSmp, sid, f.at, f.reviewedAt);
    } else {
      // 仍冻结：生效时刻之后排除
      for (const sid of f.segmentIds ?? []) addExcl(excludeSeg, sid, f.at, null);
      for (const sid of f.sampleIds ?? []) addExcl(excludeSmp, sid, f.at, null);
    }
  }
  const inAny = (map, key, t) =>
    (map.get(key) ?? []).some(([from, to]) => t >= new Date(from).getTime() &&
      (to === null || t < new Date(to).getTime()));

  return state.obsIndex.filter((obs) => {
    if (obs.kind === "risk_signal") return false; // 安全信号不进数据汇总
    if (obs.integrity?.status && obs.integrity.status !== "valid") return false;
    if (!obs.observedAt) return false;
    const t = new Date(obs.observedAt).getTime();
    if (obs.segmentId && inAny(excludeSeg, obs.segmentId, t)) return false;
    if (obs.sampleId && inAny(excludeSmp, obs.sampleId, t)) return false;
    return true;
  });
}

function projectSample(state, sample, effective, brandView, coordGrid = 0.01) {
  const related = effective.filter((o) => o.sampleId === sample.id);
  const byMetric = new Map();
  for (const o of related) {
    if (brandView) {
      const metric = state.metrics.get(o.metricId);
      if (!metric || metric.brandVisible === false || metric.metricClass === MetricClass.HEALTH) continue;
    }
    const key = o.metricId ?? "location";
    const bucket = byMetric.get(key) ?? [];
    bucket.push(brandView ? toBrandObservation(o, state, coordGrid) : toFullObservation(o, state));
    byMetric.set(key, bucket);
  }
  const metrics = {};
  for (const [metricId, rows] of byMetric) {
    const values = rows.map((r) => r.value).filter((v) => typeof v === "number");
    metrics[metricId] = {
      observationCount: rows.length,
      average: values.length ? round(avg(values)) : null,
      observations: rows.map((r) => r.ref)
    };
  }
  const chain = state.chains.get(state.chainBySample.get(sample.id));
  return {
    sampleId: sample.id,
    brand: sample.brand,
    model: sample.model,
    mutexGroup: sample.mutexGroup ?? null,
    status: chain?.status ?? "unused",
    metrics,
    // 品牌口径不给 holder/team
    ...(brandView ? {} : {
      teamId: chain?.teamId ?? null,
      holderId: chain?.holderId ?? null
    })
  };
}

function toFullObservation(o, state) {
  const metric = state.metrics.get(o.metricId);
  return {
    ref: {
      observationId: o.id,
      observedAt: o.observedAt,
      segmentId: o.segmentId ?? null,
      value: numericValue(o, metric),
      personId: o.personId,
      teamId: o.teamId ?? null
    },
    value: numericValue(o, metric)
  };
}

function toBrandObservation(o, state, coordGrid) {
  const metric = state.metrics.get(o.metricId);
  const ref = {
    observationId: o.id, // 可落回原始观察的不透明句柄
    observedAt: o.observedAt,
    segmentId: o.segmentId ?? null,
    value: numericValue(o, metric)
  };
  // 坐标网格化，降低轨迹反推身份的可能
  if (o.payload?.lat != null) {
    ref.gridLat = grid(o.payload.lat, coordGrid);
    ref.gridLon = grid(o.payload.lon, coordGrid);
  }
  return { ref, value: ref.value };
}

function numericValue(o, metric) {
  if (typeof o.payload?.value === "number") return o.payload.value;
  if (typeof o.value === "number") return o.value;
  return undefined;
}

function grid(v, size) {
  return Math.round(v / size) * size;
}

function projectChain(state, chain) {
  return {
    chainId: chain.id,
    sampleId: chain.sampleId,
    teamId: chain.teamId,
    status: chain.status,
    currentHolderId: chain.holderId,
    events: chain.custody.map((c) => ({ ...c })),
    damage: chain.damage ?? null
  };
}

function projectHealth(state, effective) {
  // 健康信息只在组织/安全口径出现，按指标与时间列出，不与品牌样品结论混合
  const rows = [];
  for (const o of state.obsIndex) {
    const metric = state.metrics.get(o.metricId);
    if (metric?.metricClass !== MetricClass.HEALTH) continue;
    if (o.integrity?.status && o.integrity.status !== "valid") continue;
    rows.push({
      observationId: o.id,
      personId: o.personId,
      metricId: o.metricId,
      value: numericValue(o, metric),
      observedAt: o.observedAt,
      segmentId: o.segmentId ?? null
    });
  }
  return { restricted: true, count: rows.length, rows };
}

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function round(x) {
  return Math.round(x * 10000) / 10000;
}
