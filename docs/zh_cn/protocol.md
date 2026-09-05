# 协议与证据

[English](../protocol.md)

## 工作目录绑定与存储

`src/project.mjs` 解析 Figma design/file URL，把格式 2 的绑定存入 `.figma-agent-control/binding.json`。原子写入在新内容完整后才替换目标文件。`pluginHome` 选择全局插件目录；`installPlugin` 只重写内容变化的文件。

## 配对、锁与租约

`src/session.mjs` 管理全局配对凭证、项目独占锁和中断任务恢复。只有已退出的 PID 才允许接管旧锁。`src/connection.mjs` 管理插件租约；活动任务阻止转移，被拒绝的请求不续租。

## 持久化结果

`src/record.mjs` 以 `result.json` 为完成提交点，比较快照并生成摘要和退出码。等待只观察证据，不提交新任务。`src/report.mjs` 汇总已完成记录，分别统计执行失败和画面检查失败。

## 离线 CLI

`bin/figma-agent-control.mjs` 分派 `src/args.mjs` 声明的命令。此阶段提供 `help`、`init`、`result` 和 `wait`；参数错误输出 JSON 并以非零状态退出。`result` 和 `wait` 按任务 ID 读取本地证据。

## 插件传输中继

`plugin/ui.html` 串行处理轮询与结果回传 tick。它只接受 ID 和 channel nonce 匹配的任务回复，在所属桥接不可用时保留结果，并区分配对、版本和外部任务错误。
