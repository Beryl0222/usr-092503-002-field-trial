import { createServer } from "node:http";
import { DomainError, AuthorizationError } from "./errors.js";
import { organizerReport, brandReport } from "./reports.js";

/**
 * 令牌形如 "<role>:<secret>" 或 "brand:<brand>:<secret>"。
 * 角色：organizer / safety / member / brand。
 * 品牌令牌只能读取自己品牌的脱敏报告，且报告中的主体均为假名。
 */
export function parseToken(header, credentials) {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (credentials[token]) return credentials[token];
  return null;
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("请求体不是合法 JSON", { code: "validation_error", status: 400 });
  }
}

const ROLE_LABEL = {
  organizer: "组织者",
  safety: "安全员",
  member: "队员",
  brand: "品牌方"
};

export function createHttpServer(service, credentials) {
  function requireRole(principal, roles) {
    if (!principal) throw new AuthorizationError("缺少身份令牌");
    if (!roles.includes(principal.role)) {
      throw new AuthorizationError(
        `${ROLE_LABEL[principal.role] ?? principal.role}无权执行该操作`
      );
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://field.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      const principal = parseToken(req.headers.authorization, credentials);
      const meta = () => ({
        cmdId: req.headers["idempotency-key"] || null,
        timestamp: req.headers["x-observed-at"] || undefined
      });

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, headHash: service.store.headHash() });
      }

      if (req.method === "GET" && path === "/reports/organizer") {
        requireRole(principal, ["organizer"]);
        return send(
          res,
          200,
          organizerReport(service.state(), {
            headHash: service.store.headHash(),
            eventCount: service.store.events.length
          })
        );
      }

      const brandMatch = path.match(/^\/reports\/brand\/([^/]+)$/);
      if (req.method === "GET" && brandMatch) {
        requireRole(principal, ["brand", "organizer"]);
        const brand = decodeURIComponent(brandMatch[1]);
        if (principal.role === "brand" && principal.brand !== brand) {
          throw new AuthorizationError("品牌方只能读取本品牌报告");
        }
        return send(res, 200, brandReport(service, service.state(), brand));
      }

      const custodyMatch = path.match(/^\/custody\/([A-Za-z0-9._-]+)$/);
      if (req.method === "GET" && custodyMatch) {
        requireRole(principal, ["organizer", "safety"]);
        return send(res, 200, service.custodyOf(decodeURIComponent(custodyMatch[1])));
      }

      if (req.method !== "POST") throw new DomainError("不支持的方法", { code: "not_found", status: 404 });

      const body = await readJson(req);

      switch (path) {
        case "/register/person":
        case "/register/team":
        case "/register/segment":
        case "/register/sample":
        case "/register/metric": {
          requireRole(principal, ["organizer"]);
          const key = path.split("/").pop();
          const method = {
            person: "registerPerson",
            team: "registerTeam",
            segment: "registerSegment",
            sample: "registerSample",
            metric: "registerMetric"
          }[key];
          return send(res, 201, await service[method](body, meta()));
        }

        case "/plan": {
          requireRole(principal, ["organizer"]);
          return send(res, 201, await service.plan(meta()));
        }

        case "/custody/checkout":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.checkOut(body, meta()));
        case "/custody/transfer":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.transfer(body, meta()));
        case "/custody/damage":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.reportDamage(body, meta()));
        case "/custody/return":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.returnSample(body, meta()));
        case "/custody/exit":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.exitParticipant(body, meta()));
        case "/custody/evacuate":
          requireRole(principal, ["organizer", "member", "safety"]);
          return send(res, 201, await service.evacuate(body, meta()));

        case "/observations":
          requireRole(principal, ["organizer", "member"]);
          return send(res, 201, await service.submitObservation(body, meta()));

        case "/risk":
          requireRole(principal, ["organizer", "member", "safety"]);
          return send(res, 201, await service.reportRisk(body, meta()));

        case "/freezes/resolve":
          requireRole(principal, ["safety"]);
          return send(res, 201, await service.resolveFreeze(body, meta()));

        default:
          throw new DomainError(`未知路径：${path}`, { code: "not_found", status: 404 });
      }
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.status, { error: err.code, message: err.message });
      }
      return send(res, 500, { error: "internal_error", message: String(err?.message ?? err) });
    }
  };

  return createServer(handler);
}
