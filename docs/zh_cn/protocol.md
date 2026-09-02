# 协议与证据

[English](../protocol.md)

## 工作目录绑定与存储

`src/project.mjs` 解析 Figma design/file URL，把格式 2 的绑定存入 `.figma-agent-control/binding.json`。原子写入在新内容完整后才替换目标文件。`pluginHome` 选择全局插件目录；`installPlugin` 只重写内容变化的文件。

## 配对、锁与租约

`src/session.mjs` 管理全局配对凭证、项目独占锁和中断任务恢复。只有已退出的 PID 才允许接管旧锁。`src/connection.mjs` 管理插件租约；活动任务阻止转移，被拒绝的请求不续租。
