/** 装配：事件存储 + 领域服务。HTTP 与 CLI 共用。 */
import { EventStore } from "./store/eventStore.js";
import { DispatchService } from "./service/dispatchService.js";

export const DEFAULT_THRESHOLDS = Object.freeze({
  // 血氧低于该值停测，低于更危险值撤离（direction: below）
  "m-spo2": { stop: 88, evacuate: 80, direction: "below" },
  // 心率持续过高
  "m-heart-rate": { stop: 150, evacuate: 170 }
});

export async function createApp(options = {}) {
  const dir = options.dir ?? "./data";
  const store = new EventStore(dir);
  const service = new DispatchService(store, {
    safetyOfficerId: options.safetyOfficerId ?? "safety-officer",
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    clock: options.clock
  });
  const { replayed } = await service.start();
  return { store, service, replayed };
}
