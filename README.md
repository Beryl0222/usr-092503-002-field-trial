# 山野装备实测调度服务

面向户外品牌联合高海拔实测的调度与可追溯服务。出发前登记人员资质、小队能力、
路线分段、装备唯一编号与品牌不可见指标，按能力/互斥规则生成领用计划；现场
统一处理装备并发领用、离线观察、风险冻结与独立复核；活动后输出组织/品牌双口径
可追溯报告。

## 设计要点

- **事件溯源**：所有变化都是 append-only 事件（`data/events.log`，JSONL），内存状态
  只由事件归约得到；进程重启重放日志即可完整接续。
- **串行事务**：所有写命令走同一 Promise 队列，读状态→校验→落盘→归约之间无交错，
  因此装备并发领用必然是"第一个成功、第二个 409 被拒"。
- **离线归并**：观察以 `clientId`（或确定性指纹）幂等；重复与分片补传字段级合并，
  乱序上传按"事实时间"落在小队当时所在路段（`TEAM_SEGMENT_PROGRESS` 时间窗）。
- **安全优先**：风险信号达到 STOP/EVACUATE 阈值即在同事务自动冻结受影响路段与样品
  （碎石下坡连下游、装备失效连同互斥组备选）；冻结中的领用/转交/归还返回 `423` 被抢占。
- **独立复核**：恢复（resume）/终止（terminate）只能由配置的独立安全员完成。
- **保管链唯一**：一件样品一条链，损坏、转交、退出、紧急撤离全部追加到同一链。
- **数据采纳口径**：只采纳完整性检查通过且在冻结生效前/冻结窗外的观察；终止路段
  生效后数据一律排除。
- **隐私双口径**：健康指标强制 `brandVisible=false`；品牌报告去除人/队身份与坐标精轨，
  但保留 `observationId`，可经组织端落回原始观察，反向拿不到参与者身份。

## 目录

- `src/index.js` — 事件类型、风险等级、实体编号与指标可见性契约
- `src/domain/model.js` — 初始状态与事件归约（纯函数）
- `src/domain/rules.js` — 计划引擎、路段归属、阈值、影响面、完整性、报告投影
- `src/store/eventStore.js` — JSONL append-only 事件日志
- `src/service/dispatchService.js` — 命令校验、串行事务、冻结联动、双口径查询
- `src/http/server.js` — 零依赖 HTTP API
- `src/cli.js` — 管理命令（serve / export-report / replay-info）
- `test/contracts.test.js` — 公共契约稳定性
- `test/e2e.test.js` — 单次自动化验证（含真实重启与独立进程导出）

## 开发命令

```bash
npm test          # 契约 + 端到端（并发拒领/离线去重/冻结抢占/重启接续）
npm run build     # 全部源文件语法检查
```

## HTTP API

写操作为 JSON POST；身份通过请求头 `x-actor-id` / `x-actor-role` / `x-actor-token` 传递。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/register/people` | 登记人员与资质 |
| POST | `/register/teams` | 登记小队能力与成员 |
| POST | `/register/teams/members` | 队员入队 |
| POST | `/register/segments` | 路线分段（地形/海拔/ hazards） |
| POST | `/register/samples` | 装备唯一编号（互斥组/资质要求） |
| POST | `/register/metrics` | 观察指标（健康类强制品牌不可见） |
| POST | `/teams/:id/progress` | 小队进入/离开路段时间窗 |
| POST | `/plans` | 生成领用计划（含未能满足的冲突清单） |
| GET  | `/plans/:id` | 查计划 |
| POST | `/custody/check-out` | 领用（与计划不符/在持/冻结 → 409/423） |
| POST | `/custody/transfer` | 转交（同一条链） |
| POST | `/custody/damage` | 损坏登记 |
| POST | `/custody/withdraw` | 退出 |
| POST | `/custody/evacuate` | 紧急撤离 |
| POST | `/custody/return` | 归还 |
| GET  | `/custody/:sampleOrChainId` | 查保管链（"当时谁在用"） |
| POST | `/observations` | 上传位置/环境/装备体验（幂等去重、自动归段） |
| POST | `/risk-signals` | 风险信号（达阈值同事务自动冻结） |
| POST | `/freezes` | 组织者/安全员手动冻结 |
| POST | `/freezes/:id/review` | 独立安全员 resume / terminate |
| GET  | `/reports/organization` | 组织全量报告（含健康 restricted 分区） |
| GET  | `/reports/brand` | 品牌脱敏报告 |
| GET  | `/trace/:observationId` | 品牌凭 observationId 落回原始观察（去身份） |

## 管理命令

```bash
node src/cli.js serve --dir ./data --port 8080
node src/cli.js export-report --dir ./data --view organization --out org.json
node src/cli.js export-report --dir ./data --view brand --out brand.json
node src/cli.js replay-info --dir ./data
```

## 自动化验证覆盖

`test/e2e.test.js` 在一次 `npm test` 中重现：

1. 同一样品的两个并发领用：201 与 409（`sample_in_use`）；
2. 离线/重复/乱序观察归并为同一事实，并按行进时间窗归到正确路段；
3. STOP 信号自动冻结，普通转交/领用返回 423 被抢占，损坏等事实记录仍可延续，
   非安全员复核被拒，安全员 resume 后放行；
4. 关闭 HTTP 服务后以同一数据目录重启，重放事件，保管链/计划无损并可继续上传；
5. 双口径报告：健康数据不进品牌结果，品牌可凭 `observationId` 溯源但无法反查身份。
