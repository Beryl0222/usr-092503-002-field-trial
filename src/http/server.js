/**
 * HTTP API（node:http，零依赖）。
 * 所有写操作都是 JSON POST；服务层串行队列保证并发语义。
 * 身份通过请求头传递：x-actor-id / x-actor-role / x-actor-token。
 */
import http from "node:http";
import { ValidationError, ConflictError } from "../domain/rules.js";
import { ROLE } from "../service/dispatchService.js";

export function createServer(service) {
  return http.createServer((req, res) => {
    handle(req, res, service).catch((err) => sendError(res, err));
  });
}

async function handle(req, res, service) {
  const url = new URL(req.url, "http://localhost");
  const route = match(req.method, url.pathname);
  if (!route) return sendError(res, notFound(url.pathname));

  const actor = {
    actorId: req.headers["x-actor-id"] ?? null,
    role: req.headers["x-actor-role"] ?? ROLE.MEMBER,
    token: req.headers["x-actor-token"] ?? null
  };
  let body = {};
  if (req.method === "POST" || req.method === "PUT") {
    body = await readJson(req);
  }

  switch (route.name) {
    case "registerPerson":
      return sendJson(res, 201, await service.registerPerson(body, actor));
    case "registerTeam":
      return sendJson(res, 201, await service.registerTeam(body, actor));
    case "assignMember":
      return sendJson(res, 200, await service.assignTeamMember(body, actor));
    case "registerSegment":
      return sendJson(res, 201, await service.registerSegment(body, actor));
    case "registerSample":
      return sendJson(res, 201, await service.registerSample(body, actor));
    case "registerMetric":
      return sendJson(res, 201, await service.registerMetric(body, actor));
    case "progress":
      return sendJson(res, 200, await service.reportProgress({ ...body, teamId: route.params.teamId }));
    case "generatePlan":
      return sendJson(res, 201, await service.generatePlan(body, actor));
    case "getPlan":
      return sendJson(res, 200, expectFound(service.getPlan(route.params.id)));
    case "checkOut":
      return sendJson(res, 201, await service.checkOut(body, actor));
    case "transfer":
      return sendJson(res, 200, await service.transfer(body, actor));
    case "damage":
      return sendJson(res, 200, await service.reportDamage(body, actor));
    case "withdraw":
      return sendJson(res, 200, await service.withdraw(body, actor));
    case "evacuate":
      return sendJson(res, 200, await service.evacuate(body, actor));
    case "return":
      return sendJson(res, 200, await service.returnSample(body, actor));
    case "getChain":
      return sendJson(res, 200, expectFound(service.getChain(route.params.ref)));
    case "observation":
      return sendJson(res, 202, await service.recordObservation(body, actor));
    case "riskSignal":
      return sendJson(res, 202, await service.recordRiskSignal(body, actor));
    case "freeze":
      requireRole(actor, [ROLE.ORGANIZER, ROLE.SAFETY]);
      return sendJson(res, 201, await service.freeze(body, actor));
    case "reviewFreeze":
      return sendJson(res, 200, await service.reviewFreeze(
        { ...body, freezeId: route.params.id }, actor
      ));
    case "reportOrg":
      return sendJson(res, 200, service.organizationReport());
    case "reportBrand":
      return sendJson(res, 200, service.brandReport());
    case "trace":
      return sendJson(res, 200, expectFound(service.traceObservation(route.params.id)));
    default:
      return sendError(res, notFound(url.pathname));
  }
}

const ROUTES = [
  ["POST", /^\/register\/people$/, "registerPerson"],
  ["POST", /^\/register\/teams$/, "registerTeam"],
  ["POST", /^\/register\/teams\/members$/, "assignMember"],
  ["POST", /^\/register\/segments$/, "registerSegment"],
  ["POST", /^\/register\/samples$/, "registerSample"],
  ["POST", /^\/register\/metrics$/, "registerMetric"],
  ["POST", /^\/teams\/([^/]+)\/progress$/, "progress"],
  ["POST", /^\/plans$/, "generatePlan"],
  ["GET", /^\/plans\/([^/]+)$/, "getPlan"],
  ["POST", /^\/custody\/check-out$/, "checkOut"],
  ["POST", /^\/custody\/transfer$/, "transfer"],
  ["POST", /^\/custody\/damage$/, "damage"],
  ["POST", /^\/custody\/withdraw$/, "withdraw"],
  ["POST", /^\/custody\/evacuate$/, "evacuate"],
  ["POST", /^\/custody\/return$/, "return"],
  ["GET", /^\/custody\/([^/]+)$/, "getChain"],
  ["POST", /^\/observations$/, "observation"],
  ["POST", /^\/risk-signals$/, "riskSignal"],
  ["POST", /^\/freezes$/, "freeze"],
  ["POST", /^\/freezes\/([^/]+)\/review$/, "reviewFreeze"],
  ["GET", /^\/reports\/organization$/, "reportOrg"],
  ["GET", /^\/reports\/brand$/, "reportBrand"],
  ["GET", /^\/trace\/([^/]+)$/, "trace"]
];

function match(method, pathname) {
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const mm = pathname.match(re);
    if (mm) return { name, params: extractParams(name, mm) };
  }
  return null;
}

function extractParams(name, mm) {
  if (name === "progress") return { teamId: decodeURIComponent(mm[1]) };
  if (["getPlan", "reviewFreeze", "trace"].includes(name)) return { id: decodeURIComponent(mm[1]) };
  if (name === "getChain") return { ref: decodeURIComponent(mm[1]) };
  return {};
}

function requireRole(actor, roles) {
  if (!roles.includes(actor.role)) {
    throw new ConflictError(`该操作要求角色: ${roles.join("/")}`, "forbidden");
  }
}

function expectFound(value) {
  if (value == null) {
    const err = new Error("资源不存在");
    err.statusCode = 404;
    throw err;
  }
  return value;
}

function notFound(pathname) {
  const err = new Error(`无此路由: ${pathname}`);
  err.statusCode = 404;
  return err;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res, err) {
  let status = err.statusCode ?? 500;
  if (err instanceof ValidationError) status = 400;
  else if (err instanceof ConflictError) {
    status = err.code === "frozen" ? 423 : err.code === "forbidden" ? 403 : 409;
  }
  const body = JSON.stringify({
    error: err.message,
    code: err.code ?? (status === 404 ? "not_found" : "internal_error")
  }, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
