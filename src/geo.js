/** 地理归因：把一条带 GPS 的观察归到路线的正确路段。 */

const DEG_KM = 111.32;
const DEFAULT_TOLERANCE_KM = 1.5;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** 两点球面距离（公里）。 */
export function haversineKm(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** 点到线段（起终点）的距离（公里）与投影比例 t。 */
export function distanceToSegmentKm(point, start, end) {
  // 赤道附近等距近似：把经度折成纬度尺度，足以做走廊判定。
  const midLat = toRad((start.lat + end.lat) / 2);
  const px = (p) => ({ x: p.lng * DEG_KM * Math.cos(midLat), y: p.lat * DEG_KM });
  const a = px(start);
  const b = px(end);
  const p = px(point);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  const dist = Math.hypot(p.x - qx, p.y - qy);
  return { distanceKm: dist, t };
}

/**
 * 选择观察点所属路段：
 * 1. 投影落在某段起终点之间且在走廊宽度内 → 该段；
 * 2. 否则取最近的路段（离线漂移点也能归因，但会标记为偏离走廊）。
 * 路段按 order 排序，归因只依赖事先登记的路线，与上传顺序无关。
 */
export function attributeSegment(point, segments, { toleranceKm = DEFAULT_TOLERANCE_KM } = {}) {
  if (!point || typeof point.lat !== "number" || typeof point.lng !== "number") {
    return { segmentId: null, outsideCorridor: true };
  }
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  let best = null;
  for (const seg of ordered) {
    if (!seg.start || !seg.end) continue;
    const { distanceKm, t } = distanceToSegmentKm(point, seg.start, seg.end);
    if (t > 0 && t < 1 && (!best || distanceKm < best.distanceKm)) {
      best = { segmentId: seg.id, distanceKm, inside: distanceKm <= toleranceKm };
    }
  }
  if (best) {
    return { segmentId: best.segmentId, outsideCorridor: !best.inside };
  }
  // 点在所有端点之外：退化为全局最近路段。
  let nearest = null;
  for (const seg of ordered) {
    const dStart = haversineKm(point, seg.start);
    const dEnd = haversineKm(point, seg.end);
    const d = Math.min(dStart, dEnd);
    if (!nearest || d < nearest.distanceKm) nearest = { segmentId: seg.id, distanceKm: d };
  }
  return { segmentId: nearest?.segmentId ?? null, outsideCorridor: true };
}
