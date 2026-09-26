/** 山野实测各端共同使用的事件契约。 */
export const EventType = Object.freeze({
  PERSON_REGISTERED: "person_registered",
  TEAM_REGISTERED: "team_registered",
  SEGMENT_REGISTERED: "segment_registered",
  SAMPLE_REGISTERED: "sample_registered",
  METRIC_REGISTERED: "metric_registered",
  PLAN_GENERATED: "plan_generated",
  CHECK_OUT: "check_out",
  TRANSFER: "transfer",
  DAMAGE: "damage",
  EXIT: "exit",
  EVACUATE: "evacuate",
  RETURN: "return",
  OBSERVATION: "observation",
  RISK_SIGNAL: "risk_signal",
  FREEZE_IMPOSED: "freeze_imposed",
  FREEZE_RESOLVED: "freeze_resolved"
});

/** 风险等级从低到高保持固定顺序。 */
export const RiskLevel = Object.freeze({
  NORMAL: 0,
  WATCH: 1,
  STOP: 2,
  EVACUATE: 3
});

/** 观察类别：健康信号仅组织者可见，永不进入品牌报告。 */
export const ObservationKind = Object.freeze({
  LOCATION: "location",
  ENVIRONMENT: "environment",
  GEAR: "gear",
  HEALTH: "health"
});

/** 安全冻结的复核结论。 */
export const FreezeDecision = Object.freeze({
  RESTORE: "restore",
  TERMINATE: "terminate"
});

export function assertEventId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new TypeError("事件标识格式不正确");
  }
  return value;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

export function assertCode(value, label) {
  if (typeof value !== "string" || !CODE_RE.test(value)) {
    throw new TypeError(`${label}格式不正确`);
  }
  return value;
}
