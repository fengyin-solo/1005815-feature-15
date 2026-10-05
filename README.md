# 城市排水防涝泵站运行与内涝处置管理平台

面向排水泵站台账、泵组运行、排水管网与检查井养护、水位雨量监测、内涝点处置、闸门调度与抢险队出动的一体化城市排水防涝运行管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 泵站台账 | `pumpstation` | 排水泵站 | 站名、所属片区、设计流量 |
| 泵组运行 | `pumprun` | 泵组运行记录 | 运行编号、所属泵站、泵组编号 |
| 排水管网 | `drainpipe` | 排水管段 | 管段编号、起点井号、终点井号 |
| 检查井维护 | `manhole` | 检查井 | 井编号、所属管段、井盖状况 |
| 管网清淤 | `dredge` | 清淤记录 | 清淤编号、清淤管段、淤积厚度 |
| 水位监测 | `waterlevel` | 水位监测记录 | 监测编号、监测点位、水位读数 |
| 雨量监测 | `rainfall` | 雨量监测记录 | 监测编号、雨量站名、时段雨量 |
| 内涝点处置 | `waterlog` | 内涝点记录 | 内涝编号、内涝点位、积水深度 |
| 闸门调度 | `floodgate` | 闸门调度记录 | 调度编号、闸门名称、所属河渠 |
| 泵组检修 | `pumpmaint` | 泵组检修记录 | 检修编号、泵组编号、检修类别 |
| 拍门检修 | `sluice` | 拍门检修记录 | 检修编号、所属泵站、拍门编号 |
| 格栅清污 | `screen` | 清污记录 | 清污编号、所属泵站、格栅类型 |
| 排口巡查 | `outfallpatrol` | 排口巡查记录 | 巡查编号、排口名称、所在河段 |
| 防涝预警发布 | `floodwarn` | 预警单 | 预警编号、预警级别、影响区域 |
| 抢险队调度 | `rescueteam` | 抢险任务 | 任务编号、任务类型、目标点位 |
| 排水设备台账 | `drainequipment` | 排水设备 | 设备编号、设备名称、设备型号 |
| 管道内窥检测 | `cctvinspect` | 内窥检测记录 | 检测编号、检测管段、缺陷等级 |
| 排水调度方案 | `dispatchplan` | 调度方案 | 方案编号、方案名称、适用雨型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `drainage-pump:entries` 这一项，或调用 `resetModule(模块)`。

### 泵组检修期限口径（pumpmaint）

泵组检修的业务判断集中在 `frontend/src/api/pumpmaint-service.ts`，与通用模块解耦：

- **分类别设口径**：每个检修类别维护「检修周期（天）」与「允许顺延（天）」，默认三档
  日常保养 30+3、常规检修 90+7、大修 365+15，可在页面「期限口径」里调整并持久化
  （localStorage `drainage-pump:pumpmaint-rules`）。
- **工期上限落库校验**：计划工期（首尾都算的自然日）超过「周期 + 顺延」直接退回，
  退回信息写清超了多少天。
- **同泵排期冲突**：同一泵组编号、时间窗重叠且仍在挂（未完工）的两条安排，后来的那条
  必须先解决冲突才允许保存；已完工记录与不同泵组不拦。
- **唯一对 + 版本留档**：检修编号 + 泵组编号是唯一的一对，重复提交按最新版覆盖，
  旧版整体快照进「历史版本」只读留查。
- **单向完工**：状态只能 待开工 → 检修中 → 已完工；确认完工必须回填完成日期与更换部件。
- **超期重算**：超期天数 = 基准日 −（计划完工日 + 允许顺延天数），只对挂账记录计算；
  进入页面、保存口径时都会重算，也可在页面上手动「按口径重算超期」。

口径规则可在 Node 下离线验证（注入内存版 localStorage，不碰浏览器）：

```bash
cd frontend
npm run verify
```
