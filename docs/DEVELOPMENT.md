# 开源 Beta 开发说明

基线：0.1.0-beta.1。本文只描述本仓库功能。

## 1. 模块和结构

| 目录 | 职责 |
| --- | --- |
| src/main.jsx | 登录、概览、事件、批量建单、富文本和配置 |
| src/campaigns.jsx | 专项、子待办、关联、证据、标签、历史 |
| src/campaign-period.jsx | 主单双月日期区间 |
| src/batch-xlsx.js | XLSX 模板与解析 |
| server/app.mjs | 数据库初始化、鉴权、事件、手动附件、本地统计 |
| server/report.mjs | 表单规范化、风险关系和日期 |
| server/campaigns.mjs | 专项与任务状态机、关联、统计贡献 |
| server/campaign-assets.mjs | 私有专项证据和删除引用同步 |
| server/campaign-types.mjs | 共享类型标签 |
| server/campaign-migration.mjs | 兼容字段增量迁移 |
| server/reporting-api.mjs | 入站文本上报、多密钥、幂等 |
| shared/model.mjs | 事件类型、自然周期、50 个本地字段 |
| shared/owners.mjs | 负责人统一校验 |
| scripts/ | 初次配置、公开源码检查及源码打包 |
| tests/ | 临时数据库测试 |

React 前端由 Vite 构建，生产 Express 同时提供静态资源和 API。数据存储为 SQLite WAL，附件放私有数据目录。所有下载需登录。没有后台对外推送服务或外部日志客户端。

## 2. 公共规则

时间统一按 Asia/Shanghai 展示。无时区 ISO 时间解释为 UTC+08:00，入库转 UTC ISO。验证真实日历日期，保留秒。

负责人接受字面值 `admin` 或有效邮箱，最长 254 字符。个人事件双方负责人各 1–20 人，去空白并去重。专项总负责人和待办跟进负责人各一名。网页新建事件、批量新行及专项总负责人默认 admin；事件负责人和任务负责人由用户指定。

默认管理员为本地体验配置。密码使用 scrypt 和随机盐；会话原文仅放在 HttpOnly、SameSite=Strict Cookie `trace_session`，数据库只存摘要。会话默认 8 小时，退出立即失效。修改环境密码重启会更新密码并清理原会话。当前没有用户管理或按负责人授权。

## 3. 个人事件

### 字段

| 字段 | 类型与要求 |
| --- | --- |
| event_type | DLP、EDR、HIDS、REG、FB、RASP、WAF、SAST、DAST、MAIL、TI |
| discovered_at | 必填 ISO 时间，默认当前 |
| security_risk | 必填 boolean |
| security_incident | 必填 boolean，true 要求风险 true |
| security_violation | 必填 boolean，true 要求事件 true |
| security_red_line | 必填 boolean，true 要求违规 true |
| severity | 仅红线必填 P0–P4，其他新记录 null |
| security_owners | 必填数组，默认 ["admin"] |
| incident_owners | 必填数组 |
| description_html | 可空 HTML，最大 2 MiB |
| redline_confirmation_asset_id | 红线可选，图片或 PDF |
| campaign_links | 可选，整个关联集合 |

五种最高层级：logs、risks、incidents、violations、red_lines。服务端从四级布尔值推导，不接受客户端直接指定统计。个人事件没有跟踪／完结状态。

标题按上海发现月份自动生成 `YY-MMM-TYPE-NNNN`，同月所有类型共用序号。同月编辑保留序号，跨月重分配；稳定 event_id 不变，格式 EVT-日期-随机值。

列表支持关键词、类型、安全负责人精确匹配、最高层级、上海日期起止、重要程度或时间排序。结束日包含整天。默认 20 条，上限 100。

删除接口接收 IDs，最多 100，事务中解除专项关联、解除附件表绑定、删除事件，更新当前统计。附件仍需单独删除，历史统计快照不变。

### 批量

模板列：发现时间、事件类型、安全负责人、事件负责人、安全风险、安全事件、安全违规、安全红线、事件等级、详细内容。文件最大 5 MiB、最多 100 条，每行完整独立。支持 Excel 1900/1904 日期系统。多人可用换行、逗号、顿号或分号分隔。

导入纯文字，不执行 HTML，不导入附件。红线必填等级，普通事件等级留空。任一行非法整批回滚。前端给出错误行号；导入后可修改再确认保存。

## 4. 专项与任务

主专项包含：

- 自动编号及名称 `YY-MMM-SPC-NNNN`，保存后稳定。
- 总负责人 lead_owner，默认 admin。
- 整体目标 target_scope，默认全公司。
- 共享类型标签，默认漏洞修复、入侵应急、监管检查。
- importance：P0 最高至 P4 最低，默认 P2。
- occurred_at → due_at 完整区间，两项必填，发现时间不能未来，结束不能早于开始。
- 一个 description_html 富文本，统一写背景、目标、情报引用等，可空。
- status：tracking 或 completed，version 整数乐观锁。

主单日期用双月日历，先起点再终点，应用生效，取消不改原值。精确时间可展开调整，没有完成时间待定选项。

待办一行一个，字段为名称、负责人、状态、优先级、选填截止、可选明细。独立编号为主单编号加 T001；最多 100 个有效任务，删除不复用序号。优先级 high/medium/low 默认 medium。

**子待办没有开始日期。** 截止留空存 null，可清空，不继承也不跟随主单时间。允许已过期日期，不强制落入主单区间。空明细、空日期均可创建、完结、重开。

行内编辑只提交名称、负责人、优先级和截止，不清空隐藏历史字段。完整详情可编辑正文和证据，跟踪记录需有文字或附件。待办列表只保留表格下方一个“添加任务”入口。

状态约束：

1. 任一有效任务仍跟踪时，主单不能完结；接口及数据库触发器双重保护。
2. 所有任务完成后主单仍跟踪，需主动完结；无任务也可完结。
3. 点击完结直接执行，不强制输入结论。
4. 已完结主单及任务编辑内容前先重开。
5. 已完结主单下新增／重开任务需明确 reopen_campaign=true，父子在同一事务重开。
6. 待办“已完结 → 跟踪中”直接保存，无备注表单；若主单也已完结，只确认是否同时重开主单，无需填写说明。操作者及时间保留历史。主单独立重开时原因仍选填。
7. 删除主单或任务逻辑隐藏，保留证据及历史；主单删除解除事件关系，不删除个人事件。

类型标签可新建、重命名、删除，名称不重复、最多 40 字、最多 100 活动标签。删除前确认引用数量，version 和 usage_count 不符返回 409。引用专项改为待定，统计不变；重启不复活默认旧标签。

## 5. 双向关联

个人事件和专项多对多，(campaign_id,event_id) 唯一。支持从事件建立改进专项，也可专项关联已有事件。

| relation | 意义 | note |
| --- | --- | --- |
| risk_source | 风险来源／利用入口 | 必填，最多 5000 字 |
| post_incident | 事件后改进 | 选填 |
| related | 相关排查 | 选填 |

confidence：pending 待确认、confirmed 已确认、not_confirmed 已排除。关联不等于确认因果，不自动改等级，不重复计数。已完结专项调整关联前须重开。个人表单省略 campaign_links 表示保留，空数组表示尝试解除全部。

候选专项可按编号或正文中的 CVE、组件、业务关键词检索，最多返回 30 个。当前名称等于自动编号，使用 search_text 支持正文检索。

## 6. 证据与富文本

支持图片 PNG/JPG/GIF/WEBP、PDF、ZIP、DOC/DOCX、UTF-8 TXT，单份最大 20 MiB。红线确认书只接受图片/PDF，最大 10 MiB。校验文件扩展名、MIME 及关键文件头；文件私有存储，下载先鉴权。

富文本清理脚本、事件属性、危险协议和外部图片；只允许本模块有效附件路径。专项证据严格绑定主单或任务，不能跨任务、跨专项引用。上传即时保存，取消编辑不撤销文件上传，可手动管理。

删除专项文件时：保留删除元数据、物理删除文件、正文及历史引用替换为删除占位、更新搜索索引和版本，保留审计。备份不会自动清除。

个人新建取消可能留下未绑定文件，Beta 无自动回收任务。没有恶意文件扫描；上传证据始终作为不可信文件处理。

## 7. 本地统计

指标：logs、risks、incidents、violations、red_lines、redline_p0–redline_p4。

周期：all、year、half-year、quarter、month，共 50 项，均非负整数。自然周期起点按上海时区，按发现时间统计，排除晚于统计时刻记录。

- 具体事件最高层级以及之前所有层各 +1。
- 红线在相应等级互斥分支再 +1。
- 任意未删除专项为 logs、risks、incidents 各 +1，与专项重要级别及状态无关。
- 子任务、关联为 0；专项不增加违规、红线或任何红线等级。
- 后端冻结完整 50 值，后续编辑／删除不改变历史快照。
- 默认漏斗开关只影响展示及系统层启用，不删除业务或快照；系统 50 层禁止改删。

例如 1 个 P0 专项加 1 条普通 HIDS 安全事件，无论有多少任务或两者是否关联，logs_all、risks_all、incidents_all 各为 2，redline_p0_all 为 0。

## 8. HTTP 接口

除健康、登录及独立 Bearer 上报外均需 Cookie。错误 JSON 为 `{error}`；400 校验，401 未登录，403 禁止，404 不存在，409 版本／状态／幂等冲突，413 过大。

### 登录与事件

| 方法 | 路径 | 主要内容 |
| --- | --- | --- |
| GET | /api/health | 状态和 Beta 版本 |
| POST | /api/auth/login | username,password |
| GET | /api/auth/me | 当前账号 |
| POST | /api/auth/logout | 退出 |
| GET | /api/overview | period，50 值及贡献拆分 |
| GET | /api/events | search,stage,severity,event_type,security_owner,occurred_from,occurred_to,sort,page,page_size |
| GET | /api/events/options | 类型和负责人候选，含 admin |
| GET | /api/event-form | 表单元数据 |
| GET / PUT | /api/events/:id | 详情／完整修改 |
| POST | /api/events | 完整单条表单 |
| POST | /api/events/batch | reports 数组 |
| DELETE | /api/events | `{ids:[1,2]}` |
| POST | /api/event-assets | 二进制，X-File-Name/X-File-Type；确认书 X-Asset-Purpose=redline-confirmation |
| GET | /api/event-assets/:id/download | 私有预览／下载 |
| DELETE | /api/event-assets/:id | 删除手动文件 |

### 专项

| 方法 | 路径 | 主要内容 |
| --- | --- | --- |
| GET | /api/campaigns/options | 负责人、类型候选 |
| GET / POST | /api/campaigns | 筛选列表／建立主单，可带 tasks/events |
| GET / PUT / DELETE | /api/campaigns/:id | 读取、带 version 编辑或逻辑删除 |
| GET / POST | /api/campaigns/:id/tasks | 筛选任务／新增 |
| GET / PUT / PATCH / DELETE | /api/campaigns/:id/tasks/:taskId | 详情、完整、行内、删除 |
| POST | /api/campaigns/:id/status | version,status,reason? |
| POST | /api/campaigns/:id/tasks/:taskId/status | version,status,reopen_campaign? |
| GET / POST | /api/campaigns/:id/updates | before 游标／body_html 或 body |
| POST | /api/campaigns/:id/tasks/:taskId/updates | 任务跟踪 |
| GET / POST | /api/campaigns/:id/assets | 附件，X-Task-Id 可选 |
| GET | /api/campaign-assets/:id/download | 私有证据 |
| DELETE | /api/campaign-assets/:id | 删除证据及引用 |
| POST | /api/campaign-types | name |
| PUT | /api/campaign-types/:id | name,version |
| DELETE | /api/campaign-types/:id | version,usage_count |
| GET | /api/events/campaign-options | search 候选 |
| GET | /api/events/:id/campaigns | 已关联 |
| PUT / DELETE | /api/campaigns/:id/events/:eventId | relation,confidence,note／解除 |

### 配置、本地快照及上报 API

| 方法 | 路径 | 主要内容 |
| --- | --- | --- |
| GET / PATCH | /api/model | 本地漏斗，enabled |
| POST | /api/snapshots | 冻结后端计算值 |
| GET | /api/snapshots/:id | 读取固定值 |
| GET | /api/funnels/custom/layers | 兼容层读取，无编辑页面 |
| DELETE | /api/funnels/layers/:id | 系统层拒绝 |
| GET / PATCH | /api/reporting/config | enabled |
| GET / POST / DELETE | /api/reporting/keys | 列表、name/tags 创建、清空 |
| PATCH / DELETE | /api/reporting/keys/:id | 元数据编辑／删除 |
| POST | /api/reporting/keys/:id/copy | 按需解密令牌 |
| POST | /api/reporting/keys/:id/rotate | 换新令牌 |
| GET | /api/reporting/skill | 下载调用说明 |
| POST | /api/v1/events | 独立 Bearer 纯文本入站 |

所有外部看板、远程日志及自动下载路径均没有注册，登录后也返回 404；不通过隐藏按钮保留后门入口。

## 9. 文本上报

完整示例见同目录 `skills/report-security-event/SKILL.md`。description_text 必填、最大 256 KiB，只允许固定字段，不接收附件、HTML 或专项关联。severity 仅红线填。

幂等 key 全局唯一：第一次 201，同 key 同内容 200 replayed，不同内容 409。删除个人事件也删除该条幂等记录。无需后台外发能力。

令牌摘要用于认证，AES-256-GCM 加密值用于管理员按需复制。主密钥为数据目录中的随机 32 字节文件。最后一个密钥删除后关闭 API。令牌名／标签不构成权限范围。

## 10. 事务、迁移与数据表

主要表：

```text
users, sessions, records, event_assets, settings, layers, snapshots,
reporting_api_keys, api_reports,
security_campaigns, security_campaign_tasks, security_campaign_updates,
security_campaign_event_links, security_campaign_assets,
security_campaign_types, security_campaign_type_updates
```

批量保存、专项及初始任务、父子重开、标签同步、事件关系替换、API 幂等写入均在事务中完成。网络请求不在数据库事务中执行。

专项及任务 version 防并发覆盖；附件也会增加版本，前端要采纳新版本。个人事件 Beta 暂无乐观锁。迁移增量且幂等，不给历史空任务日期补造值。

Beta 使用自己独立数据库，仅面向空白部署和本仓库后续版本，不提供导入其他系统数据库的迁移承诺。源码打包排除所有运行数据。

## 11. 验收

1. 空环境 npm ci/build/start 成功，新建安全负责人为 admin 并能保存。
2. 11 类型手动建单、四级依赖、红线等级、编辑、搜索筛选和删除。
3. XLSX 包含 admin，空描述、多人、日期系统、非法行整批回滚。
4. 专项起止区间，子待办空截止可创建／编辑／清空，父日期修改不影响子项。
5. 父子完结约束、空明细完结、联动重开、版本冲突、逻辑删除及证据保留。
6. 标签增改删、引用数冲突、重启不复活默认旧名。
7. 事件关系双向查看，来源说明、确认状态、不影响计数。
8. 文件类型大小、鉴权、跨专项归属、删除同步。
9. 本地 50 指标、上海周期边界、未来排除、冻结快照。
10. 入站 API 多密钥、幂等、轮换、删除；移除的接口均 404。
11. 公开材料无业务数据库、环境凭据、私有文件、原生 OCR 依赖或第三方业务地址。

运行 `npm test && npm run build && npm run check:release`。页面验证建议在 Microsoft Edge 中完成桌面与手机流程，使用独立测试数据。
