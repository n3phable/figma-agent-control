# 协议与证据

[English](../protocol.md) · [中文文档索引](README.md)

本文定义 CLI、本机桥接、插件 iframe（`ui.html`）、插件执行代码（`main.js` 与 `extract.js`），以及主机侧 HTML 导出之间的契约。实现变更时应同步维护本文。操作步骤见 [Agent 使用指南](agent-guide.md)。

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

桥接监听 `127.0.0.1`，使用 `32523`–`32530` 中第一个可用端口。每个项目最多运行一个桥接，由 `bridge.lock` 保证；同时最多有一个在途任务。实际端口写入 `session.json`。

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
| `frames/` | `frames` | 视频联系表与可选的原尺寸静帧 |
| `check/<extract-job-id>/` | HTML 命令 | 渲染比对证据 |

只有检查 PID 返回 `ESRCH` 时，锁才被视为陈旧。接管时先独占创建 `bridge.lock.takeover`，复读原锁，只有内容未变才归档。空锁可能处于创建与写入 PID 之间：`connect`、无会话时的 `stop` 和 `doctor` 都把它视为已占用，绝不删除。存活的 PID 一律视为占用，即使操作系统可能复用了它；诊断会给出人工检查步骤。

`init` 会把证据目录加入项目的 `.gitignore`。证据可能包含设计数据和凭证，不能把它当作可分发的输出目录。

## 全局插件目录

共享目录为 `~/.config/figma-agent-control/`，可通过 `FIGMA_AGENT_CONTROL_HOME` 改写。

| 路径 | 写入方 | 契约 |
|---|---|---|
| `pairing.json` | `connect` 经 session | 持久化插件凭证，权限 `0600`；首次创建具有独占性；内容损坏时报 `PAIRING_INVALID` |
| `plugin/manifest.json` | `connect` | 生成的开发插件清单，含 `documentAccess: dynamic-page`、`enablePrivatePluginApi: true`，没有 Figma 分配的插件 ID |
| `plugin/main.js` | `connect` | 按 `PLUGIN_SCRIPTS` 顺序拼接源码 `plugin/main.js` 与 `plugin/extract.js` |
| `plugin/ui.html` | `connect` | 注入候选端口、插件凭证与插件版本后的模板 |

桥接生成插件文件内容，`connect` 只安装内容发生变化的文件。固定候选端口段与共享配对凭证，使同版本下各项目生成的文件完全相同。绑定与项目名通过已认证响应的响应头下发，不写进插件文件。

iframe 用 `/heartbeat?probe=1` 逐个探测候选端口，不附带在手任务。探测只读取身份，不取得租约。空闲时按文件 key 选择匹配的桥接，优先最低端口；没有匹配项时，使用第一个有响应的桥接显示诊断。没有桥接时，在请求前重新发现；连到其他文件的桥接时，定期重新发现。持有任务或结果期间，必须匹配该任务的绑定 ID，并等待原项目，保留已有结果。`FOREIGN_JOB` 或端口被重新分配时会触发重新发现。

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
| `cleanOnFail` | Run | 布尔值；对应 CLI 的 `--clean-on-fail` |
| `requestId` | 全部 | 用作任务 ID 的小写 UUID；CLI 在 `run` 上开放该参数 |
| `label` | 全部 | 报告中的来源名；CLI 使用脚本文件名，或 `clean <original-id>` |

CLI 在提交前把裸名 `--lib motion` 解析为内置文件。桥接和插件只接收普通的具名源码字符串，不区分内置库与用户库。

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

8. 记录已有本地集合、变量与样式。在准备阶段最后一次 `await` 之后，再次核验文件、目标、范围、页面和快照。从该复核到调用脚本之间不让出控制。

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

### 按名称 Preview

名称必须精确匹配绑定节点的子节点，只递归进入 Section。Section 自身也能匹配；不遍历画框、组、组件和实例内部。

加载页面后、任何导出开始前，先解析全部名称。任一名称不存在或有歧义，任务均以 `executionStarted:false` 失败，不导出任何图片。缺失名称的错误最多列出二十个可用名称；重名错误给出数量，以及最多二十个 ID 与位置。解析出的节点随后走普通的逐节点范围核验和导出流程。

`job.json` 记录名称，`result.json` 记录解析后的 `images[].nodeId`。桥接在接受证据前核对图片数量、名称顺序与节点 ID 格式。

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
| `root.children`（以及后代的 children） | 按原始顺序排列的可见子节点；水平/垂直 Auto Layout 可通过 `itemReverseZIndex` 反转绘制顺序 |
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
| `pageRoot` | 成功且目标不是页面的 run 所观察到的页面直接子节点变化：`created`/`deleted` 条目为 `{id,name,type}`，各最多 50 个，并给出省略数量。通过 inspect 确认这些前后差异的来源 |
| `verify` | `ok:true` 时请求的画面核验 |
| `images` | Preview 描述 `{nodeId,name,file,bytes,sha256,width,height,pixels}`，文件在 `images/<index>-<node>.png` |
| `ancestors` | Inspect 朝向页面的显示链，最多二十层，包含不透明度、蒙版、填充和裁切 |
| `error`, `executionStarted`, `recovery` | 错误、脚本是否开始执行、恢复指引 |
| `stack`, `trace` | 原始和映射后的脚本错误位置 |
| `targetMissing`, `missingNodeId`, `fileVerified` | 目标不存在的 inspect 确实查询了绑定文件的证据 |
| `after` | 部分写入快照，仅在已开始执行后失败时保留 |
| `bindingVerified` | 实际核验的文件、页面和节点 |
| `undoBoundaries` | `before`、`after`，以及可选的清理边界 `clean` 的结果 |
| `created`, `cleaned`, `cleanFailed` | 失败脚本的新建节点跟踪与清理结果 |
| `createdAssets` | 新建且仍存在的集合、变量和样式；条目为 `{id,name}` |
| `deletedExisting` | 同时执行了清理的 run 在执行期间删除的已有节点数 |
| `warnings`, `binaryErrors` | 取证/清理限制与二进制传输问题 |
| `pluginMs`, `approvalMs`, `finishedAt` | 不含确认的执行耗时、确认耗时和结果落盘时间 |

### 错误堆栈与 trace

只有脚本编译或执行抛出的值带字符串 stack 时，结果才包含 `stack`，最多 4,000 字符。内部校验、快照与序列化错误不带脚本 stack。抛出的值即使无法转成字符串，也会以说明性错误结束任务。

编译把库与正文逐层嵌入 `new Function`。引擎函数头占两行，最外层包装占一行，因此第一段从引擎第 4 行开始。第 `k` 段起于 `4 + sum(previous segment line counts + 1)`。段内行号为引擎行号减该段起始行再加一；列号不变。

[record.mjs](../../src/record.mjs) 的 `scriptTrace` 识别 QuickJS 的 `<input>` 与 V8 的 eval 帧。它跳过 `anonymous` 包装，只在编译阶段信任无名帧。在找到第一帧之前跳过分段之外的帧，找到之后遇到外层包装即停止。最多返回十个 `{file,line,column,source}`，source 截到 200 字符。内置库使用 `lib:<name>`。映射失败不会阻止结果落盘。

嵌套 `eval` 或 `new Function` 代码可能产生误导位置，仍以原始 stack 为准。QuickJS 可能在跨越 `await` 时丢失调用方，宿主异步拒绝也可能没有 stack。内置异步库包装会尽可能保存入口调用栈。CLI 输出映射后的 trace；没有映射时输出原始 stack 的前 500 字符。

### 失败脚本的新建节点跟踪

插件在执行期间监听目标页 `nodechange` 的 CREATE/DELETE 事件，排除 `origin: REMOTE`。嵌套的新建/删除只报告最高层父节点。监听注册失败只追加警告，不阻止执行。

脚本抛错并尝试提交结束边界后，至少等待事件沉降 200 ms，再等到连续 120 ms 无新事件；每 40 ms 检查一次，墙钟上限一秒。计时器节流可能额外增加一个间隔。随后读取仍存在的新建节点，去掉其他新建节点的后代。每条为 `{id,name,type,parentId,size}`；`size` 统计自有后代，排除以 `I` 开头的实例内部 ID。旧证据可能缺少最后两个字段。

`cleanOnFail` 只在结束边界成功后清理。执行前已在目标页上的节点，以及包含这些已有节点的新节点，均受到保护。删除成功的放入 `cleaned`；因保护或删除失败而保留的放入 `cleanFailed`，并附原因。至少删除一个节点时，再提交一次 Undo 边界，记录在 `undoBoundaries.clean`。清理边界失败会警告：这些删除可能并入下一步 Undo。

如果清理删除了节点，且执行期间原目标页上的节点消失，`deletedExisting` 会统计事件报告的顶层删除数，并追加警告。detach/flatten 等替换 ID 的操作可能让已有内容看起来像新建。主动撤销清理步骤可以找回这些内容；脚本对已有节点的修改绝不自动回滚。

新建跟踪不覆盖其他页面，也不覆盖脚本正文已经成功完成后的失败，例如序列化失败。新建组件可能不发出 CREATE。执行期间本地用户的编辑无法与脚本编辑区分。清理保护也不覆盖从其他页面移入的已有内容。取证或清理错误只追加警告，保留原始脚本错误。

集合、变量和样式通过执行前后 ID 比较识别，不依赖节点事件。`createdAssets` 只报告它们；两条清理路径都不会删除这些资源。每项失败后的取证读取都有 15 秒超时。摘要节点列表最多展开五十项，并给出省略数量。

### 延后清理：`clean`

`clean <job-id>` 构造普通 run，因此写前检查点、Undo、未知写入核验和普通证据规则全部适用。插件没有专用的清理操作。

原任务必须是已完成的失败 run，带 `executionStarted:true` 和 `created` 列表。目标页来自 `before.json.bindingVerified.pageId`。缺失或无效的证据在提交前即被拒绝。候选集合为 `created` 减去 `cleaned` 与 `cleanFailed`；有意保护的节点继续排除。候选为空时返回 `{task,instruction}`，退出码 `0`，不提交新任务。

清理任务使用固定脚本、标签 `clean <original-id>`、深度 `1`，以及数据 `{task,pageId,nodes}`。它以绑定节点而非原目标为目标，没有 request ID、高风险标记或递归清理。data 超过 1 MiB，或绑定节点的直接子节点候选达到 2,000 个时，在提交前拒绝。其他已有子节点仍可能让修改前快照超出预算。

逐节点复核时，已不存在的记为 `gone`；页面、名称、类型、父节点、自有后代数量发生变化，或原证据缺少父节点信息时，记为 `skipped`。其余节点被删除，删除错误也记为 skipped。输出为 `{task,cleaned,gone,skipped}`，skipped 条目带原因。原证据不会重写。任一 skipped 条目使退出码为 `1`；支持重复清理。这项复核无法识别所有被移入新容器的已有图层，因此调用前仍需检查候选节点。

### 变更集

修改前后快照生成 `counts.created`、`deleted`、`moved`、`updated`、`bindingOnly` 和 `positionOnly`。最后三项互斥，分别表示取值变化、仅绑定变化、仅布局导致的位置变化。

节点换父级，或不在前后兄弟节点的最长共同保序子序列中时，记为移动。插入/删除一个兄弟节点不会把其他所有兄弟都记为移动；交换两个兄弟只记一个。updated、created、deleted、moved 各最多展开五十个节点，其余通过 `omitted` 计数。逐节点 `keys` 不包含位置字段。

显式深度会追加 `limitation`，更深处的变化不可见。可用时，快照包含非空 Motion 样式、轨道和所属画框的时间线。修改后快照发生未声明的深度截断，或超出节点预算时，变更集不可用。如果执行失败后，修改后快照也过大，`changes` 与 `after` 场景可能同时缺失，此时应使用 inspect。

比较只覆盖目标子树。通过 `figma` 对目标之外的写入不会被直接观察；页面根直接子节点的增删另由 `pageRoot` 比较记录。

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

### 进度与取消

脚本和库拿到的是 `figma` 代理。代理转发访问，并跟踪名称以 `Async` 结尾且尚未完成的方法，包括 `variables`、`motion`、`teamLibrary`、`clientStorage` 和 `annotations` 命名空间。节点原样返回，因此不跟踪节点自身的异步方法。成功加载的字体按 family/style 在插件会话内缓存，失败不缓存。

插件在收到 run 后一秒首次报告进度；计时器可运行时，之后每两秒报告一次：

```text
{seq, phase, elapsedMs, changes?, lastChangeAgoMs?, waiting?, waitingCount?}
```

阶段为 `prepare`、`approval`、`script` 和 `finish`。只有 script 阶段带目标页本地改动次数与未返回调用。`waiting` 最多列出最早的三个 `{call,forMs}`，最早的一项还带最多 1,000 字符的 stack。iframe 立即把进度放进 URL 编码的心跳参数。桥接把 stack 映射为 `at`，移除原始 stack，追加 `reportedAt` 和可选的 `hidden:true`，保存内存状态，并按每个序号写一次 `progress.json`。无效进度会忽略。Status 另加 `ageMs`。

`POST /cancel {id}` 只接受当前在途 run。交付前取消会记录未执行结果；交付后取消会唤醒挂起的心跳，并持续返回 `cancel:true`，由 iframe 转发匹配的任务 ID 与 nonce。准备或确认期间取消，以 `executionStarted:false` 结束等待；迟到读取或回执不能恢复执行。脚本期间取消会把执行 race 结束为失败，以最早未返回调用作为错误上下文，并照常走失败取证和清理。

独立的 `/heartbeat?hold=1` 通道挂起到取消、完成或约十秒后，再用 `X-Long-Poll` 立即续接，避开面板计时器节流。插件自身的进度与失败清理计时器仍可能被节流。

取消无法终止已经挂起的 JavaScript 后续执行，也无法终止已经发出的宿主调用。之后经代理的访问会抛错，但通过此前已取得节点进行的直接写入无法阻止。结果会以警告说明该限制。要终止后续执行，应停止并重新运行插件。读取任务不能取消；同步工作必须先让出控制，取消才有机会被处理。

## 桥接接口

| 接口 | 角色 | 契约 |
|---|---|---|
| `GET /status` | CLI | 绑定、连接、在途/未决任务、插件版本、最近二十个任务，以及可选的进度和取消请求 |
| `POST /job` | CLI | 提交任务 |
| `GET /result?id=` | CLI | 当前会话结果；CLI 通常直接从磁盘读取证据 |
| `POST /resolve` | CLI | 检查后核验未知写入 |
| `POST /cancel` | CLI | `200 {cancelled:"before-delivery"}` 或 `202 {cancelRequested:true}`；其他情况为 `409 NOT_ACTIVE` / `NOT_RUN` |
| `POST /shutdown` | CLI | 必须提供 `{force:boolean}`；有 queued/running 任务且未 force 时返回 `409 ACTIVE_JOB`；否则先返回 `202` 再关闭 |
| `GET /poll` | 插件 | 领取任务，或将空响应最多挂起十秒 |
| `GET /heartbeat` | 插件 | 身份探测、租约续期、任务/进度报告，或挂起的取消通道 |
| `POST /checkpoint` | 插件 | 保存写前快照 |
| `POST /approve` | 插件 | 对本会话交付的高风险 run 作出不可更改的决定 |
| `POST /complete` | 插件 | 幂等完成，先到的结果生效；不要求持有当前租约 |

每个请求都带 `X-Session-Token`，插件路由还必须带 `X-Plugin-Version`。CLI 与插件凭证分开且限定角色。插件凭证不符返回 `403 PAIRING_MISMATCH`，不回显凭证；CLI 凭证不符返回 `403`。版本不符返回 `409 PLUGIN_OUTDATED`。

插件正式请求带 `client`、`visibility` 和当前文件 `file`。执行心跳还带 `job` 和可选的 `progress`。文件错误或缺失时，不发任务也不续租。持有未知任务时返回 `409 FOREIGN_JOB`，同样不续租。探测不取得或续期租约。前台租约为 15 秒，后台为 90 秒。在途 run 会阻止替换其插件实例；读取任务在租约过期后可以被放弃并由其他实例接管。

每个响应都带 `X-Figma-Session`。已认证插件响应还带 `X-Figma-Binding`，包含绑定 ID、文件 key、节点 ID 和项目目录名。响应头 JSON 把非 ASCII 字符转义为 `\uXXXX`，iframe 通过 JSON 解析还原。CORS 暴露这些响应头和 `X-Long-Poll`。会话变化会触发重新核验文件。

`pluginIssues` 按连接原因分别记录最后出现时间。断连时，doctor 按以下顺序报告两分钟内出现的原因：`FOREIGN_JOB`、`PAIRING_MISMATCH`、`NO_FILE_KEY`、`WRONG_FILE`。只有第一条是带处置动作的 error，其余为 warning。他项目结果优先，因为重启插件可能丢弃它们。配对诊断要求请求带版本头，以避免普通简单请求或扫描造成噪声。

`/complete` 请求体上限为 72 MiB，其他接口为 16 MiB。关闭时，先等进行中的证据写入完成，再判断在途任务状态。只有显式 `executionStarted:false` 才允许给出重新提交指引；其他完成状态引导调用方读取原结果。

## 插件消息

iframe 与执行代码使用 postMessage。每个任务都有随机 `channelNonce`；ID 或 nonce 不匹配的消息会忽略。

消息包括 `hello`/`file`、`approval-request`/`approval-ack`、`checkpoint`/`checkpoint-ack`、`progress`、`cancel`、`check-target`/`target-info`、`focus-target`、`resize` 和 `hide-ui`。iframe 在轮询或心跳前先取得文件 key。目标定位会切换页面、选中目标并滚动到可见位置；执行任务期间禁用。

包括快照和 base64 在内，超过 65,536 个 JavaScript 字符串字符的任务消息使用 `serialized-result` 封装。结构化部分超过约 16 MB、桥接返回 `413`，或同一完成回传累计收到三次 `400` 时，iframe 改用精简失败证据。其他失败不重置拒收计数，`409 FOREIGN_JOB` 永不触发降级。精简结果保留执行状态、核验后的绑定、脚本失败清理列表、新建资源、警告和 stack。

有待回传结果时，iframe 发送 `/complete` 而非心跳。轮询超时为 15 秒；结果回传为三秒加上每 10 MB 载荷一秒；其他请求为三秒。

## 动效

[lib/motion.js](../../lib/motion.js) 在普通 `run --lib motion` 任务中执行，不增加桥接操作，沿用 run 的写前检查点、Undo 边界和变更集。Motion 属于 Beta/私有 API；清单开启了私有 API 访问，但 Figma 是否提供该能力不由 FAC 控制。

### MotionSpec

| 函数 | 返回值 |
|---|---|
| `readMotion(root = target, {durationRange}?)` | 按时间线分组的 MotionSpec，附带 `issues` |
| `applyMotion(spec = data, root = target)` | `{changes,motion}`；统计 `tracksWritten`、`tracksRemoved`、`stylesApplied`、`stylesRemoved`、`durations`，然后重读 |
| `exportMotion(node = target, settings = {format:'WEBM',quality:'LOW'}, {waitSeconds=60,intervalMs=3000,differentFrom}?)` | `{frame,video,attempts,waitedMs}`；视频字节按普通二进制流程落盘 |
| `motionIssues(spec, {durationRange=[0.1,0.5],easingTokens=[]}?)` | 问题数组；readMotion 已包含它 |

```json
{
  "timelines":[{"id":"12:34","name":"Card entrance","duration":0.6,"nodes":[
    {"id":"12:35","name":"card","tracks":{"OPACITY":{"base":1,"keys":[[0,0],[0.3,1,"$motion/standard"]]}},
     "styles":[{"id":"AnimationPresetId:12:40","preset":"Position","at":0.08,"dur":0.3,"easing":"spring(0.3)","props":{"direction":"bottom","distance":24}}]},
    {"id":"I12:9;1:4","name":"spinner","inherited":true,"tracks":{"ROTATION":{"base":0,"keys":[[0,0],[1,360]]}}}
  ]}],
  "refs":{"$motion/standard":"VariableID:12:50"},
  "issues":[]
}
```

- 时间线 ID 属于其顶层画框或 Section。时长与关键帧时间均以秒计。根节点自己的时间线即使为空也会列出；其他时间线只有包含动效时才列出。

- 轨道路径包括属性名（`OPACITY`、`TRANSLATION_X`）、`fills.0`、`strokes.1`、`effects.0.RADIUS`，以及 `fills.0.properties.<property-id>` 这样的组件属性路径。

- 值使用数字、布尔值、`[x,y]`、`#RRGGBB` / `#RRGGBBAA`；其他类型保留原 `{type,value}` 对象。关键帧为 `[seconds,value,easing?]`。

- 缓动控制以该关键帧结束的区间。支持的短记法包括 `linear`、标准 ease-in/out/back 变体、`hold`、`gentle`、`quick`、`bouncy`、`slow`、`cubic(x1,y1,x2,y2)`、`spring(bounce)` 和 `$variable-name`。未知形式保留原始对象。读取时省略默认手动缓动 `cubic(0.5,0,0.5,1)`。

- 预设使用 `{id,preset,at,dur,easing?,props?}`，`preset` 来自 `figma.motion.figmaAnimationStyles()`。默认 props，以及跟随时间线偏移的 delay 会省略。自定义样式使用 `{id,style:"@name",at}`；新样式省略 `id`。

- `refs` 把 `$` / `@` 记法映射到确切 ID；apply 先查 refs，再查本地名称。变量重名时添加 `#ID` 后缀。实例内部图层标记为 `inherited`。

Apply 是声明式写入：列出的节点只要提供 `tracks` 或 `styles`，就完整同步对应字段，删除多余项，只写实际差异。省略的字段和节点不动。变化的时间线时长会写入。输入未变时不写入，包括只读的继承项和组件项。

写入前解析全部节点、路径、值、缓动、引用和预设。要求修改组件/变体集本身或实例内部图层时会被拒绝；组件子图层和实例本身可能可写。每个已执行步骤记录逆操作。Figma 拒绝后，库尝试按逆序回滚，并报告恢复了多少。原始 API 值保留变量 ID 和数值精度；回滚时重新应用预设可能产生新的 ID。应读取失败详情，不能假定存在通用事务保证。

视频导出先找到所属顶层画框。遇到 `Video export failed` 时重试；提供 `differentFrom` 时，逐字节相同的导出也会重试。等待有上限，其他错误立即失败。视频导出可能滞后于文档修改：可见改动使用 `differentFrom` 并检查采样帧；应保持画面的改动省略该选项。

问题形状为 `{rule,timeline,node?,message}`，检查不会修改数据：

| 规则 | 含义 |
|---|---|
| `beyond-timeline` | 关键帧/预设超过播放或导出时长 |
| `first-key-easing` | 第一个关键帧上的缓动不起作用 |
| `static-track` | 少于两个关键帧 |
| `track-conflict` | 预设与手动轨道竞争同一属性，或同类预设时间重叠 |
| `duration-range` | 实际运动时长超出配置范围；hold/静止区间会分隔动画段；`null` 关闭此检查 |
| `idle-tail` | 动效结束后还剩超过 0.5 秒且超过时间线四分之一的空转；时长未知的自定义样式不检查 |
| `raw-easing` | 已存在 EASING 变量，但变化区间使用原始缓动；hold/静止区间不计 |
| `inconsistent-easing` | 同预设/类型使用不同缓动 |
| `irregular-stagger` | 至少三个同预设/类型/时长节点的偏移间隔不均匀 |

### 静帧提取

`frames <video|run-id> [--at <seconds,...>] [--count <2-24>] [--compare <video|run-id>] [--dump]` 在 Chrome 中从 MP4/WebM 采样，不连接 Figma。

文件相对于工作目录解析。任务 ID 必须指向成功的 run，且返回值中恰好有一个已落盘的 MP4/WebM；无效来源在启动 Chrome 前失败。不支持 GIF，MP4 编解码支持取决于 Chrome 构建。

显式时刻会去重排序，最多 24 个，且必须在视频时长内。默认从零到结束前 0.05 秒均匀取八个时刻，每个时刻选择覆盖它的那一帧。联系表格子带时间标注，每行最多四格，对照时最多六格，总宽不超过 1,600 px。窄帧以最近邻放大到至少 160 px。对照格把源帧和对照帧上下排列，并标注变化像素。

输出为 `{source,compare?,width,height,duration,sheet,frames:[{t,file?,compareFile?,changedPixels?,sameSize?}],changed?,layout?,warning?,limitation}`。只有 dump 时才给出逐帧文件路径。视频字节相同会追加警告。像素差异沿用 run 画面核验的 `diffPng` 定义。输出写入绑定项目的 `frames/`，或系统临时目录。成功退出 `0`；无效输入或解码失败退出 `1`。

## 原型

[lib/prototype.js](../../lib/prototype.js) 通过 `--lib prototype` 执行，使用普通 run 证据和 Undo 边界。快照已经包含 `reactions` 与页面 `flowStartingPoints`。

### PrototypeSpec

| 函数 | 返回值 |
|---|---|
| `readPrototype(root = target)` | 子树内 reactions、页面流程起点、目标、交互图和问题 |
| `applyPrototype(spec = data, root = target)` | `{changes,prototype}`，包含 `changes:{nodes,flows,flowsAdded}` 与重读数据 |
| `prototypeIssues(spec, root = target)` | 异步问题数组；会读取目标、变体、图层和变量 |

```json
{
  "root":{"id":"12:1","name":"Flows","type":"PAGE"},"page":"12:1",
  "flows":[{"nodeId":"12:10","name":"Sign in"}],
  "nodes":[{"id":"12:12","name":"button","frame":"12:10","reactions":[
    {"on":"click","do":[{"navigate":"12:20","transition":"smart-animate 0.3 ease-out","resetScroll":true}]}
  ]}],
  "targets":{"12:20":{"name":"Home","frame":"12:20"}},
  "frames":{"12:10":"Login","12:20":"Home"},"overlays":{},
  "edges":[{"from":"12:12","fromFrame":"12:10","on":"click","nav":"navigate","to":"12:20","toFrame":"12:20"}],
  "issues":[]
}
```

nodes 只包含有 reactions 的节点。其 `frame` 是直接位于页面或 Section 之下的所属顶层画框。实例内部图层可以读出继承连线，写入会形成按触发方式区分的覆盖。

| 语法 | 形式 |
|---|---|
| `on` | `click`、`hover`、`press`、`drag`、`media-end`；`after seconds`、`mouse-enter seconds`、`mouse-leave seconds`、`mouse-up seconds`、`mouse-down seconds`、`media-hit seconds`；`key DEVICE code,code` |
| `do` | `"back"`、`"close"`、`{url,newTab?}`，或带目标 ID 的单个节点动词：`navigate`、`swap`、`overlay`、`scroll-to`、`change-to` |
| 节点动作选项 | `transition`、`position:[x,y]`、`resetScroll`、`resetComponents`、`resetVideo` |
| 无方向过渡 | `dissolve\|smart-animate\|scroll-animate seconds easing` |
| 有方向过渡 | `move-in\|move-out\|push\|slide-in\|slide-out left\|right\|top\|bottom seconds easing [match]` |
| 缓动 | 标准缓动名、`cubic(x1,y1,x2,y2)`，或 `spring(mass,stiffness,damping)` |

超时与延迟值以秒计。未知触发、过渡和动作保留原对象，包括变量与条件动作。嵌套条件内的节点动作仍参与交互图检查。不写已弃用的触发版本键。原型弹簧对象使用 mass/stiffness/damping，不使用 Motion 的 bounce 或 initialVelocity。

读取值保留三位小数；比较使用四位，以适应 float32 存储。`targets` 包含名称/画框 ID、`missing:true` 或其他页面名。`frames`、`targets`、`edges` 和 `issues` 只供说明，apply 时忽略。`overlays` 读取目标的定位、背景和点外关闭行为；修改会被拒绝，并指引到 Figma 的 Prototype 面板操作。

Apply 同步列出节点的 reactions；空数组清空，未列出的节点不动，重复节点条目会失败。写入前校验全部语法、节点能力、只读浮层设置和具名流程。与本次改动相关的 error 级问题会在任何修改前拒绝整个 apply。只有变化的节点才调用 `setReactionsAsync`，并统一写 `actions`，不写已弃用的单数 `action`。

最后才写 flows，因为顶层画框首次获得出向 reaction 时，Figma 可能自动增加流程起点。显式 `flows` 替换最终集合；省略时保留自动新增，并在 `flowsAdded` 中报告。被拒绝后，库先尝试按逆序恢复此前 reactions，再恢复原 flows。错误会解释已知无效组合和后台窗口失败；重试前应检查回滚结果。套餐限制可能拒绝多动作、SET_VARIABLE 或 CONDITIONAL。

问题形状为 `{rule,level,node?,message}`：

| 规则 | 级别 | 含义 |
|---|---|---|
| `target-missing` | error | 源节点或目标不存在 |
| `target-other-page` | error | 目标位于其他页面 |
| `not-top-level` | error | Navigate/swap/overlay 目标不是顶层 FRAME，或导航目标就是源画框 |
| `scroll-outside` | error | 滚动目标位于源画框之外 |
| `change-to-not-variant` | error | 目标不属于源节点的变体集 |
| `overlay-position` | error | 给非 Manual 浮层提供了 position |
| `variable-type` | error | 变量不存在，或赋值类型不兼容 |
| `flow-invalid` | error | 流程目标不存在、重复，或不是合法顶层目标 |
| `smart-animate-unmatched` | warning | 按名称和层级路径匹配到的图层不足一半 |
| `unreachable` | warning | 参与交互的顶层画框无法从流程起点到达；只在页面根读取时检查 |
| `dead-end` | warning | 没有导航/浮层/back/close/链接出口；只在页面根读取时检查；点外关闭的浮层豁免 |

## HTML 导出

`html` 根据 extract 生成自包含 HTML，并与同一次 extract 的参考图比对。`html-check` 重新检查已有页面。生成与比图都在 CLI 进程运行；只有 `html --node` 提交桥接任务。比图需要 Chrome，可通过 `FIGMA_AGENT_CONTROL_CHROME` 配置；`html --no-check` 不需要 Chrome。

### 处理顺序

1. 写文件前预检全部输入：必须提供 `--out`，`--node` 与 `--from` 合计 1–50 个不同画框，`--from` 必须指向本地倍率为 1 的 extract 任务，overrides 文件有效，每帧 SVG 烘焙 ID 不超过 500 个。

2. 先处理 `--from`，再处理 `--node`，各组内保持给定顺序。通常一帧出错只影响该帧。

3. 不等待地读取已有 extract，或提交并等待新 extract。新提取包含要求 SVG 烘焙的孤岛，每个都占用桥接唯一的任务槽位。

4. 组装页面。绘制顺序遵循 Auto Layout 的 `itemReverseZIndex`；根不透明度施加到整个画布，不会在参考图裁切上重复相乘。

5. 如果生成结果缺少需要的 SVG 孤岛，`--node` 帧可带这些 ID 与有效的显式 SVG 烘焙节点再提取一次；`--from` 帧只标记 `needsExtract`。第二次提取失败、超时、超限或仍缺孤岛时，保留第一次提取作为页面依据，记录 `second-extract-failed` 近似项与警告。

6. 写出页面；未禁用检查时执行检查；记录该帧。

7. 整批结束后重写 `<out>/html.json`。如果命令被外部终止，可能已有完成的页面/证据，但没有最终清单。

### 输出文件

输出目录不存在时，以权限 `0700` 创建。页面名为 `<safe-name>__<node-part>.html`。安全名替换 `\/:*?"<>|` 和控制字符，移除开头空白/点以及末尾空白，在不拆分码点的前提下限制为 120 UTF-8 字节；空名称改为 `frame`。节点 ID 的分隔符替换为连字符。文件名超过 200 字节时，节点部分改为该节点 ID 的 SHA-256 前十二个十六进制字符。

写入前，FAC 删除输出目录顶层中同一节点但文件名不同的旧页面。只有前 16 KiB 内带可识别元数据的普通 HTML 文件符合条件；符号链接、子目录和无关文件不动。

检查证据位于 `check/<extract-job-id>/`：包含 `check.json`，成功时的 `render.png` 与 `diff.png`，以及最多十张 `block-<n>.png`，各由参考图/渲染图/差分图裁切组成。Zoom 另写 `zoom-<node-part>/{figma,html,diff}.png`。重新检查会覆盖上次报告并删除旧结构块图片。普通检查不删除已有 zoom 目录。Chrome 启动或协议失败时，可能只有清单中的帧记录，而没有 `check.json`。

### 页面元数据

```html
<meta name="figma-agent-control" content="extract=<job-id>; node=<frame-id>; scale=<scale>; overrides=<fingerprint>; generator=<fingerprint>">
```

Overrides 指纹为文件字节 SHA-256 的前十二个十六进制字符，或 `none`。生成器指纹由 [css.mjs](../../src/html/css.mjs) 和 [generate.mjs](../../src/html/generate.mjs) 的源码计算。节点元数据用于识别改名页面，extract 元数据用于定位证据。Overrides 元数据允许从相邻清单恢复配置；generator 元数据用于区分源码变化与页面手工编辑。

### `html.json`

清单只描述本次调用，每次整体重写。

| 字段 | 含义 |
|---|---|
| `schema`, `generator`, `checker` | Schema `1` 与源码指纹 |
| `browser` | Chrome 启动成功时的 `{version,launchMs}` |
| `overrides` | `{file,sha}`，或 `none` |
| `out` | 绝对输出目录 |
| `frames` | 有序帧记录 |
| `totals` | 帧判定计数、错误/缺孤岛帧数、陈旧条目数、近似项计数、top 节点几何计数和字体汇总 |
| `done`, `pending`, `remaining`, `stop` | 续跑状态 |
| `instruction`, `exitCode` | 完整的下一步指引与退出码 |
| `ms` | 总耗时与字体索引耗时 |

每帧记录：

| 字段 | 含义 |
|---|---|
| `node`, `name`, `source` | 节点、名称与 `from`/`node` 来源 |
| `extract`, `extracts` | 实际用于生成的 extract；尝试过第二次提取时给出有序任务列表 |
| `html`, `check`, `size` | 绝对页面/报告路径和预期尺寸 |
| `verdict`, `reason`, `diffRatio`, `top` | 检查结果与诊断；结构块数量和 top 节点几何发现给出汇总 |
| `approximations`, `approximationNodes` | 计数与 `{node,kind,detail?}` 明细 |
| `needsIsland`, `needsExtract` | 缺失孤岛，以及已有 extract 需要重新提取的标记 |
| `glassDefaults` | GLASS 绑定了库变量，却仍为全默认参数；库数据可能尚未加载 |
| `overrides` | 提供 overrides 文件时，记录已应用节点和陈旧条目 |
| `fonts` | 声明名称、度量来源、Figma 缺字体状态，以及检查后 Chrome 实际使用/替代情况 |
| `warnings`, `violations` | 提取/生成问题与生成器输出不变量违例 |
| `error` | `{code,message}`；页面生成前失败时只保留已知身份/来源/extract 字段和 error |
| `ms` | 提取、生成、写入与检查耗时 |

错误包括 `EXTRACT_REJECTED`、确定性 `EXTRACT_FAILED` 和 `EXTRACT_INTERRUPTED`；其他失败保留其异常代码。

### Overrides

Overrides 文件先按画框 ID、再按节点 ID 分组。两层都要求冒号格式 ID（`1:2`、`I1:2;3:4`），不能用 URL 中的连字符格式。写入前校验所有分组，包括本次不导出的分组；未启用的分组既不应用，也不标记陈旧。

```json
{
  "12:34": {
    "12:40":{"style":{"transform":"translate(12px,601px)"},"basis":{"transform":"translate(12px,603px)"},"note":"Move title up 2 px"},
    "12:41":{"bake":"svg","note":"Gradient stroke"},
    "12:42":{"skip":true,"note":"Annotation layer"},
    "12:43":{"bake":"ref","note":"Background-dependent glass search box"}
  }
}
```

条目只允许 `style`、`basis`、`skip`、`bake`，以及必填且非空的 `note`。Style/basis 把符合 `-?[a-z][a-z-]*` 的 CSS 属性名映射到字符串。值必须是安全的单条声明值：不含分号/花括号、换行、反斜杠、引号、注释开头或 `url(`，圆括号和方括号必须配平。这可防止吞掉后续声明或引入外部资源。`skip` 为布尔值，`bake` 为 `svg` 或 `ref`；ref 条目只允许另带 `note`。

| 键 | 效果 |
|---|---|
| `style` | 覆盖生成的声明；空字符串删除属性。位置始终用 `transform` 表示，包括实际输出为 left/top 的容器 |
| `basis` | 应用前比较原始生成声明；未设置的属性视为空字符串。任一不符即跳过整条。省略表示无条件应用 |
| `skip` | 省略节点及其子树 |
| `bake:"svg"` | 使用 Figma 导出的节点 SVG，必要时追加提取请求 |
| `bake:"ref"` | 省略节点/子树，按倍率放大并向外取整其 render bounds，从参考图裁切后放在画布上方；判定不能为 clean |

未使用条目进入 `overrides.stale`，形状为 `{node,kind,reason?}`，计入 `totals.stale`；没有续跑工作时，它会使退出码为 `1`：

| 种类 | 含义 |
|---|---|
| `missing` | 节点不在提取到的可见树中 |
| `changed` | basis 不匹配；reason 列出属性 |
| `invalid` | 条目无法影响输出：`root`、`no-render-bounds`、`reference-size`、`inside-ref` 或 `not-emitted` |

参考图裁切会冻结矩形内全部可见内容，包括目标子树以外的内容。后代 overrides 无法应用，记为 `inside-ref`。诊断必须明确保留这项限制。

### `check.json`

| 字段 | 含义 |
|---|---|
| `verdict`, `reason` | 判定结果，以及检查不可用的原因 |
| `expected`, `reference`, `sizeNote` | 取整后的预期尺寸与实际参考图尺寸。相差一像素时按参考图比较并标 `fractional`；差异更大时不比较 |
| `mismatched`, `aa`, `diffRatio` | 排除抗锯齿后的差异像素数、抗锯齿像素数，以及差异占整帧面积比例 |
| `blocks` | 密集差异区域 `{x,y,w,h,diffPx,bboxPx,nodes,image?}`，附前三个贡献节点 |
| `nodes`, `unattributed` | HTML 侧逐节点差异归因与无归属像素 |
| `top` | 按 HTML/Figma 两侧贡献最大值排名的前五个节点，排除根/ref 节点；包含 `px`、`htmlPx`、`figmaPx`，以及可选的 gap、shift/fix、flat 定位、几何、字体、近似项和 hint |
| `focus` | html-check 点名节点，诊断形状与 top 相同 |
| `fonts`, `cause` | Chrome 实际字体与替代情况。只有受影响节点占整帧至少一半差异像素，才标记 `font-substitution` 原因 |
| `untracked`, `missing`, `textMismatch` | 页面出现未知 data-node ID、缺少预期元素，或 `{node,figma,html}` 内容不符 |
| `refs`, `bakedShare` | 参考图裁切矩形、面积占比、覆盖内容、差异像素、边缘接缝，以及矩形并集面积占比 |
| `suggest`, `clusters`, `hints` | 依赖背景的 ref 建议、分组、不提供建议的原因、替换条目和接缝警告 |
| `zoom` | 放大比对与证据子目录 |
| `context` | 仅 html-check：overrides 恢复状态与重新生成是否逐字节相同 |
| `browser`, `checker`, `ms` | Chrome 配置、检查器指纹和耗时 |

几何类型为 `box`、`wrap`、`content-offset`、`overflow`，以及只报告的 `ink-offset`。判定规则如下：

- `fail`：`diffRatio > 0.02`。

- `pass-with-findings`：差异比例达标，但仍有结构块、参考图裁切、字体替代、top 节点阻断几何问题、结构问题或已触发的近似项簇。

- `clean`：没有上述任何情况。Focus 和 zoom 不参与判定。

- `unchecked`：无法执行比对。检查报告可出现 `REFERENCE_SIZE` 与 `RENDER_TIMEOUT`。Chrome 查找/启动失败后，本次不再检查；协议/退出失败只影响当前帧，下一帧可用新浏览器。渲染超时后，本次剩余帧也标为 unchecked。

HTML 比图使用 pixelmatch 风格的 YIQ 比较和抗锯齿处理，run 验收采用严格像素变化检测。结构与字体检查补充 HTML 差异比例。

### 中断与续跑

| Extract 结果 | 处理方式 |
|---|---|
| `409 RECONNECTING` | 分别等待 1、2、4 秒重试，之后停止 |
| `409 ACTIVE_JOB` | 不抢占，停止并记录 `stop.active` |
| 其他 `409`，或桥接访问失败 | 停止并要求先修复环境；指引优先说明该动作 |
| 其他提交拒绝 | 记录该帧 `EXTRACT_REJECTED`，继续 |
| 新 extract 等待到期 | 停止，任务 ID 进入 `pending`；原因为 `WAIT_TIMEOUT` 或 `BUDGET_EXPIRED` |
| 已有 `--from` 没有结果 | 加入 pending，继续 |
| 新 extract 中断 | 停止 |
| 已有 extract 中断 | 记录帧错误，将节点加入 remaining，继续 |
| 确定性提取失败 | 记录 `EXTRACT_FAILED`，不自动加入 remaining；重试前先检查限制/错误 |

停止后，后续帧进入 `remaining`；当前帧也进入，除非已提交任务处于 pending。中断通过 session 模块的精确未执行说明，或恢复/核验证据识别，不能只看 `executionStarted:false`，因为确定性的 extract 失败也使用该值。

`done` 列出已有页面、可复用的 extract ID，`pending` 列出未完成提取，`remaining` 列出需要重新提取的节点。第二次提取超时或停止时，保留在 pending/remaining，不能把第一版页面当作已经完成。

`--timeout` 为每次 extract 等待的 1–300 秒，缺省 30。`--budget` 为提取提交/等待的 10–600 秒，缺省 90，从预检结束后开始计时。每次等待取两种上限中的较小值，向上取整且至少一秒。成功提交过一个新 extract 后，剩余不足一秒就不再提交下一个。基于已有 extract 的生成与检查不在该预算内。

续跑指引覆盖整批，并保留 overrides、输出、no-check、timeout 和 budget 选项。可复用与 pending 任务使用 `--from`；remaining、缺页面、缺孤岛或 glass-default 帧使用 `--node`，不重复列出。先等待 pending 任务。只有续跑完成后适合进行修正时，才为缺失的 overrides 文件给占位路径。

| 退出码 | `html` | `html-check` |
|---|---|---|
| `0` | 没有下列情况 | 全部页面已检查，且没有 fail/error |
| `1` | 需要修复环境；或没有剩余工作，但仍有 errors/fail/unchecked/stale/缺孤岛/违例 | 任一页面 error、fail 或 unchecked |
| `2` | 有 pending/remaining，且未因环境修复而停止 | 不使用 |

预检错误退出 `1`。`--no-check` 有意不生成判定，本身不导致失败。`glassDefaults` 也不影响退出码，但下一条命令会要求重新提取。

### `html-check`

输入为 1–50 个页面，可重复提供 `--node`，并提供一次 `--zoom`。它不连接 Figma，也不编辑页面。应在拥有 extract 证据的项目中执行。

预检要求页面可读、带元数据，并来自当前项目中可用的倍率为 1 的 extract。每个 focus 节点必须属于输入帧之一。Zoom 任务必须是已完成的 extract，倍率大于 1 且不超过 4，参考图可解码，目标位于帧内且没有旋转。任一预检失败都会在检查前停止；Chrome 启动失败也会停止。

诊断上下文从原始 extract 重新生成。只有指纹匹配时，才通过相邻清单恢复 overrides；否则不带 overrides 诊断，并报告 `context.overrides: "unavailable"`。页面或生成器变化会产生 `context.exact:false` 并追加警告。诊断使用重新生成的上下文，实际页面 refs 则从页面本身读取。

Focus 为前五名之外的指定节点提供位移、几何与字体分析。Zoom 在第一张包含目标的页面上，以 `1/scale` CSS 像素精度比较。两者均不影响帧判定。证据覆盖普通检查目录；非浏览器类的逐页异常会记录为该页错误，然后继续下一页。

## CLI 输出

Stdout 只包含一个 JSON 对象。错误形状为 `{error,code}`，错误文字最多 2,000 字符。不要把 stderr 合并进 JSON 输出。

提交类命令默认等待并打印摘要；`--full` 打印完整记录；`--no-wait` 直接返回桥接响应。开始等待时，stderr 输出一行 `{submitted,next,reused?}` JSON，因此 CLI 被外部终止后仍可按 ID 继续。HTML 每提交一个 extract 都写一行回执。重复请求会等待原任务并返回原任务结果。

摘要 `output` 超过 16 KiB UTF-8 时，替换为读取命令。Extract 输出始终只给结构形状/读取命令，另带 `extract:{stats,islandsSkipped,warnings}`；最多展开五十个跳过 ID，以及二十条各不超过 600 字符的警告，并给出省略数量。

`cancel` 发起取消后按 `wait` 的方式等待。缺省等待三十秒，可配置为 1–300 秒：

| `waitStatus` | 含义 |
|---|---|
| `completed` | 结果已落盘 |
| `timeout` | 任务可能仍在运行；有进度时附带进度及 wait/cancel 指引 |
| `needs-review` | 恢复证据要求执行给出的核验动作 |
| `resolved` | 已核验，但原执行结果仍然未知 |

HTML 与 html-check 的 stdout 摘要限制在格式化后 16 KiB UTF-8 JSON 内，完整清单/报告保留在磁盘。HTML 最多展开十个需要关注的帧，每帧 top、suggestions、hints、refs、stale 各最多三项；超限时依次去掉详情、帧列表和续跑列表，最终只指向 `html.json`。字体表最多展开十行。html-check 同样逐级去掉详情，再只保留非 clean 页面，最后去掉页面列表；完整 focus、context 和 warnings 留在逐页报告。

| 退出码 | 通用命令 |
|---|---|
| `0` | 成功 |
| `1` | 失败、画面核验失败/不可用、跳过/拒绝清理、跳过显式孤岛或提取二进制不完整，或已核验但结果未知 |
| `2` | 尚未完成：等待超时或待核验。对 stop，表示已接受关闭，但约五秒后仍未释放锁；应稍后检查状态 |

HTML 专用退出码与 frames 输出见上文。网络错误保持区分：`SANDBOX_BLOCKED` 表示 localhost 访问被拒绝，`BRIDGE_DOWN` 表示会话端口无响应，`BRIDGE_TIMEOUT` 表示请求超时，`NO_SESSION` 表示缺少会话文件。

`report --since` 接受 ISO 日期/时间；带时间时必须提供 `Z` 或时区偏移，只有日期则按 UTC 零点处理。`jobs.failed` 统计 `ok:false`；`jobs.verifyFailed` 统计执行成功但画面核验失败/不可用的任务，两者互斥。

## 取帧文件名

--dump 使用取整后的采样时刻保存原尺寸 PNG，例如 0.300s.png。不同采样时刻舍入到同一毫秒可能重名，一次调用中应避免这种组合。
