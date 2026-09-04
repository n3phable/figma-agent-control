# Figma Agent Control

[English](README.md) | [Simplified Chinese](README_ZH.md)

本机 Figma 自动化的工作目录绑定、执行与证据模块。

## 功能

- 将工作目录绑定到 Figma 文件和节点范围。
- 管理本机配对、桥接锁和插件租约。
- 读取持久化结果、比较快照并汇总任务结果。
- 通过 CLI 初始化绑定，读取或等待已保存任务。

## 从源码安装

Node.js 22+

```sh
npm link
figma-agent-control help
```

`help`, `init`, `result`, `wait`

[使用指南](docs/zh_cn/agent-guide.md) · [协议](docs/zh_cn/protocol.md) · [架构](docs/zh_cn/architecture.md) · [MIT](LICENSE)
