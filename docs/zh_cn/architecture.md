# 架构

[English](../architecture.md) · [中文文档索引](README.md)

Figma Agent Control 让 Agent 从本机 CLI 提交可信的 Plugin API 脚本，在 Figma Desktop 开发插件中执行。绑定文件必须在 Design 模式下打开，写入需要编辑权限；Agent 需要 shell 和 localhost 访问能力。

脚本获得当前文件的完整 `figma` 对象。绑定定义有效任务目标，选中的目标定义快照与画面检查的覆盖范围。系统协调可信自动化并持久化执行证据。

[协议](protocol.md)定义字段、文件和退出码，[使用指南](agent-guide.md)说明操作与恢复。模块地图链接到负责实现的源文件，不依赖会随注释变化而漂移的行号。

## 进程与信任边界

```text
Agent --shell--> CLI（每条命令一个进程）
                  |
                  | 127.0.0.1 HTTP，CLI 凭证
                  v
               桥接（前台 connect 进程）--> 项目证据
                  ^
                  | localhost HTTP，插件凭证 + 源码版本
                  |
Figma Desktop: ui.html（iframe 中继）
                  |
                  | postMessage，每任务一个通道 nonce
                  v
               main.js + extract.js --> Figma 文档
```

| 部分 | 职责 | 边界 |
|---|---|---|
| CLI | 解析输入、提交任务、读本机证据、运行主机分析 | 不直接与插件通信 |
| 桥接 | 校验、串行调度、持久化和恢复任务 | 不访问 Figma 文档 |
| iframe | 网络中继、连接/确认/状态面板 | 不能访问文档 |
| 执行端 | Plugin API、快照、脚本、读取和导出 | 不发送 HTTP，通过 iframe 中继 |

这种拆分遵循 Figma 插件环境。iframe 提供超时、可见性和长轮询所需的完整浏览器能力；文档操作留在插件运行时。生成的 manifest 只允许候选 localhost 开发端口，使用 dynamic-page，并为 Motion 等功能开启 private plugin API。Motion 的可用性随当前 Figma 版本和账户权限而定。

### 凭证与版本

[bridge.mjs](../../src/bridge.mjs)按路由区分 CLI 和插件角色，各自只接受自己的凭证。CLI 凭证每次桥接启动重新生成，存在权限为 `0600` 的项目 session 文件中。插件凭证经 [session.mjs](../../src/session.mjs)独占创建，保存在全局 pairing 文件并注入 iframe。

每个插件请求还带源码版本：拼接后的执行脚本与未注入配置的 UI 模板的 SHA-256 前十六个十六进制字符。版本不符返回 `PLUGIN_OUTDATED`，避免旧插件解释新协议。插件模板的所有字节，包括注释，都会影响版本。更新后可能要重新运行插件；页脚与 `status.pluginVersion` 可用于对照。

iframe 在接受确认或结果前，逐条核对任务 ID 和随机 nonce。

### 本机存储

[project.mjs](../../src/project.mjs)定义两个根目录：

- `<project>/.figma-agent-control/`：绑定、当前会话、锁、持久任务、恢复记录和比较证据。当前工作目录就是项目，不向父目录查找。

- `~/.config/figma-agent-control/`，或 `FIGMA_AGENT_CONTROL_HOME`：共享插件凭证和生成的开发插件文件。

`connect` 是装配点：取配对凭证、启动桥接、安装生成文件。桥接只返回文件内容，不自行写全局插件目录。安装只改写内容变化的文件，减少无意义热重载；安装失败先关闭桥接。

## 模块结构

主机侧依赖无环。完整成员清单见 [src/AGENTS.md](../../src/AGENTS.md)、[src/html/AGENTS.md](../../src/html/AGENTS.md)、[plugin/AGENTS.md](../../plugin/AGENTS.md) 和 [lib/AGENTS.md](../../lib/AGENTS.md)。

```text
bin -> args / client / bridge / session / record / clean / doctor
    -> report / image-diff / frames / html.command / project

bridge -> connection / session / png / record / project
client -> session / project
clean -> record / project
record / args / report / session -> project
image-diff -> png / record / project
frames -> png / record / project / html.chrome
doctor -> client / session / project / html.chrome

html.command -> extracts / page / overrides / summary / check / chrome
html.extracts -> client / record / session / project
html.page -> generate / fonts / match / png / project
html.generate -> css
html.check -> match / attrib / shift / layout / structure / suggest / zoom
```

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
| [clean](../../src/clean.mjs) | 把已有失败证据变成普通 run，复用写入保障，不新增操作 |
| [doctor](../../src/doctor.mjs) | 桥接不可达时仍可只读诊断绑定、锁和安装问题 |
| [png](../../src/png.mjs)、[image-diff](../../src/image-diff.mjs)、[frames](../../src/frames.mjs) | 主机分析独立于文档执行，导出证据可离线检查 |
| [report](../../src/report.mjs) | 只聚合完成证据，不改会话或任务状态 |

桥接内存状态各有明确用途：`active` 是唯一在途槽，`unresolved` 记录未知写入，`jobs` 保存本次/恢复任务，交付、完成、checkpoint、approval 各自保存进行中的写盘 Promise。重复请求共享同一持久化操作；快照和确认决定不可更改。关闭时先等写盘完成，再分类未完成任务。

### 插件与库

Figma 只加载一份 main 脚本。源码按职责分为执行端 [main.js](../../plugin/main.js) 和只读提取 [extract.js](../../plugin/extract.js)，安装时拼接，共享经典脚本全局作用域。extract 契约参与类型检查。

[ui.html](../../plugin/ui.html)串行处理领取/回传 tick，另设挂起心跳取消通道。属于其他项目的结果原样保留，不替换成传输失败。最近任务只存在面板内存中，插件重启后清空。

[Motion](../../lib/motion.js) 和 [prototype](../../lib/prototype.js) 作为库注入普通 run。它们的声明在 run 的独立嵌套作用域中，写入继承 checkpoint、Undo、变更集和证据。库先校验声明式输入，再记录反操作以尝试回滚；库的错误信息会指出失败操作及回滚结果。

run 用 `new Function` 编译，因此能触及插件全局变量。新增插件顶层名字应谨慎，脚本必须声明自己的变量。`figma` 代理记录部分异步调用和取消状态，节点保持为原 API 对象。

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
         -> 前图/资源 -> 最终同步复核
         -> Undo 边界 -> 脚本 -> Undo 边界
         -> 后快照/图与序列化
         -> 桥接落文件 -> 原子 result.json
         -> CLI 从证据生成摘要
```

写前日志先于执行持久化。最后一次准备 await 后再做最终校验，且到调用脚本前不让出控制，减少长时间确认或导出使目标状态过期的风险。

脚本结果与证据可用性分开：脚本已完成，但后快照可能不可用、画面预期可能不满足。这些都不能成为重放理由。失败脚本会给部分改动和可清理的新节点；可选清理是独立 Undo 步骤，不能恢复先前删除或修改。

### 等待与恢复

CLI 观察证据文件等待结果，等待前先向 stderr 写任务 ID。终端或工具结束等待进程后，可再次用 `wait` 读取同一份证据。requestId 标识不可变任务；同一 ID 的重复提交返回原任务结果。

`result.json` 是提交点。从未交付的 queued 任务可证明未执行；已交付而无结果的 run 是未知状态，会阻止新 run。内置读操作保持可用，以便先检查目标。resolve 要求当前会话直接 inspect 原目标，并确认旧插件停止；它结束等待，不虚构成功，也不撤销。

恢复任务仍可接受迟到结果。其他项目的结果收到 `FOREIGN_JOB`，留在 iframe 等原桥接回来。诊断优先处理它，避免通用的“重启插件”建议丢掉真实结果。

### 进度与取消

执行代理记录未返回的 `figma.*Async` 和支持的命名空间，并保留调用处 stack。进度含 prepare/approval/script/finish、耗时、页面本地改动和最早的等待调用。桥接把 stack 映射回脚本/库，并写 `progress.json` 供等待到期的 CLI 读取。

脚本开始前取消记为未执行；开始后取消让执行 race 失败，走普通部分写入路径。它不能停止挂起的宿主调用或所有续体：之后经代理访问会抛错，但此前拿到的节点仍可能直接写入。关闭/重开插件才能终止该续体。系统公开这一限制，不宣称事务式取消。

### 提取与 HTML

```text
插件 extract -> 可见树 + 参考 PNG + 位图 + SVG 岛
             -> 桥接落同次结果与文件
             -> 主机装配字体度量/资源
             -> 纯生成器输出嵌套 DOM + 占位
             -> 内联资源，写带源码指纹的页面
             -> Chrome 渲染 -> 比图/诊断 -> 证据/清单
```

插件提取 API 事实，变化较频繁的 CSS 生成规则留在主机。保存的 extract 可以用 `html --from` 离线重生成，不必重启插件。自动孤岛规则在插件中单独版本化；主机决定哪些 SVG 可安全使用，并可为 CSS 无法表达的节点追加一次提取。

依赖背景的效果需单独处理，因为 SVG 不含底层场景。自动孤岛会避开它们；主机也独立否决不安全的内联，除非 override 显式要求。参考图烘焙不同：它冻结完整矩形内的可见内容，必须持续作为限制报告。

## HTML 生成与诊断

[page.mjs](../../src/html/page.mjs)读取环境相关输入，以数据传给 [generate.mjs](../../src/html/generate.mjs)；[css.mjs](../../src/html/css.mjs)不做 I/O 或可变状态映射，因此生成确定。图片占位随后内联，生成器指纹记录源码变化。

DOM 跟随 Figma 层级，不把画布铺平，借此保留裁切、蒙版、组透明度与合成关系。transform 创建的层叠上下文可能隔离混合，因此适合的纯平移容器改用 left/top；override 契约仍统一写 transform。SVG 岛和参考裁图替换各自子树。

字体发现零运行时依赖地解析 sfnt、TTC 和可变字体命名实例。目前只搜索 macOS 用户/系统字体目录；其他平台可运行主机测试，但字体或度量缺失会影响渲染保真。字体替代会测量并报告，不会隐藏。

[check.mjs](../../src/html/check.mjs)负责执行顺序和结论，将诊断交给：

| 模块 | 回答的问题 |
|---|---|
| [match](../../src/html/match.mjs) | 排除预期抗锯齿差异后，哪些像素不同、哪里形成密集块？ |
| [attrib](../../src/html/attrib.mjs) | HTML/Figma 两侧各由哪个节点承担差异？ |
| [shift](../../src/html/shift.mjs) | 局部平移是否有用，对应哪个 transform/basis？ |
| [layout](../../src/html/layout.mjs) | 浏览器几何、换行、溢出、实际字体是否匹配？ |
| [structure](../../src/html/structure.mjs) | 预期节点和准确文字是否存在，并正确豁免主动省略/烘焙的子树？ |
| [suggest](../../src/html/suggest.mjs) | 依赖背景的参考裁图是否合理，是否产生接缝？ |
| [zoom](../../src/html/zoom.mjs) | 放大隔离节点后差异在哪里？ |

两侧归因是必要的，因为仅 HTML 一侧无法解释缺失内容原本所在的像素。两侧共享栅格与绘制顺序规则。文字结构检查捕捉低对比度像素分数可能漏掉的错字；建议裁图再经生成器复算，确保建议几何与实际输出一致。

run 验收与 HTML 比对故意采用不同定义。run 的 `diffPng` 判断像素是否变化，默认通道阈值为零；HTML 判断两个渲染器的结果是否接近，使用 pixelmatch 的 YIQ 阈值，并单列抗锯齿。混成一个算法，会漏掉微小写入变化，或把正常渲染差异大量计入。

Chrome 客户端使用调试管道，固定软件光栅与 sRGB，限制命令/等待时长，只清理自己启动的进程和 profile。每页独立浏览上下文；异常退出/协议消息会拒绝待处理命令。正常信号触发清理，SIGKILL 仍可能留下临时 profile。

overrides 是唯一支持的手工修正入口。文件先整体校验，basis 让陈旧修正可见。`html-check` 用保存的提取和指纹恢复上下文；页面被改或找不到匹配 overrides 时明确警告。focus/zoom 不改变整体判定。

## 类型检查与测试

运行时直接执行 `.mjs`/`.js` 源码，JSDoc 由锁定版本的 TypeScript 和 typings 检查。VM 测试与 Figma 安装使用同一份源码字节。

| 环境 | 范围 |
|---|---|
| [主机 tsconfig](https://github.com/n3phable/figma-agent-control/blob/main/tsconfig.json) | Node 模块与共享提取契约，不注入 Figma 全局 |
| [插件 tsconfig](../../plugin/tsconfig.json) | 带 Figma 全局的经典脚本 main/extract，不允许 Node API |
| [Motion tsconfig](../../lib/tsconfig.json) | Motion 库与注入的 target/data 声明 |
| [Prototype tsconfig](../../lib/tsconfig.prototype.json) | 独立 prototype 作用域，对应运行时嵌套库隔离 |

[提取契约](../../src/html/extract-contract.d.ts)区分插件字节、传输占位和落盘文件。外部 JSON 和动态 API 字段仍需断言，类型不能单独验证真实 Figma 行为。可选 `node tests/contract-samples.mjs <runs-directory>` 检查明确提供的提取证据，不需要或附带私有语料。

## 阴影映射

阴影外形考虑有效填充以及外侧/居中描边。spread 遵循矩形、椭圆、带填充裁切画框的实测规则；溢出内容可能需要按内容形状投影，并明确记录近似。

## 子节点绘制顺序

生成跟随提取的子节点顺序，Auto Layout 反向层叠应对照参考图检查。
