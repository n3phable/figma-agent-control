# Figma Agent Control 简体中文文档

[中文项目 README](../../README_ZH.md) · [English project README](../../README.md)

Figma Agent Control（FAC）通过本机 CLI、localhost 桥接和 Figma Desktop 开发插件，让 Agent 读取与修改设计，并保留可检查的执行证据。它还支持静态 HTML 复刻、画面比对、动效与原型规范读写。

本文档翻译自当前公开英文版，命令、字段名、错误码和代码标识保持原样。安装和快速开始见[中文项目 README](../../README_ZH.md)。

| 文档 | 内容 |
|---|---|
| [Agent 使用指南](agent-guide.md) | 连接、脚本、结果、失败恢复、动效、原型和 HTML 工作流 |
| [协议与证据](protocol.md) | 请求字段、执行顺序、证据文件、规范、退出码和续跑行为 |
| [架构](architecture.md) | 进程与信任边界、模块职责、关键流程和设计取舍 |

`run` 使用当前文件的完整 Plugin API，选中的目标定义取证范围。写入结果未知时，先 inspect 并 resolve 原任务，再继续写入；云端同步在 Figma 中检查。详细步骤见使用指南。
