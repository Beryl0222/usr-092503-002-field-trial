import { RiskLevel, ObservationKind } from "./index.js";
import { activeFreezesAt } from "./projection.js";

/**
 * 完整性检查：事实必须能归到路段、数值合法、观测时刻可解析、来源哈希链有效。
 * 哈希链在 EventStore.load 时已逐行验证；这里检查单条事实的业务完整性。
 */
export function checkCompleteness(fact) {
  const problems = [];
  if (typeof fact.value !== "number" || Number.isNaN(fact.value)) problems.push("数值缺失或非法");
  if (!fact.observedAt || Number.isNaN(Date.parse(fact.observedAt))) problems.push("观测时刻缺失");
  if (!fact.segmentId) problems.push("无法归因到路段");
  if (!fact.sourceEventHash) problems.push("缺少来源事件哈希");
  return problems;
}

/**
 * 判断事实在其观测时刻是否有效：
 * 只采纳“冻结前”以及“复核恢复之后”的数据；
 * 冻结区间内、终止之后的数据一律排除。
 */
export function validityAtTime(state, fact) {
  const blocking = activeFreezesAt(state, fact.observedAt, fact.segmentId, fact.sampleId);
  if (blocking.length === 0) return { valid: true, reasons: [] };
  const terminated = blocking.find((f) => f.decision === "terminate");
  if (terminated) {
    return { valid: false, reasons: [`路段已终止（冻结 ${terminated.freezeId}）`] };
  }
  return {
    valid: false,
    reasons: [`观测于冻结区间内（${blocking.map((f) => f.freezeId).join(",")}）`]
  };
}

/** 汇总全部事实的有效性，供组织者报告使用。 */
export function classifyFacts(state) {
  const accepted = [];
  const rejected = [];
  for (const fact of state.facts.values()) {
    const problems = checkCompleteness(fact);
    if (problems.length) {
      rejected.push({ fact, reasons: problems });
      continue;
    }
    const v = validityAtTime(state, fact);
    if (v.valid) accepted.push(fact);
    else rejected.push({ fact, reasons: v.reasons });
  }
  return { accepted, rejected };
}

// ---------- 组织者可追溯报告 ----------

export function organizerReport(state, { headHash = null, verified = true, eventCount = null } = {}) {
  const { accepted, rejected } = classifyFacts(state);
  const samples = [...state.samples.values()].map((s) => ({
    sampleId: s.id,
    brand: s.brand,
    item: s.item,
    status: s.status,
    damaged: s.damaged,
    currentHolder: s.currentHolder,
    currentTeamId: s.currentTeamId,
    custodyLength: s.custody.length
  }));

  return {
    report: "organizer",
    generatedAt: new Date().toISOString(),
    integrity: {
      verified,
      headHash,
      eventCount: eventCount ?? stateFactsCount(state)
    },
    inventory: {
      people: [...state.people.values()].map((p) => ({
        id: p.id,
        name: p.name,
        organization: p.organization,
        qualifications: [...p.qualifications],
        active: p.active
      })),
      teams: [...state.teams.values()].map((t) => ({
        id: t.id,
        name: t.name,
        qualifications: [...t.qualifications],
        members: [...t.memberIds]
      })),
      segments: [...state.segments.values()].map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        terminated: s.terminated
      })),
      samples
    },
    plan: state.plan
      ? {
          planId: state.plan.planId,
          entries: state.plan.entries,
          conflicts: state.plan.conflicts
        }
      : null,
    custody: [...state.samples.values()].map((s) => ({
      sampleId: s.id,
      brand: s.brand,
      chain: s.custody
    })),
    safety: {
      riskSignals: state.riskSignals,
      freezes: [...state.freezes.values()],
      reviews: [...state.freezes.values()]
        .filter((f) => f.status === "resolved")
        .map((f) => ({
          freezeId: f.freezeId,
          decision: f.decision,
          reviewerId: f.reviewerId,
          resolvedAt: f.resolvedAt,
          note: f.note
        }))
    },
    observations: {
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted,
      rejected: rejected.map((r) => ({
        observationId: r.fact.observationId,
        userId: r.fact.userId,
        metricId: r.fact.metricId,
        segmentId: r.fact.segmentId,
        observedAt: r.fact.observedAt,
        reasons: r.reasons
      }))
    }
  };
}

function stateFactsCount(state) {
  return state.facts.size + state.riskSignals.length + state.freezes.size;
}

// ---------- 品牌脱敏报告 ----------

/**
 * 品牌报告：
 * - 只含该品牌样品的装备类观察与路段环境背景；
 * - 健康类指标永不出现，即使误配了 brandVisible；
 * - 人员、小队一律用 HMAC 假名，品牌无法反查身份；
 * - 每条结论带 observationId 与来源事件哈希，可落回原始观察核对。
 */
export function brandReport(service, state, brand) {
  const { accepted } = classifyFacts(state);
  const pseudo = (kind, id) => (id == null ? null : service.pseudonym(`${kind}:${brand}`, id));

  const brandSampleIds = new Set(
    [...state.samples.values()].filter((s) => s.brand === brand).map((s) => s.id)
  );

  const gearFactsOfBrand = accepted.filter(
    (f) =>
      f.kind === ObservationKind.GEAR &&
      brandSampleIds.has(f.sampleId) &&
      state.metrics.get(f.metricId)?.brandVisible
  );
  // 品牌可见的环境背景，只保留其样品实际出现过的路段，不泄露整条无关路线。
  const contextSegments = new Set(gearFactsOfBrand.map((f) => f.segmentId).filter(Boolean));

  const visibleFacts = accepted.filter((f) => {
    if (f.kind === ObservationKind.HEALTH) return false; // 个人健康信息硬性隔离
    if (f.kind === ObservationKind.LOCATION) return false; // 行进轨迹不向品牌开放
    const metric = state.metrics.get(f.metricId);
    if (!metric || !metric.brandVisible) return false;
    if (f.kind === ObservationKind.GEAR) return brandSampleIds.has(f.sampleId);
    // 环境类仅在该品牌样品出现过的路段提供背景。
    return f.kind === ObservationKind.ENVIRONMENT && contextSegments.has(f.segmentId);
  });

  const evidence = visibleFacts.map((f) => ({
    observationId: f.observationId,
    sampleId: f.sampleId && brandSampleIds.has(f.sampleId) ? f.sampleId : null,
    segmentId: f.segmentId,
    metricId: f.metricId,
    kind: f.kind,
    value: f.value,
    unit: f.unit,
    observedAt: f.observedAt,
    subjectPseudonym: pseudo("user", f.userId),
    teamPseudonym: pseudo("team", f.teamId),
    outsideCorridor: f.outsideCorridor,
    sourceEventHash: f.sourceEventHash
  }));

  // 按样品汇总结论，每个数值都能回溯到证据编号。
  const conclusions = [...brandSampleIds].map((sampleId) => {
    const sample = state.samples.get(sampleId);
    const sampleFacts = evidence.filter((e) => e.sampleId === sampleId);
    const byMetric = new Map();
    for (const f of sampleFacts) {
      if (!byMetric.has(f.metricId)) byMetric.set(f.metricId, []);
      byMetric.get(f.metricId).push(f);
    }
    const metrics = [...byMetric.entries()].map(([metricId, facts]) => {
      const metric = state.metrics.get(metricId);
      const values = facts.map((f) => f.value);
      const breaches = facts
        .filter((f) =>
          (metric.thresholds ?? []).some((r) =>
            r.op === ">=" ? f.value >= r.value : f.value <= r.value
          )
        )
        .map((f) => f.observationId);
      return {
        metricId,
        name: metric?.name ?? metricId,
        unit: metric?.unit ?? null,
        count: facts.length,
        average: values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        thresholdBreaches: breaches,
        evidence: facts.map((f) => f.observationId)
      };
    });
    return {
      sampleId,
      item: sample.item,
      damaged: sample.damaged,
      status: sample.status,
      validObservationCount: sampleFacts.length,
      metrics
    };
  });

  // 路段环境背景：去身份化的区段汇总，帮助品牌解释装备表现。
  const segmentContext = [...state.segments.values()]
    .sort((a, b) => a.order - b.order)
    .map((seg) => {
      const env = evidence.filter((e) => e.segmentId === seg.id && e.kind !== "gear");
      return {
        segmentId: seg.id,
        name: seg.name,
        terminated: seg.terminated,
        observations: env.map((e) => ({
          observationId: e.observationId,
          metricId: e.metricId,
          value: e.value,
          unit: e.unit,
          observedAt: e.observedAt,
          sourceEventHash: e.sourceEventHash
        }))
      };
    })
    .filter((s) => s.observations.length > 0);

  return {
    report: "brand",
    brand,
    generatedAt: new Date().toISOString(),
    note: "主体身份已假名化；健康类观察不在本报告内；结论可凭 observationId 向组织者核验原始观察。",
    conclusions,
    segmentContext,
    evidence
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
