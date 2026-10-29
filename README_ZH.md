# Figma Agent Control

[English](README.md) | 简体中文



为你的编程 Agent 提供操作 Figma Desktop 的本地 CLI。查看设计，通过 Plugin API 执行可信的 JavaScript，并保存可追溯的变更证据。还可以将画框导出为自包含 HTML，再将浏览器渲染结果与 Figma 参考图比较。

Figma Agent Control（FAC）通过 localhost 桥接，把本地 CLI 连接到 Figma Desktop 开发插件。

## 功能

- **读取与编辑设计：** 查看节点树和变量，导出 PNG 预览，使用可复用的库和 JSON 输入执行 Plugin API 脚本。

- **保留证据：** 保存执行前快照、失败现场快照、变更集、导出文件、执行堆栈，以及可选的画面检查结果。CLI 等待超时后，可按任务 ID 继续等待。

- **按证据恢复：** 检查部分写入，清理本次新建的节点，取消卡住的 run，并核验结果未知的写入。

- **导出静态 HTML：** 生成嵌入资源的嵌套 DOM，在 Chrome 中比图，按节点定位差异，并应用有记录的 overrides。

- **处理动效与原型：** 通过内置库读取和应用声明式配置，导出动效视频，并查看取帧联系表。动效依赖 Figma 的 Beta/私有 API，需要这些接口可用。

## 环境要求

- **Node.js 22 或更新版本。** 运行时没有 npm 依赖，开发依赖的版本锁定在 lockfile 中。

- **Figma Desktop。** 在 Design 模式下打开目标文件，并运行开发插件；编辑需要该文件的编辑权限。

- 运行 CLI 的 Agent 需要访问**本地 shell 和 localhost**。

- HTML 比图和视频取帧需要 **Google Chrome 或 Chromium**。必要时将 `FIGMA_AGENT_CONTROL_CHROME` 设为可执行文件路径。使用 `--no-check` 生成 HTML 不需要 Chrome。

字体查找搜索 macOS 字体目录。

## 从源码安装

```sh
git clone https://github.com/n3phable/figma-agent-control.git
cd figma-agent-control
npm ci
npm link
figma-agent-control help
```

`npm link` 让 shell 可以调用 CLI。

内置的 [Agent Skill](skills/figma-agent-control/SKILL.md) 提供操作与恢复规则。选择 Agent 应从哪个位置发现它，再创建指向 Skill 目录的链接：

```sh
# 在克隆的仓库目录中运行，选择一个目标位置。
# 工作区范围：
mkdir -p /path/to/workspace/.agents/skills
ln -s "$PWD/skills/figma-agent-control" /path/to/workspace/.agents/skills/figma-agent-control

# 或全局范围：
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/skills/figma-agent-control" "$HOME/.agents/skills/figma-agent-control"
```

如果 Agent 文档指定了其他 Skill 目录，请使用那个目录。软链接让 Skill 与当前仓库保持同步；覆盖已有安装前，先检查原路径。可能需要新建 Agent 会话才能发现 Skill。

## 快速开始

为每个绑定的设计范围使用独立工作目录：

```sh
mkdir my-design
cd my-design
figma-agent-control init 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2'
figma-agent-control connect
```

`connect` 会保持在前台运行。首次使用时，在 **Figma → Plugins → Development → Import plugin from manifest** 中导入输出的 `manifest` 路径，然后在绑定文件中运行 **Figma Agent Control**。本机各项目共用这份插件安装。

在第二个终端中进入同一工作目录：

```sh
figma-agent-control status
figma-agent-control inspect --depth 1
figma-agent-control preview --node 12:34
```

当 `status` 返回 `connected: true` 时，就可以运行脚本。请将示例节点 ID 替换为你文件中的 ID：

```js
// rename.js：JavaScript 函数体
const previous = target.name;
target.name = data.name;
return { id: target.id, previous, name: target.name };
```

```sh
printf '%s' '{"name":"Account card"}' > input.json
figma-agent-control run rename.js --node 12:34 --data input.json
figma-agent-control result <job-id>
figma-agent-control stop
```

提交命令默认等待完成，并返回一个 JSON 对象。开始等待前，stderr 中的回执会给出任务 ID。如果等待到期并返回退出码 `2`，请使用 `wait <job-id>` 继续等待，不要重新提交同一次写入。

## 命令

| 命令 | 用途 |
|---|---|
| `init`, `connect`, `stop`, `status`, `doctor` | 绑定范围、管理桥接、诊断连接 |
| `inspect`, `preview`, `variables`, `extract` | 读取节点与变量、导出 PNG，或提取生成 HTML 所需的数据 |
| `run` | 执行可信脚本，支持 `--lib`、`--data`，以及可选的 `--expect changed\|unchanged` |
| `result`, `wait`, `cancel`, `resolve` | 读取证据、继续等待而不重放、取消 run，或核验未知结果 |
| `clean` | 重新检查并删除失败 run 留下的符合条件的节点，形成独立的 Undo 步骤 |
| `html`, `html-check` | 生成并比较静态 HTML，或重新检查已有导出 |
| `frames` | 从 MP4/WebM 视频取帧生成联系表，可选对比两段视频 |
| `image-diff`, `report` | 比较 PNG，或汇总任务耗时、失败与重复执行 |

```sh
figma-agent-control html --node 12:34 --out out
figma-agent-control run read-motion.js --node 12:34 --lib motion
figma-agent-control run read-prototype.js --lib prototype
figma-agent-control frames <video-job-id> --dump
```

使用 `figma-agent-control help` 查看已安装版本的准确语法。[Agent 使用指南](docs/zh_cn/agent-guide.md) 提供完整脚本示例和恢复步骤。

## 信任边界与限制

**运行可信脚本。** 脚本拥有当前文件的完整 Plugin API 访问能力。绑定定义有效的任务目标，选中的目标定义取证子树。选择覆盖全部授权写入的共同祖先，让变更集和画面检查记录完整的目标工作。

桥接监听 `127.0.0.1`，分别验证 CLI 与插件凭证，检查插件版本，并在每次写入前记录快照。写入结果未知时，先 inspect 目标并 resolve 原任务，再执行下一次写入。需要用户在插件面板确认的操作使用 `--high-risk <reason>`。

写入随脚本执行逐步生效。失败后先读 `instruction` 和 `executionStarted`，检查部分改动，再清理符合条件的本次新建节点。已有节点的修改留待明确修复。`.figma-agent-control/` 保存在本机，其中包含设计证据和会话凭证。

HTML 导出为固定尺寸的静态复刻页面。原型点击与云端同步在 Figma 中验证。操作细节见 [Agent 使用指南](docs/zh_cn/agent-guide.md#限制)和安全政策。

## 文档与开发

- [中文文档索引](docs/zh_cn/README.md)：浏览中文指南与参考文档。

- [Agent 使用指南](docs/zh_cn/agent-guide.md)：操作流程、示例与恢复。

- [协议与证据](docs/zh_cn/protocol.md)：请求、结果、文件与退出码。

- [架构](docs/zh_cn/architecture.md)：进程边界、模块与设计决策。

- 参与贡献：本地检查与贡献流程。

本项目采用 [MIT License](LICENSE)。所含材料的说明见第三方声明。由 [n3phable](https://github.com/n3phable) 维护。

## 当前命令用法

运行 `figma-agent-control help` 查看此版本可用命令。核心命令为 init、connect、stop、status、doctor、run、inspect、preview、variables、result、wait、resolve、image-diff 和 report。等待超时不代表可以重放写入。
