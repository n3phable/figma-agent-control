# 架构

[English](../architecture.md)

## 职责与依赖

- **工作目录绑定与存储:** `src/project.mjs` 解析 Figma design/file URL，把格式 2 的绑定存入 `.figma-agent-control/binding.json`。原子写入在新内容完整后才替换目标文件。`pluginHome` 选择全局插件目录；`installPlugin` 只重写内容变化的文件。

- **配对、锁与租约:** `src/session.mjs` 管理全局配对凭证、项目独占锁和中断任务恢复。只有已退出的 PID 才允许接管旧锁。`src/connection.mjs` 管理插件租约；活动任务阻止转移，被拒绝的请求不续租。

- **持久化结果:** `src/record.mjs` 以 `result.json` 为完成提交点，比较快照并生成摘要和退出码。等待只观察证据，不提交新任务。`src/report.mjs` 汇总已完成记录，分别统计执行失败和画面检查失败。

- **离线 CLI:** `bin/figma-agent-control.mjs` 分派 `src/args.mjs` 声明的命令。此阶段提供 `help`、`init`、`result` 和 `wait`；参数错误输出 JSON 并以非零状态退出。`result` 和 `wait` 按任务 ID 读取本地证据。

- **插件传输中继:** `plugin/ui.html` 串行处理轮询与结果回传 tick。它只接受 ID 和 channel nonce 匹配的任务回复，在所属桥接不可用时保留结果，并区分配对、版本和外部任务错误。

- **插件读取引擎:** `plugin/main.js` 为读取操作校验绑定文件和目标。inspect 返回目标及显示祖先链；preview 导出所请求的范围内节点；variables 跟随本地默认模式别名并统计目标子树绑定。`src/png.mjs` 处理 PNG 证据。

- **本机桥接与状态:** `connect` 持有前台桥接进程并安装生成的开发插件。`src/bridge.mjs` 监听端口 32523，区分 CLI 与插件凭证；`src/client.mjs` 是 CLI 的 HTTP 边界。`status` 提供会话和插件连接状态。同一台机器只运行一个项目桥接。

- **任务交付与完成:** 桥接每次交付一个任务，交付前保存任务身份。重复请求 ID 返回原任务，并拒绝同 ID 的内容变化。首次原子写入的 `result.json` 为最终结果。CLI 在此阶段提供 `inspect`、`preview` 和 `variables`，回执给出后续等待的任务 ID。

- **插件脚本执行:** 插件把脚本编译为接收 `figma`、`target` 和 `data` 的函数体，校验目标，获取需要的高风险确认，并等待写前快照保存完成。目标复核发生在前图导出之前。Undo 边界包围脚本执行。脚本获得完整 Plugin API；快照和画面检查覆盖选中的目标。

- **run CLI 与诊断:** `run` 接受脚本文件、重复的 `--lib` 文件、JSON `--data`、目标/深度选项及可选画面预期。它先输出任务回执，再等待证据。`doctor` 诊断绑定、会话、插件和待处理任务。结果不明且可能已执行的写入需要先检查。

- **关闭与未知写入:** `stop` 关闭本机桥接并保留未完成证据。已交付但没有结果的写入会阻止后续写入。先停止旧插件，在当前会话 inspect 原目标，再执行 `resolve <job-id> --inspect <inspect-id> --previous-plugin-stopped`。resolve 记录核验，不撤销改动，也不把未知结果当作成功。
