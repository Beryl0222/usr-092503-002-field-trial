# 山野装备实测调度服务

为户外品牌联合的高海拔装备实测提供登记、领用计划、现场观察归并、安全冻结与可追溯报告。
全程事件溯源：所有操作只追加到带哈希链的 JSONL 日志，进程重启后重放即可接续，任何篡改都会在校验时暴露。无外部依赖，仅使用 Node.js 内置模块。

## 领域模型

- **人员资质**：每人带资质集合（如 `alpine`、`safety_officer`），退出/撤离后失活。
- **小队**：成员、能力资质、容量；同一成员跨小队重复占用会在计划中标为冲突。
- **路线分段**：有序路段，带起终点坐标与地形；观察按 GPS 投影归因到路段，与上传顺序无关。
- **装备唯一编号**：每件样品带品牌、互斥组 `mutexGroup`、所需资质；持有状态沿一条保管链演进。
- **观察指标**：`environment` / `gear` / `location` / `health` 四类。`health` 对品牌强制不可见。
- **安全冻结**：阈值命中（STOP/EVACUATE）或人工上报即冻结受影响路段与样品，普通操作返回 `423`；恢复或终止必须由**持安全员资质且非上报人本人**的独立复核完成。

## 关键规则

| 场景 | 规则 |
| --- | --- |
| 领用计划 | 所需资质、互斥组不进同队、小队容量；无法安排的样品与重复占用人员列入 `conflicts`，出发前可见 |
| 并发领用 | 写命令在串行临界区内“检查→追加”原子完成，同一装备第二个领用得 `409` |
| 离线/乱序/重复 | 以设备 `clientId`（或人+指标+样品+时刻+值的内容键）去重，补传归并为同一事实 |
| 路段归因 | GPS 投影到最近路段走廊，超出走廊宽度仍归因但标记 `outsideCorridor` |
| 安全冻结 | 冻结优先抢占一切普通操作（`423`）；终止后路段永久封闭，恢复后解除 |
| 保管链 | 出库/转交/损坏/归还/退出/撤离交接全部挂在同一条 `custody` 链上，不允许跳跃 |
| 汇总口径 | 只采纳通过完整性检查、且不落在冻结区间/终止之后的事实 |
| 品牌报告 | 人员/小队用 HMAC 假名，无健康数据，无原始 ID；每条结论带 `observationId` 与来源哈希，可落回原始观察但无法反查身份 |

## 目录

```
src/
  index.js     事件类型、风险等级、观察类别、标识校验（公共契约）
  errors.js    领域错误与 HTTP 状态码
  crypto-util.js  规范化哈希 / HMAC 假名
  geo.js       GPS 路段归因
  store.js     哈希链 JSONL 事件存储 + 串行临界区
  projection.js 纯函数事件投影（重放重建状态）
  service.js   领域命令（登记/计划/保管/观察/风险/复核）
  reports.js   组织者可追溯报告 + 品牌脱敏报告
  api.js       node:http 的 JSON API
  cli.js       serve / export / custody / replay 管理命令
test/
  contracts.test.js  契约稳定性
  scenario.test.js   单次自动化验证（见下）
```

## 开发命令

```bash
npm test     # node:test 全量测试
npm run build
```

## 启动服务

```bash
node src/cli.js serve --event-file ./data/events.jsonl --port 8080 [--tokens ./tokens.json]
```

令牌文件形如：

```json
{
  "org-secret":   { "role": "organizer" },
  "safety-secret":{ "role": "safety" },
  "member-secret":{ "role": "member" },
  "aurora-secret":{ "role": "brand", "brand": "Aurora" }
}
```

未提供令牌文件时使用一组开发令牌（见 `src/cli.js`），仅限本地。
请求带 `Authorization: Bearer <token>`；写操作可带 `Idempotency-Key` 实现命令幂等，需要固定事件时刻时带 `X-Observed-At`。

## HTTP API

| 方法 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /register/person|team|segment|sample|metric` | organizer | 资源登记 |
| `POST /plan` | organizer | 生成领用计划与冲突清单 |
| `POST /custody/checkout|transfer|damage|return|exit|evacuate` | organizer, member（evacuate 含 safety） | 保管链操作 |
| `POST /observations` | organizer, member | 上传观察（自动去重、归因、阈值冻结） |
| `POST /risk` | organizer, member, safety | 人工风险上报（STOP/EVACUATE 触发冻结） |
| `POST /freezes/resolve` | safety | 独立复核：`{"decision":"restore|terminate"}`，上报人本人被拒 |
| `GET /custody/:sampleId` | organizer, safety | 查看某件样品的完整保管链 |
| `GET /reports/organizer` | organizer | 完整可追溯报告（含健康数据、采纳/排除明细、哈希头） |
| `GET /reports/brand/:brand` | brand（限本品牌）/ organizer | 脱敏品牌报告 |

错误码：`400` 校验失败、`403` 无权/资质不足/非独立复核、`404` 不存在、`409` 并发冲突或状态冲突、`423` 安全冻结抢占。

## 管理命令

```bash
node src/cli.js replay  --event-file ./data/events.jsonl           # 哈希链完整性校验
node src/cli.js custody --event-file ./data/events.jsonl --sample g1
node src/cli.js export  --event-file ./data/events.jsonl --report organizer [--out o.json]
node src/cli.js export  --event-file ./data/events.jsonl --report brand --brand Aurora [--out b.json]
```

## 单次自动化验证

`test/scenario.test.js` 在一个测试内重现完整活动：

1. 登记资质/小队/分段/唯一装备/品牌不可见指标；
2. 生成计划并暴露资质与互斥冲突；
3. **并发领用同一装备被拒**（201 + 409）；
4. **离线乱序、重复补传归并**为同一事实并正确归因；
5. 健康阈值触发后**安全冻结抢占普通操作**（423），独立安全员复核恢复；
6. 人工上报 → 终止复核，终止后数据不采纳；
7. **以 CLI 子进程重启服务，重放日志接续小队**，紧急撤离延续同一条保管链；
8. 组织者报告通过完整性检查并排除冻结区间数据；
9. **品牌报告可凭 `observationId` 落回原始观察、哈希一致，但不含姓名/原始 ID/健康字段**；
10. 篡改日志任意一行，重放立即报完整性错误。
