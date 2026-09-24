import test from "node:test";
import assert from "node:assert/strict";
import { EventType, RiskLevel, assertEventId } from "../src/index.js";

test("风险等级顺序稳定", () => {
  assert.ok(RiskLevel.EVACUATE > RiskLevel.STOP);
});

test("事件标识需要足够长度", () => {
  assert.throws(() => assertEventId("bad"), /格式不正确/);
  assert.equal(assertEventId("device:evt-0001"), "device:evt-0001");
});

test("观察事件名称稳定", () => {
  assert.equal(EventType.OBSERVATION, "observation");
});
