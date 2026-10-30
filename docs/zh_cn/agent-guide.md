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

- 面板隐藏后长轮询仍可继续。桥接重启后的重连可能要等被节流的计时器；Figma 也可能限制不可见窗口或后台文件，见[任务迟迟不结束](#任务迟迟不结束)。

- 插件文件变化可能触发 Figma 开发插件重载。面板提示版本过旧时重新运行插件；页脚版本应与 `status.pluginVersion` 一致。

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

复用 helper 时使用 `--lib helpers.js`。每个库在单独的外层作用域运行，先给的在最外层；正文中的同名声明可以遮蔽它。裸库名选择内置库，例如 `--lib motion` 或 `--lib prototype`。

参数使用 `--data file.json`。少量参数可通过管道或 heredoc 传给 `/dev/stdin`；可移植 shell 脚本中避免 `--data <(...)`。输入会记入 `job.json`。相关批量修改应在一个脚本里遍历输入数组，而不是每个节点提交一个任务。

### 选择目标

| 工作 | 目标与快照深度 |
|---|---|
| 内置读取或预览 | 使用 `inspect`、`preview --node` 或 `preview --name` |
| 自定义只读脚本 | `run --depth 1` 可降低快照开销，但仍遵循 run 生命周期 |
| 覆盖全部写入的共同祖先全深度不超过 2,000 个节点 | 以该祖先为目标，不加 `--depth`，保留嵌套变化证据 |
| 跨更大页面或 Section 的写入 | 保留正确的共同祖先，显式声明深度；页面→Section→画框通常用 `--depth 2` |
| 可见改动或应保持画面的重构 | 对最小相关目标加 `--expect changed` 或 `--expect unchanged` |
| 先删后建内容 | 加 `--clean-on-fail`，并理解它不能恢复先删掉的原内容 |

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
| 给 `reactions` 赋值 | `await node.setReactionsAsync(reactions)`，或使用 prototype 库 |
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

- **错误：** QuickJS 可能丢失 `await` 之前的调用方；宿主 API 拒绝也可能只是无 stack 的字符串。诊断时结合现有堆栈和调用点证据。

## 读结果

先读 `instruction`，再按下一步所需查看证据：

| 字段 | 含义 |
|---|---|
| `ok`、`error`、`executionStarted` | 结果与脚本是否已开始 |
| `changes` | 目标子树的实际变化；仅绑定和仅位置变化分别计数 |
| `verify` | 请求过且脚本成功时的前后画面判定 |
| `pageRoot` | 非页面目标的成功 run 执行后，页面根直接子节点的增减 |
| `trace` | 最多十个映射后的错误帧 `{file, line, column, source}`；第一项为抛错处 |
| `created`、`cleaned`、`cleanFailed`、`deletedExisting`、`createdAssets` | 部分写入和清理证据 |
| `progress` | 结果尚未完成时的最新执行进度 |
| `resultFile`、`evidence` | 持久化本机证据路径 |

即使目标变更计数为零，`pageRoot` 也可能暴露遗漏的 `appendChild`。它比较前后状态，不判断改动来源：同期协作者或替换 ID 的操作也会出现。删除前先 inspect。

内置库的帧名是 `lib:motion` 或 `lib:prototype`，用户库用文件名。动态生成代码导致 `trace[0].source` 不可信时，查看 `result.json` 中原始 `stack`；无法映射时摘要回退到原始 stack 的前 500 字符。

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

```sh
code=0
for step in colors layout content; do
  figma-agent-control run "scripts/$step.js" --lib helpers.js --data data.json --clean-on-fail > "out-$step.json" 2> "receipt-$step.log" || { code=$?; break; }
done
# code 非零时，先检查 out-$step.json。
```

反复执行的序列存为带参数的项目脚本。`break` 本身返回零，应先保存失败码，或在合适的 shell 脚本中使用 `set -e`。退出码 `2` 时停下，等待或核验该任务，不能跳到下一步。

### 脚本中途失败

`executionStarted:true` 表示此前写入可能已生效。**禁止重放脚本。** 先 inspect 当前文档，只修正仍需要处理的部分。

- `created` 列出目标页上新建、仍存在的最高层节点 `{id,name,type,parentId,size}`；后代随父节点处理。新容器可能装有已有内容，先检查其子树。

- `clean <job-id>` 把符合条件的证据转换为普通 run。它复核原页面、名称、类型、父节点和自有后代数。不存在的记 `output.gone`，不匹配的记 `output.skipped` 并退出 `1`。原证据不改写；可以重复执行，但不能识别所有被移进新容器的已有图层。

- `--clean-on-fail` 在脚本的结束 Undo 边界成功后立即尝试清理，并为清理单独提交边界。执行前已在目标页的节点及包含它们的新容器受保护。删除成功记 `cleaned`，受保护或失败记 `cleanFailed`。

- `deletedExisting` 表示执行期间已有节点消失，同时清理又删了新节点。`detachInstance`、`flatten` 等会替换 ID，让已有内容看起来像新建。先 inspect；若清理删了应保留的内容，可在 Figma 中有意识地 Undo 一次恢复清理步骤，但不会撤销更早的脚本修改。

- `createdAssets` 列出新集合、变量和样式，两种清理都不删除它们。应明确复用或删除，不要重建同名副本。

清理后，已有节点的改名、修改、移动和删除仍然保留。先删后建的脚本经清理后可能留下空位；撤销清理步骤会恢复未完成的替代品。原有改动应单独 inspect 并明确修复。

限制包括：只观察目标页，且只处理脚本自身抛错，不处理之后的序列化失败；新组件可能不发创建事件；运行期间本地用户新建的内容可能被计入，远端协作者事件被排除；从其他页面移入的已有内容不受即时清理保护。监听失败记警告。结束 Undo 边界失败时只列节点，不自动清理。摘要清单各最多 50 项，超出部分给省略计数。

### 任务迟迟不结束

不可见或最小化的 Figma 窗口可能严重限制计时器和宿主调用。`connectionState:BACKGROUND` 与 `progress.hidden:true` 是提示；在判断脚本卡死前先让窗口可见。

`status.progress` 和等待到期的摘要说明执行阶段：

```json
{"phase":"script","elapsedMs":372000,"changes":132,"waitingCount":1,"ageMs":4000,"waiting":[{"call":"figma.loadFontAsync","forMs":360000,"at":{"file":"edit.js","line":52,"source":"await figma.loadFontAsync(font);"}}]}
```

- `prepare` 包括取目标、快照、写前日志和前图；`approval` 等面板确认；`script` 执行正文；`finish` 收集证据。大目标会拖慢准备和收尾。

- `waiting` 记录代理上的 `figma.*Async` 及支持的命名空间。节点方法如 `exportAsync`、脚本自己的 Promise 不在其中。

- `changes` 增长说明仍有进展，继续等。调用长期停滞时，`cancel <job-id>` 请求取消并等待结果。

- 开始前取消给 `executionStarted:false`。执行中取消走普通失败/清理路径，可取得位置时 trace 指向等待中的调用。

- 取消不能终止所有挂起的 JavaScript 续体。之后经代理访问 `figma` 会抛错，但挂起调用恢复后，仍可能通过此前取得的节点直接写入。要终止该续体，需要关闭并重新运行插件。不要把杀掉 Figma 或全局 Undo 当成通用恢复步骤。

进度计时器和失败清理本身也会被节流。挂起心跳的取消通道不依赖面板计时器，但同步长循环必须先让出控制。

## 画面验收

`--expect changed` 检查目标导出像素是否改变；`--expect unchanged` 适用于应保持外观的 Token 绑定或重构。`--tolerance <pixels>` 放宽的是变化像素数量。

目标会导出两次，应选最小相关范围。蒙版、隐藏层和上方位图可能遮住属性变化，赋值后还应检查渲染结果。判定覆盖目标自身导出；其他区域使用 `preview` 和 `image-diff <before> <after> --expect changed|unchanged` 检查。

### 预览与批量导出

不指定选择器时，`preview` 导出整个绑定节点。重复 `--node` 可导出多个 ID。重复 `--name` 在绑定节点的子节点和逐层 Section 中精确匹配，不进入画框、组、组件或实例。名称缺失或歧义会在导出前拒绝整个任务；名称不唯一时用 ID。

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

## 动效

使用 `--lib motion` 访问 Figma Motion 的 Beta/private API。生成的 manifest 开启 `enablePrivatePluginApi`；接口能否使用及其行为取决于 Figma 和账户。完整约定见[协议中的 MotionSpec](protocol.md#motionspec)。

```sh
printf '%s\n' 'return readMotion(target)' > read-motion.js
printf '%s\n' 'return exportMotion(target)' > export-motion.js
figma-agent-control run read-motion.js --lib motion --node 12:34 --depth 1 > motion-old.json
jq '.output | del(.issues)' motion-old.json > motion.json
```

编辑 `motion.json` 后，用这样的脚本应用：

```js
// apply-motion.js
const before = (await exportMotion(target)).video;
const result = await applyMotion(data);
try {
  return { ...result, video: (await exportMotion(target, undefined,
    { differentFrom: before, waitSeconds: 200 })).video };
} catch (error) {
  // 写入已完成，稍后只重试视频导出。
  return { ...result, exportError: String(error.message) };
}
```

```sh
figma-agent-control run export-motion.js --lib motion --node 12:34 --timeout 120 > video-old.json
figma-agent-control run apply-motion.js --lib motion --node 12:34 --data motion.json --timeout 300 > applied.json
figma-agent-control frames <before-video-job-id> --compare <after-video-job-id> --dump
```

先读后改。原样 spec 不产生写入；省略节点或字段则保持原状，新增预设不写 `id`。关键帧为 `[秒,值,缓动?]`，缓动作用于**以该关键帧结束**的一段；第一帧的缓动不生效。优先以 `$name` 使用已有 EASING 变量，自定义样式用 `@name`。

应修正 `beyond-timeline`、`first-key-easing`、`static-track`、`track-conflict`。时长、尾部空闲、原始/不一致缓动、交错间隔等由设计意图决定。`readMotion(target,{durationRange:[0.1,1]})` 可调整时长检查范围。

在快照预算内，写入以顶层画框为目标且不声明浅深度。变更集可记录 `manualKeyframeTracks`、`animationStyles`、`timelines`。组件/变体集本身不能写动效，其子图层可以；实例子图层继承动效、不能直接改，实例本身可以。不要未经授权就 detach 实例来绕过限制。

静态 PNG 不反映关键帧，不要用 `--expect` 验收动效。导出视频并看联系表。视频导出可能落后于修改，或对新画框暂时失败；`exportMotion` 会重试 `Video export failed`，`differentFrom` 还会等待字节变化。应保持画面的修改不要设置 `differentFrom`。套餐可能限制分辨率、帧率和导出参数。

其他开发观察：关键帧不更新静态 `x`/`opacity`；超出时间线的动效可能被接受，但播放会截断；旋转以节点中心为轴，正值逆时针；第一帧之前使用该帧的值。COLOR 关键帧为 RGBA，不是颜色变量别名。依赖 TIMING 变量单位或 Beta 行为前，应在当前编辑器中核验。

## 原型

用 `--lib prototype` 读写 reactions 与页面流程起点。优先绑定页面，因为可达性和死路检查需要页面根。完整格式见[PrototypeSpec](protocol.md#prototypespec)。

```sh
printf '%s\n' 'return readPrototype(target)' > read-prototype.js
printf '%s\n' 'return applyPrototype(data)' > apply-prototype.js
figma-agent-control run read-prototype.js --lib prototype --depth 1 > prototype-old.json
jq '.output | {flows, nodes, overlays}' prototype-old.json > prototype.json
# 编辑 prototype.json 后再应用。
figma-agent-control run apply-prototype.js --lib prototype --data prototype.json > applied.json
```

- 修改 `nodes[].reactions` 与 `flows`。列出的节点按 spec 对齐，`[]` 清空连线；省略的节点不动。省略 `flows` 保留当前起点，包括 Figma 自动新增的起点。`overlays` 只读；targets、frames、edges、issues 是派生信息，应用时忽略。

- 连线是 `{on,do:[动作]}`。示例为 `click`、`after 0.8`、`{navigate:"12:34"}`、`transition:"smart-animate 0.3 ease-out"`。库内时间以秒计。原型弹簧使用 `spring(mass,stiffness,damping)`，不同于 Motion 的 `spring(bounce)`。

- navigate/swap/overlay 目标须为同页顶层画框，即页面或 Section 的直接子节点。scroll 目标在源画框内；change-to 目标在同一变体集内。overlay 的 `position` 要求 Figma 中设为 Manual。

- 实例和实例子图层可写 reactions；子图层写入为按 trigger 与主组件合并的覆盖。Section 与组件集本身没有 `setReactionsAsync`。

- 写入时保持 Figma 在前台。后台 `setReactionsAsync` 曾出现超时。拒绝后库会尝试回滚；先读错误并 inspect，再决定是否重试。

- `drag` 要求 Smart Animate，URL 动作接受 click/after；多个动作、变量动作、条件分支可能受套餐限制。

- 顶层画框首次有出向连线时，Figma 可能自动加流程起点。库在连线之后写显式 `flows`，确保请求的集合最终生效。

- 与本次写入有关的 `error` 在写前拒绝。Smart Animate 图层不匹配、不可达、死路等 warning 按设计判断。

- 核验返回的 `changes` 和重读的 `prototype`。浅页面快照可能看不到深层连线变化。`--expect` 不验证交互效果，真实点击仍需在 Figma 中测试。

`variables` 将原型的 `prototypeRefs` 与视觉属性的 `bindings` 分开报告。删变量前两者都要检查。

## 导出 HTML

`html` 生成固定尺寸、资源内联的 HTML，并与同一次 extract 的参考 PNG 比较。比对需要 Chrome；`--no-check` 只生成。[HTML 协议](protocol.md#html-导出)定义清单与诊断。

```sh
figma-agent-control inspect --depth 1
figma-agent-control html --node 12:34 --node 12:56 --out out
```

无论退出码是什么，先读 `instruction`。它给出的命令覆盖完整批次：可复用的提取用 `--from`，需要重取的帧用 `--node`。续跑保持原 `--out` 和选项；`html.json` 会作为本次调用的完整清单整体重写。

### 读 HTML 诊断

完整结果在 `<out>/html.json`；逐帧证据在 `.figma-agent-control/check/<extract-job-id>/`。`block-<n>.png` 纵向拼接参考、渲染、差分裁图。stdout 只摘要需要关注的帧。

| 字段 | 含义 |
|---|---|
| `verdict` | `fail` 为差异超过 2%；`pass-with-findings` 为像素达标但仍有发现；`clean` 两者都没有；`unchecked` 未能比较 |
| `top` | 差异最大的节点，取 HTML/Figma 两侧归因的较大值排名 |
| `top[].hint`、`fix` | 位移搜索结果，以及适合时可直接使用的 transform 与原值 basis |
| `suggest` | `bake:"ref"` 候选；先看冻结面积与 `textNodes` |
| `hints` | 未给建议的原因、已有 override 冲突或裁图边缘接缝 |
| `totals` | 全批次近似项、几何发现和字体统计 |

`glass`、`background-blur`、`blend-shadow`、`blend-mode`、`island-vetoed` 依赖背景。`needs-island` 需要 Figma 导出的 SVG；`--node` 可再提取一次，`--from` 则可能标记 `needsExtract`。不支持的 paint、圆角平滑等其他近似保留在 `approximationNodes`。

### 修正

修正写入 overrides JSON，先按画框 ID 分组，再按节点 ID 分组。ID 用冒号形式，每项以 `note` 解释原因：

```json
{
  "12:34": {
    "12:80": {"style":{"transform":"translate(12px,601px)"},"basis":{"transform":"translate(12px,603px)"},"note":"按测量结果把标题上移 2 px"},
    "12:95": {"bake":"ref","note":"玻璃按钮依赖背景"}
  }
}
```

先修位置和文字，再考虑烘焙。把 `top[].fix` 复制到正确分组，保留 `basis`；基值变化时条目会标记陈旧，而不是静默套用旧修正。即使生成页面用 `left`/`top` 表达混合容器，override 仍写 `transform`。整份文件都会校验，包括本次未导出的分组。

字体替代要安装正确字体，不能靠 override 掩盖。`figmaMissing` 表示 Figma 自己也用了替代字体。多个帧出现同类阻断几何问题、文字丢失或不符、任何 `violations` 都应报告生成器缺陷，不要用参考裁图隐藏。

- `bake:"svg"` 把不依赖背景的形状交给 Figma，可能需要新提取；SVG 不含背后内容。

- `bake:"ref"` 裁参考图并放在画布最上方，矩形内全部可见内容连同文字都变成位图，目标子树停止生成。后代 override 以 `inside-ref` 标记陈旧，先处理建议的 `replaces`。用了参考裁图的帧不能是 `clean`。

- 不要手改生成 HTML：下次运行会覆盖，`html-check` 也会报告与重生成不一致。不要加粗描边凑分数，或冻结本来能修好的文字/位置差异。

指定节点用 `html-check <page.html> --node <id>`。放大比较先 `extract --node <id> --scale 4`，再 `html-check <page.html> --zoom <extract-job-id>`。倍率须大于 1 且不超过 4，节点不能旋转，证据需存在。focus/zoom 不改变整体结论。`html-check` 在原项目目录运行，不连接 Figma。

### 分批与停止

每批建议约十帧，硬上限五十帧；不同批次使用不同输出目录。退出 `2` 时按 instruction 先等待 pending extract，再运行完整批次的续跑命令。默认每次提取等 30 秒，提交/等待预算为 90 秒。

帧变成 `clean`、剩余发现经目视确认是可接受渲染差异，或五轮修正仍不收敛时停止。最后一种情况恢复最佳 overrides 重新生成，并说明剩余块。退出 `0` 表示配置的检查通过；交付说明中列出已接受的视觉发现和交互检查。

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

- 原型播放在 Figma 中通过人工或已授权的 UI 自动化验证。浮层设置、Sticky 和演示设备在 Prototype 面板配置；overlay 动作位置使用 Manual 模式。

- HTML 输出为固定尺寸的静态嵌套 DOM。通过 `data-node` 查节点，SVG 岛和参考裁图替换对应子树。响应式行为和原型交互由使用该产物的应用实现。

- Motion 需要账户开放 Beta/private API，字体发现当前搜索 macOS 目录；真实 Desktop 验收与自动测试分别记录。

- 插件数据使用命名空间 `setSharedPluginData`，适用于生成的开发插件 manifest。

不要把 `.figma-agent-control/` 提交到版本控制，其中有凭证和设计证据。只交付需要的产物，保留尚未核验的证据，完成后停止本次启动且不再需要的桥接。

## 取消边界

未交付的 run 可记为未执行。交付后在脚本执行阶段请求取消。准备、确认和写前日志等待使用各自的超时，随后检查返回的执行状态。

## 取帧文件名

--dump 使用取整后的采样时刻保存原尺寸 PNG，例如 0.300s.png。不同采样时刻舍入到同一毫秒可能重名，一次调用中应避免这种组合。

## 待回传结果与端口变化

发现过程按当前文件选择桥接。有待回传结果时保持原项目可用。
