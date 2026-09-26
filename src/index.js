/** 山野实测各端共同使用的事件契约。 */
export const EventType = Object.freeze({
  // 登记类
  PERSON_REGISTERED: "person_registered",
  TEAM_REGISTERED: "team_registered",
  TEAM_MEMBER_ASSIGNED: "team_member_assigned",
  SEGMENT_REGISTERED: "segment_registered",
  TEAM_SEGMENT_PROGRESS: "team_segment_progress",
  SAMPLE_REGISTERED: "sample_registered",
  METRIC_REGISTERED: "metric_registered",
  PLAN_GENERATED: "plan_generated",
  // 保管链类（沿用原契约名）
  CHECK_OUT: "check_out",
  OBSERVATION: "observation",
  TRANSFER: "transfer",
  RISK_SIGNAL: "risk_signal",
  RETURN: "return",
  // 保管链扩展
  DAMAGED: "damaged",
  WITHDRAWN: "withdrawn",
  EVACUATED: "evacuated",
  // 安全冻结与复核
  FREEZE: "freeze",
  FREEZE_REVIEWED: "freeze_reviewed"
});

/** 风险等级从低到高保持固定顺序。 */
export const RiskLevel = Object.freeze({
  NORMAL: 0,
  WATCH: 1,
  STOP: 2,
  EVACUATE: 3
});

export function assertEventId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new TypeError("事件标识格式不正确");
  }
  return value;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

/** 领域内各类实体编号（人员、小队、路段、样品、指标）的统一格式。 */
export function assertEntityId(value, label = "实体标识") {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new TypeError(`${label}格式不正确`);
  }
  return value;
}

/** 装备唯一编号必须可扫码：字母数字开头，允许 - _ . : 且长度受限。 */
export function assertSampleId(value) {
  return assertEntityId(value, "装备唯一编号");
}

/** 品牌不可见的指标分类：健康信号永远不进入品牌口径。 */
export const MetricClass = Object.freeze({
  ENVIRONMENT: "environment",
  LOCATION: "location",
  GEAR_EXPERIENCE: "gear",
  HEALTH: "health"
});

/** 健康类指标的品牌可见性只能为 false，登记时强制。 */
export function assertMetricVisibility(metric) {
  if (metric.metricClass === MetricClass.HEALTH && metric.brandVisible !== false) {
    throw new Error("健康指标必须登记为品牌不可见");
  }
  return metric;
}
