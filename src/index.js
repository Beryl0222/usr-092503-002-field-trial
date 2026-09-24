/** 山野实测各端共同使用的事件契约。 */
export const EventType = Object.freeze({
  CHECK_OUT: "check_out",
  OBSERVATION: "observation",
  TRANSFER: "transfer",
  RISK_SIGNAL: "risk_signal",
  RETURN: "return"
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
