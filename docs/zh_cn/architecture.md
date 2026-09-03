# 架构

[English](../architecture.md)

## 职责与依赖

- **工作目录绑定与存储:** `src/project.mjs` 解析 Figma design/file URL，把格式 2 的绑定存入 `.figma-agent-control/binding.json`。原子写入在新内容完整后才替换目标文件。`pluginHome` 选择全局插件目录；`installPlugin` 只重写内容变化的文件。

- **配对、锁与租约:** `src/session.mjs` 管理全局配对凭证、项目独占锁和中断任务恢复。只有已退出的 PID 才允许接管旧锁。`src/connection.mjs` 管理插件租约；活动任务阻止转移，被拒绝的请求不续租。

- **持久化结果:** `src/record.mjs` 以 `result.json` 为完成提交点，比较快照并生成摘要和退出码。等待只观察证据，不提交新任务。`src/report.mjs` 汇总已完成记录，分别统计执行失败和画面检查失败。
