# 使用指南

[English](../agent-guide.md)

## 可用命令

`help`, `init`, `result`, `wait`, `connect`, `status`, `inspect`, `preview`, `variables`, `run`, `doctor`

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

## 读取目标

```sh
figma-agent-control inspect
figma-agent-control preview --node 12:34
figma-agent-control variables
```

按回执中的任务 ID 读取 result 或继续 wait。

## 提交脚本

```sh
figma-agent-control doctor
figma-agent-control run <script.js> --node 12:34
```

脚本是可使用 figma、target、data 的函数体。目标范围决定快照覆盖；完整 Plugin API 仍可访问当前文件。读 instruction、executionStarted 和已保存结果后再决定下一步。
