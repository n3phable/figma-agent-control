# Figma Agent Control

[English](README.md) | [Simplified Chinese](README_ZH.md)

本机 Figma 自动化的工作目录绑定、执行与证据模块。

## 功能

- 将工作目录绑定到 Figma 文件和节点范围。
- 管理本机配对、桥接锁和插件租约。
- 读取持久化结果、比较快照并汇总任务结果。
- 通过 CLI 初始化绑定，读取或等待已保存任务。
- 中继已认证的插件任务，保留未被确认接收的结果。
- 在插件中检查绑定节点、导出预览并读取本地变量。
- 启动已认证的本机桥接并查看连接状态。
- 提交内置读取操作并持久化不可变的任务结果。
- 通过确认、写前快照和 Undo 边界执行可信脚本。
- 使用 run 选项提交脚本并诊断连接。

## 从源码安装

Node.js 22+

```sh
npm link
figma-agent-control help
```

`help`, `init`, `result`, `wait`, `connect`, `status`, `inspect`, `preview`, `variables`, `run`, `doctor`

[使用指南](docs/zh_cn/agent-guide.md) · [协议](docs/zh_cn/protocol.md) · [架构](docs/zh_cn/architecture.md) · [MIT](LICENSE)
