# Agent 使用指南

[English](../agent-guide.md) · [中文文档索引](README.md)

Figma Agent Control 只有一个执行原语：以绑定范围内的节点为目标，运行可信的 Plugin API 脚本。`inspect`、`preview`、`variables` 和 `extract` 是内置只读操作；其他命令管理连接、解释证据，或分析与导出结果。

## 开始

使用前先运行 `command -v figma-agent-control`。命令不存在时，按[源码安装说明](../../README.md#install-from-source)处理。全局命令和 Skill 安装属于单独的环境设置，应遵循用户选择的安装范围；已经授权的安装无需再次确认。如果已有源码但没有全局命令，可以定义 shell 函数：

```sh
fac() { node /path/to/figma-agent-control/bin/figma-agent-control.mjs "$@"; }
```

使用该函数时，把工具返回指令中的 `figma-agent-control` 换成 `fac`。不要把包含空格的完整命令放进变量：zsh 不会把它拆成命令和参数。参数列表在 bash/zsh 中使用数组，以 `"${args[@]}"` 展开。

项目已有绑定目录时就在该目录工作。核验另一个范围时另建目录：

```sh
mkdir my-design
cd my-design
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
figma-agent-control connect
```

`connect` 在前台常驻，应保持该终端运行。首次在 Figma Desktop 的 **Plugins → Development → Import plugin from manifest** 导入返回的 manifest，然后在绑定文件中运行插件。在另一个终端切到同一目录：

```sh
figma-agent-control status
figma-agent-control doctor
```

`connected` 为 `true` 后开始工作。当前工作目录就是项目根目录，CLI 不向上查找。

- 绑定节点是默认 `target`；`--node` 必须位于它的范围内。脚本可使用完整 `figma` 对象。快照、变更集和画面判定覆盖选中的目标子树，也会反映主组件修改等间接影响。目标应覆盖全部授权写入。

- 一个桥接同一时刻只执行一个任务。多个 Agent 应顺序取数，再离线并行分析。

- 结束时，对本次启动且不再需要的桥接运行 `figma-agent-control stop`。它停止本机桥接，文档同步在 Figma 中检查。退出码 `2` 表示仍在收尾，稍后查看 `status`。

## 写脚本

脚本是 JavaScript 函数体，可使用 `figma`、`target`、`data` 及 `--lib` 提供的函数，用 `return` 返回结果。

```js
// rename.js
const previous = target.name;
target.name = data.name;
return { id: target.id, previous, name: target.name };
```

```sh
printf '%s' '{"name":"Account card"}' | figma-agent-control run rename.js --node 12:34 --data /dev/stdin
```

参数使用 `--data file.json`。少量参数可通过管道或 heredoc 传给 `/dev/stdin`；可移植 shell 脚本中避免 `--data <(...)`。输入会记入 `job.json`。相关批量修改应在一个脚本里遍历输入数组，而不是每个节点提交一个任务。

### 选择目标

| 工作 | 目标与快照深度 |
|---|---|
| 自定义只读脚本 | `run --depth 1` 可降低快照开销，但仍遵循 run 生命周期 |
| 覆盖全部写入的共同祖先全深度不超过 2,000 个节点 | 以该祖先为目标，不加 `--depth`，保留嵌套变化证据 |
| 跨更大页面或 Section 的写入 | 保留正确的共同祖先，显式声明深度；页面→Section→画框通常用 `--depth 2` |
| 可见改动或应保持画面的重构 | 对最小相关目标加 `--expect changed` 或 `--expect unchanged` |

浅快照以细节换覆盖范围：更深的变化看不到，跨越深度边界的移动显示为新增或删除。不要把 `--node` 指向无关的小节点来绕过预算，否则写前证据、最终复核和变更集都会覆盖错误的内容。

避免给页面加 `--expect`，因为它会导出整个目标两次；改用单帧预览。优先原地更新画框，以保持 ID 和链接稳定。批量修改时，在同一脚本里读回关键尺寸、布局模式、文字和绑定，确认 Auto Layout 完成后的最终结果。

节点标记用 `setSharedPluginData('figmaagentcontrol', key, value)`，读取用 `getSharedPluginData`。值必须是字符串，对象先序列化；空字符串删除值。命名空间、键和值合计不超过 100 kB。共享数据可被其他插件读取，不要存凭证。此开发插件没有 Figma 分配的 ID，所以不能使用 `setPluginData`。

### dynamic-page 约束

manifest 使用 `documentAccess: "dynamic-page"`。FAC 会在任务开始前加载目标页；其他页面需显式加载。这避免常驻插件每次载入整个大文件。

| 受限写法 | 替代写法 |
|---|---|
| `figma.getNodeById(id)` | `await figma.getNodeByIdAsync(id)` |
| `figma.getStyleById(id)` | `await figma.getStyleByIdAsync(id)` |
| `figma.currentPage = page` | `await figma.setCurrentPageAsync(page)` |
| `getLocalPaintStyles()`、`getLocalTextStyles()`、`getLocalEffectStyles()`、`getLocalGridStyles()`、`getLocalCustomAnimationStyles()` | 对应的 `Async` 方法 |
| `figma.getFileThumbnailNode()` | `await figma.getFileThumbnailNodeAsync()` |
| `variables.getVariableById()` / `getVariableCollectionById()` | 对应的 `Async` 方法 |
| `variables.getLocalVariables()` / `getLocalVariableCollections()` | 对应的 `Async` 方法 |
| `variables.createVariable(name, collectionId, type)` | 传入集合对象 |
| `node.setBoundVariable(field, variableId)` | 传入变量对象 |
| `setExplicitVariableModeForCollection()` / `clearExplicitVariableModeForCollection()` | 第一个参数传集合对象 |
| 读取 `instance.mainComponent` | `await instance.getMainComponentAsync()` |
| `component.instances` | `await component.getInstancesAsync()` |
| `style.consumers` | `await style.getStyleConsumersAsync()` |
| 给 `fillStyleId`、`strokeStyleId`、`effectStyleId`、`gridStyleId`、`textStyleId` 赋值 | 对应的 `set*StyleIdAsync(id)` 方法 |
| 给已弃用的 `backgroundStyleId` 赋值 | `await node.setFillStyleIdAsync(id)` |
| `setRangeTextStyleId()` / `setRangeFillStyleId()` | 对应的 `Async` 方法 |
| 给 `vectorNetwork` 赋值 | `await node.setVectorNetworkAsync(network)` |
| 读取、遍历、导出其他页面或插入它的子节点 | 先 `await page.loadAsync()` |
| `figma.root.findAll*`、`findOne`、`findWidgetNodesByWidgetId` 或 `figma.on('documentchange', ...)` | 先 `await figma.loadAllPagesAsync()`；能限定页面时优先页面遍历与 `page.on('nodechange', ...)` |

不要在 `findOne` 或 `findAll` 的回调里调用受限的同步 API。Figma 会包装这些回调，抛错时还可能弹出红色 “Plugin error”。先同步收集候选，再循环 await：

```js
for (const node of target.findAllWithCriteria({ types: ['INSTANCE'] })) {
  if ((await node.getMainComponentAsync())?.name === 'Button') {
    // 处理匹配的实例。
  }
}
```

### Figma 行为备忘

以下汇总开发中观察到的 Figma Desktop 行为。依赖关键属性前，先在当前文件中读回确认。

- **字体：** 编辑混合字体文字前，加载 `getRangeAllFontNames(0, node.characters.length)` 返回的全部字体。看似统一的文字也可能有 `fontName === figma.mixed`；空文字单独处理。

- **文字分段：** 整段赋值 `characters` 或 `fills` 可能抹掉区间颜色、字号。先读 `getStyledTextSegments`，再恢复需要的区间样式。

- **尺寸：** 先 `resize()`，再设置 Fill/Hug，最后读回尺寸。自动高度文字还需要 Hug 容器，避免裁切。

- **自动布局对齐：** 用 `MIN`/`MAX`，不用 `START`/`END`。主轴还支持 `CENTER`、`SPACE_BETWEEN`；交叉轴支持 `CENTER`，横向画框还支持 `BASELINE`。

- **新节点：** `figma.create*` 把节点放在当前页面根的 `(0, 0)`。必须显式 `appendChild` 到目标。

- **实例替换：** 嵌套覆盖按图层名迁移。新组件内部图层名不同，覆盖可能丢失；统一命名，或读回后恢复。

- **Group：** Group 与 Frame 的布局和约束行为不同；实例内 Group 的 `rescale()` 可能失败。适合时，把响应式插画行为放在主组件中定义。

- **宽高比：** `targetAspectRatio` 只读，使用 `lockAspectRatio()`。读回尺寸并检查导出，以区分缩放、裁切和拉伸。

- **颜色绑定：** 使用 `setBoundVariableForPaint` 返回的新 paint。在变量值中保留需要的 alpha；半透明 paint 绑定到不透明变量会改变画面。节点自身的 opacity 另算。

- **变量代码名：** 使用 `variable.setVariableCodeSyntax('WEB' | 'ANDROID' | 'iOS', name)`。

- **JavaScript：** 插件使用 QuickJS。观察到的运行时没有 `Intl`，本地化格式化未必添加分隔符。不要给未声明变量赋值，run 与插件共享全局环境。`String(Object.create(null))` 会抛错，这类值用 JSON 序列化。

## 读结果

先读 `instruction`，再按下一步所需查看证据：

| 字段 | 含义 |
|---|---|
| `ok`、`error`、`executionStarted` | 结果与脚本是否已开始 |
| `changes` | 目标子树的实际变化；仅绑定和仅位置变化分别计数 |
| `verify` | 请求过且脚本成功时的前后画面判定 |
| `resultFile`、`evidence` | 持久化本机证据路径 |

| 退出码 | 含义 | 行动 |
|---|---|---|
| `0` | 成功 | 继续 |
| `1` | 执行或画面判定失败、清理/提取不完整，或已核验但结果未知 | 读 `instruction`；只有 `executionStarted:false` 能证明脚本未开始 |
| `2` | 尚未结束或需要核验 | `waitStatus:timeout` 时等待原 ID；`needs-review` 时走核验流程 |

### 解析输出

stdout 是一个 JSON 对象。提交命令在开始等待前向 stderr 写回执：

```json
{"submitted":"<job-id>","next":"figma-agent-control wait <job-id>"}
```

两个流分开保存：

```sh
figma-agent-control run page.js --depth 2 > out.json 2> receipt.log
code=$?
jq '.output' out.json
```

外部工具在等待期间终止 CLI、stdout 为空时，从 `receipt.log` 取 ID，再 `wait <job-id>`。`--no-wait` 直接在 stdout 返回 ID，不写这行回执。

结果只按任务 ID 定位：摘要的 `id`、`result <id>`、`wait <id>`，或 `run --request-id` 指定的新小写 UUID。同一 ID 只返回原任务，不会再次执行。不要按目录时间找“最新”结果。

默认摘要仅在 `output` 不超过 16 KiB 时内联，否则给读取命令。原始 `result.json` 的值在 `.output`；`--full` 的 CLI 输出是记录，值在 `.result.output`，二进制路径相对 `.evidence`。preview 摘要给出 `images[].name` 和绝对路径 `images[].file`。

### 串联脚本

每个脚本有独立证据与 Undo 边界。第一个非零退出就停止，避免继续修改半成品：

反复执行的序列存为带参数的项目脚本。`break` 本身返回零，应先保存失败码，或在合适的 shell 脚本中使用 `set -e`。退出码 `2` 时停下，等待或核验该任务，不能跳到下一步。

## 画面验收

`--expect changed` 检查目标导出像素是否改变；`--expect unchanged` 适用于应保持外观的 Token 绑定或重构。`--tolerance <pixels>` 放宽的是变化像素数量。

目标会导出两次，应选最小相关范围。蒙版、隐藏层和上方位图可能遮住属性变化，赋值后还应检查渲染结果。判定覆盖目标自身导出；其他区域使用 `preview` 和 `image-diff <before> <after> --expect changed|unchanged` 检查。

### 预览与批量导出

更大批量可直接返回字节：

```js
// export.js
const output = [];
for (const section of target.findAllWithCriteria({ types: ['SECTION'] })) {
  for (const node of section.children.filter(n => n.type === 'FRAME')) {
    output.push({ section: section.name, name: node.name, id: node.id,
      png: await node.exportAsync({ format: 'PNG', useAbsoluteBounds: true,
        constraint: { type: 'SCALE', value: data?.scale ?? 0.5 } }) });
  }
}
return output;
```

```sh
figma-agent-control run export.js --depth 1 > out.json 2> receipt.log
```

从原始 `result.json` 读取 `.output[].png.file`，路径相对证据目录。交付文件名带上节点 ID，防止重名或空名相互覆盖。

不要把导出内容转成 base64 字符串。任意嵌套的字节值走独立二进制通道：每任务最多 200 项，含画面判定图片在内的 base64 总量最多 48 MB。过大的字符串结果可能丢失整个返回值。大批量降低倍率或拆批。`useAbsoluteBounds:true` 按节点盒子导出，普通预览可能包含盒外投影。

## 导出 HTML

`html` 把画框或已保存的 extract 生成为固定尺寸的自包含 HTML。默认用 Chrome 与同一次 extract 的参考图比较；`--no-check` 只生成。

```sh
figma-agent-control html --node 12:34 --out out
figma-agent-control html --from <extract-job-id> --out out
figma-agent-control html-check <page.html>
```

完整清单在 `<out>/html.json`，比较证据在 `.figma-agent-control/check/<extract-job-id>/`。通过 `--overrides <file.json>` 记录修正，随后重新生成。

先读 `instruction`。退出 `2` 时等待列出的 pending 提取，再执行覆盖完整批次的续跑命令。每批最多 50 帧，默认每次提取等待 30 秒，提交/等待预算为 90 秒。

## 出错时

| 信号 | 处理 |
|---|---|
| `SANDBOX_BLOCKED` | 执行环境禁止 localhost；走其授权机制 |
| `NO_SESSION`、`BRIDGE_DOWN` | 运行 doctor，需要时重连 |
| `RECONNECTING` | 打开绑定文件并运行插件，doctor 给具体原因 |
| 多个插件诊断原因 | 先处理第一条 error，其余 warning 供参考 |
| `PAIRING_MISMATCH` | 移除旧的重复插件，导入 doctor 指出的 manifest |
| `WRONG_FILE` | 在绑定文件运行插件 |
| `NO_FILE_KEY` | 确认使用 Figma Desktop 和生成的开发插件 |
| `FOREIGN_JOB` | 重连原项目，让它收到待回传结果；不要随意重启插件丢掉结果 |
| `PLUGIN_OUTDATED` | 更新工具后重新运行开发插件 |
| `ACTIVE_JOB` | 等待已有任务 ID |
| `REVIEW_REQUIRED` | 停止旧插件，inspect 原目标，再用该 inspect ID resolve |
| Figma “Plugin error” | 查看任务错误，把受限 API 调用移出 Figma 包装的回调 |
| stop 退出 `2` | 稍后看 status，按 recovery 处理被中断任务 |

结果未知的写入用：

```sh
figma-agent-control inspect --node <original-target-id>
figma-agent-control resolve <original-job-id> --inspect <inspect-job-id> --previous-plugin-stopped
```

该标志声明旧插件确实已停止。inspect 必须来自当前会话，且直接查询原任务目标。resolve 结束未决等待，不重放、不撤销。中断的只读任务可以重提；不要清空 `runs/` 绕过核验。

`report --since <ISO-time>` 汇总耗时、空档、重复执行、执行失败 `failed` 与画面验收失败 `verifyFailed`。提供时刻时必须带时区；仅日期按 UTC 零点解释。

## 限制

- Plugin API 操作在当前 Figma 文件中进行；处理另一个文件时使用独立绑定。

- 云端同步在 Figma 中检查。

- 插件数据使用命名空间 `setSharedPluginData`，适用于生成的开发插件 manifest。

不要把 `.figma-agent-control/` 提交到版本控制，其中有凭证和设计证据。只交付需要的产物，保留尚未核验的证据，完成后停止本次启动且不再需要的桥接。

## 连接范围

桥接使用端口 32523，同一台机器只保留一个项目桥接运行。全局插件可在桥接重启后重连；连接另一个项目前先停止原项目。
