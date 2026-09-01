# Figma Agent Control 简体中文文档

[中文项目 README](../../README_ZH.md) · [English project README](../../README.md)

本文档翻译自当前公开英文版，命令、字段名、错误码和代码标识保持原样。安装和快速开始见[中文项目 README](../../README_ZH.md)。

| 文档 | 内容 |
|---|---|
| [协议与证据](protocol.md) | 请求字段、执行顺序、证据文件、规范、退出码和续跑行为 |
| [架构](architecture.md) | 进程与信任边界、模块职责、关键流程和设计取舍 |

`run` 使用当前文件的完整 Plugin API，选中的目标定义取证范围。写入结果未知时，先 inspect 并 resolve 原任务，再继续写入；云端同步在 Figma 中检查。详细步骤见使用指南。
