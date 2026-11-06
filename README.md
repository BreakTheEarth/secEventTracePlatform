# Trace · Security Operations Beta

自托管的安全运营事件与专项管理平台。开源 Beta，MIT License。

Self-hosted security event and campaign management. Manual records, investigation tasks, evidence, and local risk analytics. No vendor account or corporate network is required.

## 可以做什么

- **个人事件**：DLP、EDR、HIDS、监管通报、人工反馈、RASP、WAF、SAST、DAST、MAIL、威胁情报等手动填报。
- **风险研判**：安全风险 → 安全事件 → 安全违规 → 安全红线逐级判定，红线 P0–P4。
- **批量建单**：页面逐行录入、下载 XLSX 模板、导入，每次最多 100 条。
- **安全专项**：群体范围、总负责人、P0–P4 重要级别、完整时间区间、可管理类型标签。
- **子待办**：独立负责人、跟踪／完结、优先级、选填截止日期、行内编辑、富文本明细与历史。
- **事件关联**：个人事件与专项双向关联，区分风险来源、事件后改进、相关排查及确认情况。
- **证据管理**：图片、PDF、ZIP、Word、TXT；红线确认书；登录后下载，专项删除保留历史。
- **本地漏斗**：10 类指标 × 5 个自然周期，上海时间；支持本地冻结快照。
- **文本上报 API**：独立密钥管理、单条纯文本事件、幂等重试。

安全负责人默认 `admin`，专项总负责人同样默认 `admin`；也可填写有效邮箱。其他负责人可填写 `admin` 或有效邮箱。负责人字段表达业务分工，不代表已为该人员创建登录账号。

## 这个版本的范围

所有事件类型均为**手动记录**。DLP 保留为通用事件分类，未包含外部日志自动查询、日志 ID 绑定、自动登录、验证码 OCR、远端截图或原文件自动下载。仍可手动上传证据。

本地统计保留，未包含外部看板推送、推送目标配置或定时外发。应用运行不需要任何第三方业务连接凭据。

此项目使用独立空数据库，不是其他部署的升级包；不要把原有私有部署的数据库、配置、附件或备份导入公开仓库。

## 快速开始

需要 Node.js **22.13 或以上**及 npm。

```bash
npm ci
npm run build
npm start
```

首次运行自动生成 `.env` 并创建空数据库，访问：

```text
http://127.0.0.1:3001
```

本地体验账号：`admin` / `admin`。开发模式：`npm run dev`，无需提前构建。

如端口冲突，在 `.env` 修改 `PORT`。启动时只使用当前目录的配置和数据，不依赖其他项目。

## 部署与数据

正式使用前修改 `.env` 的 `ADMIN_PASSWORD`。需要其他机器访问时设置 `HOST=0.0.0.0`；HTTPS 反向代理下设置 `COOKIE_SECURE=true`。此版本是单管理员工作空间，没有员工权限隔离、审批或自动通知。

| 位置 | 内容 |
| --- | --- |
| `data/trace.sqlite` | 事件、专项、任务、历史、配置、本地统计 |
| `data/integrations/event-assets/` | 事件手动上传文件 |
| `data/integrations/campaign-assets/` | 专项与待办证据 |
| `data/integrations/reporting-api.key` | 文本上报密钥的加密主密钥 |
| `.env` | 监听地址、管理员配置 |

重启不清空数据。备份时先停止服务，再复制完整 `data/` 和 `.env`；SQLite 使用 WAL，服务运行中不要只复制单个 `.sqlite` 文件。密钥文件要和数据库一起备份。平台删除文件不会自动删除历史备份。

更新源码前备份，不要用发布材料覆盖 `data/` 或 `.env`。这个 Beta 没有打包原生运行时或自动线上升级器。

## 日期和统计的关键规则

- 主专项选择“发现时间 → 计划完成时间”完整区间。
- 子待办只有**选填截止日期**，可清空，不继承主单，也不会随主单改期。
- 每个有效专项贡献日志 +1、风险 +1、事件 +1。
- 子待办和关联不单独增加统计；专项 P0–P4 不计入红线 P0–P4。
- 具体事件和专项分别列表管理，只有统计合并。
- 专项剩余跟踪任务时不能完结；全部任务完成后主单仍需主动完结。
- 任务明细及重开原因选填；完结不强制填写结论。

## 开发和验证

```bash
npm test
npm run build
npm run check:release
```

测试使用临时数据库，涵盖事件、XLSX、专项、父子状态、关联、附件、统计、文本 API 及已移除端点。仓库 CI 在 Node.js 22 和 24 执行测试和构建。

```bash
npm run package:source
```

生成 `release/trace-security-operations-beta-0.1.0-beta.1.tar.gz` 及 SHA-256 文件。打包只使用源码白名单，排除数据库、配置、附件、依赖、截图和运行日志；不包含 `dist/`，接收者运行 `npm ci && npm run build`。

## 文档

- [开发说明与接口](docs/DEVELOPMENT.md)
- [GitHub 发布步骤](docs/PUBLISHING.md)
- [文本 API 调用说明](docs/skills/report-security-event/SKILL.md)
- [安全与部署边界](SECURITY.md)
- [贡献约定](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

项目基于 React、Vite、Express、SQLite、ExcelJS 和 sanitize-html。依赖保留各自许可证；本项目源码使用 [MIT License](LICENSE)。
