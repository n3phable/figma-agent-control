# 使用指南

[English](../agent-guide.md)

## 可用命令

`help`, `init`, `result`, `wait`, `connect`, `status`

在项目工作目录运行 CLI，使用 help 查看本版本的具体语法。

```sh
figma-agent-control help
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
```

## 连接插件

```sh
figma-agent-control connect
```

保持前台进程运行。在 Figma Desktop 导入返回的 manifest，打开绑定文件并运行开发插件；另一终端可用 status 查看连接。
