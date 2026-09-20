# 架构

[English](../architecture.md) · [中文文档索引](README.md)

Figma Agent Control 让 Agent 从本机 CLI 提交可信的 Plugin API 脚本，在 Figma Desktop 开发插件中执行。绑定文件必须在 Design 模式下打开，写入需要编辑权限；Agent 需要 shell 和 localhost 访问能力。

脚本获得当前文件的完整 `figma` 对象。绑定定义有效任务目标，选中的目标定义快照与画面检查的覆盖范围。系统协调可信自动化并持久化执行证据。

[协议](protocol.md)定义字段、文件和退出码，[使用指南](agent-guide.md)说明操作与恢复。模块地图链接到负责实现的源文件，不依赖会随注释变化而漂移的行号。

## 进程与信任边界

| 部分 | 职责 | 边界 |
|---|---|---|
| CLI | 解析输入、提交任务、读本机证据、运行主机分析 | 不直接与插件通信 |
| 桥接 | 校验、串行调度、持久化和恢复任务 | 不访问 Figma 文档 |
| iframe | 网络中继、连接/确认/状态面板 | 不能访问文档 |
| 执行端 | Plugin API、快照、脚本、读取和导出 | 不发送 HTTP，通过 iframe 中继 |

### 凭证与版本

[bridge.mjs](../../src/bridge.mjs)按路由区分 CLI 和插件角色，各自只接受自己的凭证。CLI 凭证每次桥接启动重新生成，存在权限为 `0600` 的项目 session 文件中。插件凭证经 [session.mjs](../../src/session.mjs)独占创建，保存在全局 pairing 文件并注入 iframe。

iframe 在接受确认或结果前，逐条核对任务 ID 和随机 nonce。

### 本机存储

[project.mjs](../../src/project.mjs)定义两个根目录：

- `<project>/.figma-agent-control/`：绑定、当前会话、锁、持久任务、恢复记录和比较证据。当前工作目录就是项目，不向父目录查找。

- `~/.config/figma-agent-control/`，或 `FIGMA_AGENT_CONTROL_HOME`：共享插件凭证和生成的开发插件文件。

`connect` 是装配点：取配对凭证、启动桥接、安装生成文件。桥接只返回文件内容，不自行写全局插件目录。安装只改写内容变化的文件，减少无意义热重载；安装失败先关闭桥接。

## 模块结构

主机侧依赖无环。完整成员清单见 [src/AGENTS.md](../../src/AGENTS.md)、[src/html/AGENTS.md](../../src/html/AGENTS.md)、[plugin/AGENTS.md](../../plugin/AGENTS.md) 和 lib/AGENTS.md。

`project` 不依赖内部模块；`connection` 是时钟可注入的纯内存状态；`png` 只用 zlib。桥接与 HTML 不互相 import：bridge/record 仅在 JSDoc 中引用共享 extract 类型。HTML 经 client 提交、经 record 读回。两侧共用的中断原因放在 session，避免循环依赖。

### 主机侧职责

| 模块 | 职责归属的原因 |
|---|---|
| [args](../../src/args.mjs) | 一份命令表生成用法和分派元数据；重复的单值选项在写入目标被静默替换前拒绝 |
| [client](../../src/client.mjs) | 统一 HTTP 边界，将权限拦截、拒绝连接和超时映射为不同处置 |
| [bridge](../../src/bridge.mjs) | 单一状态所有者执行在途任务、请求身份、写前日志、完成和未知写入不变量 |
| [connection](../../src/connection.mjs) | 租约不需要文件或 HTTP，注入时钟让过期测试确定 |
| [session](../../src/session.mjs) | 配对、锁接管和启动修复跨越进程生命周期，不属于瞬时桥接状态 |
| [record](../../src/record.mjs) | 所有读取方共用证据、摘要、退出码和下一步解释，等待从不重提 |
| [doctor](../../src/doctor.mjs) | 桥接不可达时仍可只读诊断绑定、锁和安装问题 |
| [report](../../src/report.mjs) | 只聚合完成证据，不改会话或任务状态 |

## 关键流程

### 连接

`init` 解析 Figma URL 并写绑定格式 2。`connect` 取单实例锁、修复中断证据、启动本机 HTTP、写当前会话并安装共享插件。iframe 先取得文件 key，再探测桥接，提交角色凭证和版本。匹配的实例取得租约和绑定元数据。

稳定连接后，poll 最长挂起十秒，靠网络回调立即续接，面板隐藏仍可及时领取。首次/重试计时器和 Figma 宿主调用仍可能被不可见窗口或后台文件节流。前台/后台租约为 15/90 秒。进行中的写入不能悄悄交给其他插件，中断的读取则可放弃并重提。

### 一次 run

```text
CLI 提交 -> 桥接校验并持久化 queued
         -> 先持久化 running，再交付
         -> 插件编译并核验目标
         -> 前快照 -> 可选确认 -> 持久写前日志
         -> 目标复核 -> 前图
         -> Undo 边界 -> 脚本 -> Undo 边界
         -> 后快照/图与序列化
         -> 桥接落文件 -> 原子 result.json
         -> CLI 从证据生成摘要
```

脚本结果与证据可用性分开：脚本已完成，但后快照可能不可用、画面预期可能不满足。这些都不能成为重放理由。

### 等待与恢复

CLI 观察证据文件等待结果，等待前先向 stderr 写任务 ID。终端或工具结束等待进程后，可再次用 `wait` 读取同一份证据。requestId 标识不可变任务；同一 ID 的重复提交返回原任务结果。

`result.json` 是提交点。从未交付的 queued 任务可证明未执行；已交付而无结果的 run 是未知状态，会阻止新 run。内置读操作保持可用，以便先检查目标。resolve 要求当前会话直接 inspect 原目标，并确认旧插件停止；它结束等待，不虚构成功，也不撤销。

恢复任务仍可接受迟到结果。其他项目的结果收到 `FOREIGN_JOB`，留在 iframe 等原桥接回来。诊断优先处理它，避免通用的“重启插件”建议丢掉真实结果。

### 提取与 HTML

依赖背景的效果需单独处理，因为 SVG 不含底层场景。自动孤岛会避开它们；主机也独立否决不安全的内联，除非 override 显式要求。参考图烘焙不同：它冻结完整矩形内的可见内容，必须持续作为限制报告。

## 类型检查与测试

运行时直接执行 `.mjs`/`.js` 源码，JSDoc 由锁定版本的 TypeScript 和 typings 检查。VM 测试与 Figma 安装使用同一份源码字节。

| 环境 | 范围 |
|---|---|
| [主机 tsconfig](https://github.com/n3phable/figma-agent-control/blob/main/tsconfig.json) | Node 模块与共享提取契约，不注入 Figma 全局 |
| [插件 tsconfig](../../plugin/tsconfig.json) | 带 Figma 全局的经典脚本 main/extract，不允许 Node API |

[提取契约](../../src/html/extract-contract.d.ts)区分插件字节、传输占位和落盘文件。外部 JSON 和动态 API 字段仍需断言，类型不能单独验证真实 Figma 行为。可选 `node tests/contract-samples.mjs <runs-directory>` 检查明确提供的提取证据，不需要或附带私有语料。

## 提取实现位置

只读提取在 plugin/main.js 内实现，并共享文档读取辅助函数。

## 浏览器比较层

主机可通过 Chrome 调试管道渲染 HTML，并与给定参考 PNG 比较像素。此阶段通过比较模块 API 使用该能力。

## HTML 模块

- match 比较解码后的 PNG 像素，使用 YIQ 差异和抗锯齿处理。
- fonts 读取本地字体名称和度量，供渲染流程使用。
- css 把提取的绘制、几何和文字属性映射为 CSS，不执行 I/O。
