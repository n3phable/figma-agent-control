# 协议与证据

[English](../protocol.md) · [中文文档索引](README.md)

## 组件与数据流

```text
CLI --HTTP / CLI credential--> bridge <--HTTP / plugin credential + version-- ui.html
                                 |                                          |
                                 |                                     postMessage
                                 v                                          |
                    .figma-agent-control/                               main.js
                    binding, session, job evidence                          |
                                                                            v
                                                                      Figma document
```

插件的全部 HTTP 请求都经过 iframe。没有任务时，`/poll` 最多挂起十秒；任务到达后立即唤醒。挂起后返回的空响应带有 `X-Long-Poll`，触发下一次请求立即发起。这条由网络回调驱动的请求链避开了面板计时器节流。首次轮询、握手重试、普通心跳、结果回传重试、错误恢复和面板刷新还使用一个 750 ms 计时器。隐藏面板的计时器可能被大幅节流，因此重连可能比稳定连接后的轮询慢。执行端返回结果后，iframe 会立即回传。

## 项目目录

下表中的路径均相对于 `.figma-agent-control/`：

| 路径 | 写入方 | 契约 |
|---|---|---|
| `binding.json` | `init` | 格式号 `2`、文件 key、范围节点和来源 URL；拒绝其他格式 |
| `session.json` | 桥接 | 端口、每次启动生成的 CLI 凭证、会话 ID 和 PID；权限 `0600`；关闭时删除 |
| `bridge.lock` | 桥接/session | 锁持有进程的 PID |
| `runs/<job-id>/` | 桥接/session | 任务证据；目录权限 `0700` |
| `recoveries/<id>/` | session | 归档的陈旧锁与接管报告 |
| `diffs/` | `image-diff` | PNG 比对产物 |
| `check/<extract-job-id>/` | HTML 命令 | 渲染比对证据 |

只有检查 PID 返回 `ESRCH` 时，锁才被视为陈旧。接管时先独占创建 `bridge.lock.takeover`，复读原锁，只有内容未变才归档。空锁可能处于创建与写入 PID 之间：`connect`、无会话时的 `stop` 和 `doctor` 都把它视为已占用，绝不删除。存活的 PID 一律视为占用，即使操作系统可能复用了它；诊断会给出人工检查步骤。

`init` 会把证据目录加入项目的 `.gitignore`。证据可能包含设计数据和凭证，不能把它当作可分发的输出目录。

## 全局插件目录

共享目录为 `~/.config/figma-agent-control/`，可通过 `FIGMA_AGENT_CONTROL_HOME` 改写。

| 路径 | 写入方 | 契约 |
|---|---|---|
| `pairing.json` | `connect` 经 session | 持久化插件凭证，权限 `0600`；首次创建具有独占性；内容损坏时报 `PAIRING_INVALID` |
| `plugin/manifest.json` | `connect` | 生成的开发插件清单，含 `documentAccess: dynamic-page`、`enablePrivatePluginApi: true`，没有 Figma 分配的插件 ID |

由于清单没有 Figma 分配的 ID，私有 `setPluginData` 不可用。带命名空间的 `setSharedPluginData` 不依赖该 ID。

## 任务

### 提交：`POST /job`

调用方必须使用 CLI 角色。

| 字段 | 适用操作 | 约束 |
|---|---|---|
| `operation` | 全部 | `run`、`inspect`、`preview`、`variables` 或 `extract` |
| `code` | Run | 非空 JavaScript 函数体 |
| `libs` | Run | 最多 20 个 `{name, code}` 条目，UTF-8 合计不超过 2 MiB |
| `targetNodeId` | 全部 | 缺省为绑定节点；插件核验其属于绑定范围；extract 不能以页面为目标 |
| `snapshotDepth` | Run/inspect | `1`–`31` 的整数；显式限定快照深度 |
| `nodes` | Preview | 2–50 个不同节点；第一个必须等于实际目标 |
| `names` | Preview | 1–50 个不重复、非空且各不超过 200 字符的名称；与 `targetNodeId`、`nodes` 互斥 |
| `scale` | Preview/extract；带 expect 的 run | `0.1`–`4`；extract 的倍率只影响参考图 |
| `islands` | Extract | 1–500 个不重复的追加 SVG 导出节点 ID |
| `data` | Run | JSON，UTF-8 不超过 1 MiB，以 `data` 传入脚本 |
| `expect` | Run | `changed` 或 `unchanged` |
| `tolerance` | 带 expect 的 run | 非负的变化像素容许数；缺省 `0` |
| `risk` | Run | `{level:"high", reason}` 要求在插件面板确认 |
| `requestId` | 全部 | 用作任务 ID 的小写 UUID；CLI 在 `run` 上开放该参数 |

重复的 request ID 以 HTTP `200` 和 `reused:true` 返回原任务。绑定、操作、源码、库、目标、深度、nodes、倍率、data、实际生效的高风险原因、expect、tolerance、islands、cleanup 和 names 必须完全相同，否则返回 `400`。省略 cleanup 与显式 `false` 等价；省略目标与显式传入绑定节点不等价。`label` 不参与比较。该身份检查先于临时拒绝条件，因此即使断连或繁忙，重复请求仍可取回原任务。

| 新提交条件 | 响应 |
|---|---|
| 桥接正在关闭 | `409 BRIDGE_STOPPING` |
| 插件未连接 | `409 RECONNECTING` |
| 已有其他在途任务 | `409 ACTIVE_JOB` |
| 写入结果未知，且操作为 run | `409 REVIEW_REQUIRED`；内建读取仍可用 |

### Run 执行顺序

插件按以下顺序执行：

1. 核验文件 key 与编辑模式。

2. 把库与正文编译进嵌套函数作用域，先声明的库位于外层。语法错误对应 `executionStarted:false`。

3. 解析目标，并核验它属于绑定范围。目标不存在与越界分别报错。

4. 获取修改前快照，预算为 2,000 个节点。缺省深度为 32；没有显式声明的截断会拒绝 run。显式 `snapshotDepth` 允许有意缩浅证据。Preview、variables 和 extract 只快照根节点。

5. 高风险 run 最多等待面板确认 300 秒。拒绝或超时均不执行脚本。

6. 把写前检查点发送给桥接，原子保存 `before.json` 并固定其哈希。十秒内未收到回执则不执行。

7. 设置了 `expect` 时导出修改前图片。需要清理时，收集目标页已有节点 ID。目标不是页面时，记录页面根的直接子节点。

9. 提交 Undo 边界，监听目标页节点变化，进入脚本阶段，设置 `executionStarted:true`，求值库与正文，再提交结束 Undo 边界。边界失败会报错，不自动撤销。脚本失败时记录新建节点；若结束边界成功，可按选项清理这些节点。

10. 获取修改后快照，以及请求的修改后图片。成功且目标不是页面的 run 还会比较页面根子节点。修改后快照过大会使变更集不可用；修改后导出失败会使画面核验不可用，两者都不改变脚本自身的结果。

11. 序列化结果并提取嵌套二进制数据。大型插件消息使用下文定义的序列化封装。

可信脚本拥有当前文件的完整 Plugin API 访问能力。绑定定义有效目标，选中的目标定义快照、变更集和画面核验的覆盖范围。

### 二进制返回值

Run 与 extract 输出共用二进制通道。

- 嵌套输出中任意位置的 `Uint8Array` 等字节视图，以及完整的 PNG/JPEG 整数数组，都会被识别并替换为 `{"__figmaAgentControlBinary": index}` 占位。脚本自行返回这个保留键会导致任务失败。

- 一个 run 最多返回 200 个二进制项。包括修改前后画面图片在内，base64 总长度最多 48 MB。超过上限时，run 在执行后失败，不保留返回值，也不保存输出二进制；不得重放。

- 桥接写入 `files/output-<n>.<type>`，序号从 1 开始，再把占位替换为 `{file, bytes, sha256, type, width?, height?, pixels?}`。路径相对于任务目录。

- 内容识别支持 PNG、JPEG、GIF、WebP、PDF、SVG、MP4（第 4–8 字节为 `ftyp`）和 WebM（前缀 `1A 45 DF A3`）；未知数据使用 `bin`。PNG 带尺寸。Run 的 PNG 还带透明度与主色摘要；单图超过 1,600 万像素，或任务累计分析超过 3,200 万像素时跳过，记为 `pixels.skipped: "too-large"`。Extract 不计算像素摘要。

- 无效占位替换为 `{binaryUnavailable:true}` 并追加 `binaryErrors`，其余证据照常保留。

- 二进制数据不计入 iframe 的结构化结果上限。脚本返回的 base64 字符串不在豁免范围内，可能导致整个返回值被丢弃。

### Extract

Extract 是内建读取，不执行脚本。它没有确认、写前检查点或 Undo 边界。它加载目标页，但不改变用户正在查看的页面。所有失败都带 `executionStarted:false`；中断的 extract 可以重新提交。

提取只序列化可见节点，丢弃不可见子树。目标不能是页面，也不能不可见。自动 SVG 孤岛选择最大的纯图形子树：至少包含一个矢量类节点，没有文字、路径文字或可见位图，没有依赖背景的效果，且根节点有绘制、不是蒙版，也不是提取目标。背景依赖包括 GLASS、背景模糊，以及 NORMAL/PASS_THROUGH 之外的混合模式。自动 SVG 字符串按内容去重。

显式 `islands` 在自动导出之外追加。已自动导出的节点直接复用，其他显式孤岛使用二进制 SVG，不去重。可见目标树之外、没有绘制或导出失败的节点会跳过：`islandsSkipped` 与 `warnings` 给出说明，`ok` 仍为 true，CLI 退出码为 `1`。

提取期间目标页有变化时，追加 `documentChangedDuringExtract`：树、参考图与孤岛可能对应不同时间点。

| 限制 | 上限 | 处理方式 |
|---|---|---|
| 可见节点 | 10,000 | 缩小目标 |
| 参考图、位图、显式 SVG 二进制 | 200 项，base64 合计 48 MB | 缩小目标或降低倍率 |
| 结构化输出 | 估算 UTF-8 上界 12 MB | 缩小目标 |

超限会失败，不返回部分输出。结构化估算把每个非 ASCII 码元按三字节计。输出契约见 [extract-contract.d.ts](../../src/html/extract-contract.d.ts)：

| 字段 | 含义 |
|---|---|
| `schema`, `islandRule` | Schema 为 `1`；自动孤岛规则版本为 `2` |
| `root` | 节点树，包含 `id`、`name`、`type`、目标坐标系变换 `[[a,c,tx],[b,d,ty]]`、尺寸，以及裁切后的目标坐标系 `renderBounds` 或 null。根变换为单位矩阵。其他属性省略默认值；文字样式放在 `segments` |
| `colorProfile`, `scale` | 文档颜色配置与提取倍率 |
| `reference` | 通过 `useAbsoluteBounds` 导出的节点自身盒子 PNG，应用倍率，优先使用 sRGB；回退到文档颜色配置时追加警告 |
| `images` | 按 image hash 去重的 `{bytes, width, height}` 条目；字节取不到时追加警告 |
| `islands`, `svgs` | 节点到 SVG key 的映射；`s<n>` 是自动孤岛字符串，`b<n>` 是显式孤岛二进制 |
| `islandsSkipped` | 跳过的显式节点 ID |
| `stats` | `nodes`、`islands`、`svgs`、`images`、`svgMs`、`componentMs`、`svgSrgb`、`lineHeightMissing`、`postScriptMissing` |
| `warnings` | 非致命的导出、图片、颜色配置或一致性问题 |

### 结果文件

原子创建 `runs/<job-id>/result.json` 是任务完成的唯一提交点。`job.json` 是派生记录；如果两次写入之间崩溃，下次启动会修复其状态和完成时间。读取方以 `result.json` 为准，不能只看任务是否处于终态。修改前快照只放在 `before.json`。

| 结果字段 | 含义 |
|---|---|
| `ok`, `output` | 执行/读取结果，以及二进制已替换为落盘描述的返回数据 |
| `changes` | Run 变更集 |
| `verify` | `ok:true` 时请求的画面核验 |
| `images` | Preview 描述 `{nodeId,name,file,bytes,sha256,width,height,pixels}`，文件在 `images/<index>-<node>.png` |
| `ancestors` | Inspect 朝向页面的显示链，最多二十层，包含不透明度、蒙版、填充和裁切 |
| `error`, `executionStarted`, `recovery` | 错误、脚本是否开始执行、恢复指引 |
| `targetMissing`, `missingNodeId`, `fileVerified` | 目标不存在的 inspect 确实查询了绑定文件的证据 |
| `after` | 部分写入快照，仅在已开始执行后失败时保留 |
| `bindingVerified` | 实际核验的文件、页面和节点 |
| `undoBoundaries` | `before`、`after`，以及可选的清理边界 `clean` 的结果 |
| `warnings`, `binaryErrors` | 取证/清理限制与二进制传输问题 |
| `pluginMs`, `approvalMs`, `finishedAt` | 不含确认的执行耗时、确认耗时和结果落盘时间 |

### 变更集

修改前后快照生成 `counts.created`、`deleted`、`moved`、`updated`、`bindingOnly` 和 `positionOnly`。最后三项互斥，分别表示取值变化、仅绑定变化、仅布局导致的位置变化。

节点换父级，或不在前后兄弟节点的最长共同保序子序列中时，记为移动。插入/删除一个兄弟节点不会把其他所有兄弟都记为移动；交换两个兄弟只记一个。updated、created、deleted、moved 各最多展开五十个节点，其余通过 `omitted` 计数。逐节点 `keys` 不包含位置字段。

### 画面核验

Run 的 `expect` 在执行前后导出目标，按预乘 Alpha 逐像素比较，通道阈值为零：

```text
changed = !sameSize || changedPixels > tolerance
pass = expect === "changed" ? changed : !changed
```

证据文件为 `images/render-before.png`、`render-after.png` 和 `render-diff.png`。画面核验失败时，脚本已成功执行，因此 `ok:true` 保持不变，但退出码为 `1`；不得重放。

核验不可用时，返回 `{expect,tolerance,pass:false,error}`，没有像素统计或图片。原因包括修改后导出失败、渲染数据缺失/无效、导出预算超限，或渲染图超过 1,600 万像素。错误以 `Visual check unavailable: ` 开头，下一步是 preview。

导出只能看到目标本身：目标外部的遮挡图层、外部实例，以及写入后视觉仍无法区分的隐藏图层，都不在这项检查的覆盖范围内。

## 写入结果未知

`/poll` 返回任务之前，会先原子记录 `running`。因此 queued 任务可被证明从未交付：关闭或启动恢复会为其记录带 `executionStarted:false` 的失败结果。已交付但没有结果的任务则不同：

- 正常关闭桥接时，写入带 `unknown-after-disconnect` 的 `recovery.json`。

- 异常退出后的恢复写入 `needs-document-review`。

- 启动时，将当前绑定下的未决任务载入为 recovered。Recovered run 进入 `unresolved` 并阻止新的 run；读取任务不阻塞，可以重新提交。

- 带有效 `resolution.json` 的 run 不再载入。核验记录损坏会使启动失败；其他绑定下的未决写入也会使启动失败。无关的读取任务会忽略。

- Recovered 任务绝不重新交付，也不能重新确认或提交检查点。已载入任务的迟到完成结果仍可落盘，并解除其未决状态。

使用 `resolve <original-id> --inspect <inspection-id> --previous-plugin-stopped` 核验。该 inspection 必须在当前会话直接查询原目标，且旧插件必须确实已经停止。Resolve 结束未决等待，但不宣称原执行结果、不重放，也不撤销写入。

只要 `result.json` 已存在，完成回传就是幂等的，即使当前内存中没有该任务。既未载入、磁盘上也未完成的任务返回 `409 FOREIGN_JOB`，不写任何证据；插件保留原结果，等待正确项目。重启前已 resolve、因而有意不再载入的 run 也适用这条规则。其旧插件必须关闭后重新运行；已经核验的原结果仍保持未知。

## 桥接接口

| 接口 | 角色 | 契约 |
|---|---|---|
| `POST /job` | CLI | 提交任务 |
| `GET /result?id=` | CLI | 当前会话结果；CLI 通常直接从磁盘读取证据 |
| `POST /resolve` | CLI | 检查后核验未知写入 |
| `POST /shutdown` | CLI | 必须提供 `{force:boolean}`；有 queued/running 任务且未 force 时返回 `409 ACTIVE_JOB`；否则先返回 `202` 再关闭 |
| `GET /poll` | 插件 | 领取任务，或将空响应最多挂起十秒 |
| `POST /checkpoint` | 插件 | 保存写前快照 |
| `POST /approve` | 插件 | 对本会话交付的高风险 run 作出不可更改的决定 |
| `POST /complete` | 插件 | 幂等完成，先到的结果生效；不要求持有当前租约 |

每个请求都带 `X-Session-Token`，插件路由还必须带 `X-Plugin-Version`。CLI 与插件凭证分开且限定角色。插件凭证不符返回 `403 PAIRING_MISMATCH`，不回显凭证；CLI 凭证不符返回 `403`。版本不符返回 `409 PLUGIN_OUTDATED`。

每个响应都带 `X-Figma-Session`。已认证插件响应还带 `X-Figma-Binding`，包含绑定 ID、文件 key、节点 ID 和项目目录名。响应头 JSON 把非 ASCII 字符转义为 `\uXXXX`，iframe 通过 JSON 解析还原。CORS 暴露这些响应头和 `X-Long-Poll`。会话变化会触发重新核验文件。

`pluginIssues` 按连接原因分别记录最后出现时间。断连时，doctor 按以下顺序报告两分钟内出现的原因：`FOREIGN_JOB`、`PAIRING_MISMATCH`、`NO_FILE_KEY`、`WRONG_FILE`。只有第一条是带处置动作的 error，其余为 warning。他项目结果优先，因为重启插件可能丢弃它们。配对诊断要求请求带版本头，以避免普通简单请求或扫描造成噪声。

`/complete` 请求体上限为 72 MiB，其他接口为 16 MiB。关闭时，先等进行中的证据写入完成，再判断在途任务状态。只有显式 `executionStarted:false` 才允许给出重新提交指引；其他完成状态引导调用方读取原结果。

## 插件消息

iframe 与执行代码使用 postMessage。每个任务都有随机 `channelNonce`；ID 或 nonce 不匹配的消息会忽略。

有待回传结果时，iframe 发送 `/complete` 而非心跳。轮询超时为 15 秒；结果回传为三秒加上每 10 MB 载荷一秒；其他请求为三秒。

## CLI 输出

Stdout 只包含一个 JSON 对象。错误形状为 `{error,code}`，错误文字最多 2,000 字符。不要把 stderr 合并进 JSON 输出。

提交类命令默认等待并打印摘要；`--full` 打印完整记录；`--no-wait` 直接返回桥接响应。开始等待时，stderr 输出一行 `{submitted,next,reused?}` JSON，因此 CLI 被外部终止后仍可按 ID 继续。HTML 每提交一个 extract 都写一行回执。重复请求会等待原任务并返回原任务结果。

摘要 `output` 超过 16 KiB UTF-8 时，替换为读取命令。Extract 输出始终只给结构形状/读取命令，另带 `extract:{stats,islandsSkipped,warnings}`；最多展开五十个跳过 ID，以及二十条各不超过 600 字符的警告，并给出省略数量。

| `waitStatus` | 含义 |
|---|---|
| `completed` | 结果已落盘 |
| `needs-review` | 恢复证据要求执行给出的核验动作 |
| `resolved` | 已核验，但原执行结果仍然未知 |

| 退出码 | 通用命令 |
|---|---|
| `0` | 成功 |
| `1` | 失败、画面核验失败/不可用、跳过/拒绝清理、跳过显式孤岛或提取二进制不完整，或已核验但结果未知 |
| `2` | 尚未完成：等待超时或待核验。对 stop，表示已接受关闭，但约五秒后仍未释放锁；应稍后检查状态 |

`report --since` 接受 ISO 日期/时间；带时间时必须提供 `Z` 或时区偏移，只有日期则按 UTC 零点处理。`jobs.failed` 统计 `ok:false`；`jobs.verifyFailed` 统计执行成功但画面核验失败/不可用的任务，两者互斥。

## 提取实现位置

只读提取在 plugin/main.js 内实现，并共享文档读取辅助函数。

## 连接范围

桥接使用端口 32523，同一台机器只保留一个项目桥接运行。全局插件可在桥接重启后重连；连接另一个项目前先停止原项目。

## 准备阶段顺序

当前目标复核发生在前图导出及后续准备读取之前。准备期间保持目标不变。
