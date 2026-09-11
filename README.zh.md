# dsh-openspec

[English](README.md) | 中文

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec)（规范驱动开发）接入为 DeepSeek Harness 插件。

本插件以**内置 skill 提供方**的形式分发 OpenSpec 的 agent skill，并从插件自身的依赖树解析 `openspec` CLI——因此既不需要全局安装，也不需要往每个项目里拷一份 `.agents/skills`。

## 安装

```bash
dsh plugin add /path/to/dsh-openspec
```

重启 profile（或让 `patchReload: live` 自动接管）。六个 `openspec-*` skill 会立即出现在 skill 目录中。

## 使用

```bash
# 在任意项目目录下：
openspec init --tools agents     # 生成 openspec/ 与项目配置
```

之后在对话里驱动工作流即可——skill 靠描述路由，所以用自然语言就行：

- “帮我想想怎么加暗色模式” → `openspec-explore`
- “提一个 add-dark-mode 变更” → `openspec-propose`
- “开始实现这个变更” → `openspec-apply-change`
- “归档它” → `openspec-archive-change`

另有一条面向插件自身的人工命令：

| 命令 | 用途 |
|---|---|
| `/openspec doctor` | 查看 CLI 版本、解析到的入口、启动器状态 |
| `/openspec shim` | 把 `openspec` 启动器（重新）安装到 PATH |
| `/openspec uninstall-shim` | 移除该启动器 |
| `/openspec init <path>` | 在指定项目目录执行 `openspec init --tools agents` |

## 为什么做成插件，而不是直接安装

OpenSpec 自带的安装器有两个前提，在 DSH 内并不成立。这两条都对照当前源码验证过，不是推测：

**1. 项目级 skill 在 git 仓库之外不可见。**
`openspec init` 把 skill 写到 `<project>/.agents/skills/`。而 DSH 通过 `dsh-skill-filesystem` 中的 `findProjectRoot` 发现项目级 skill，它只探测 `.git`，别的都不认：

```js
if (await pathExists(join(current, '.git'), fs)) return current;
```

在非 git 目录下，生成的 skill 确实躺在磁盘上，却永远不会被发现。本组合包改为通过 `bundledSkillDir` 挂载它们，该机制独立于工作区的项目根判定。

**2. 裸命令 `openspec` 不在 PATH 上。**
所有 vendor 过来的 skill 正文都调用 `openspec …`。OpenSpec 假定这是全局安装；而 profile 自己的 `node_modules/.bin` *并不*在 DSH bash 工具所见的 PATH 中，且 `ctx.shellEnv` 只注入 `DSH_*` 前缀的键——所以仅仅声明一个依赖，命令依然解析不了。因此本插件会物化一个小启动器，写进已在 PATH 上的目录，并且绝不覆盖不是它自己写的 `openspec`：

```sh
#!/bin/sh
exec node "/abs/path/to/node_modules/@fission-ai/openspec/bin/openspec.js" "$@"
```

这个安排还顺带带来两个结果：

- **不占用有争议的目录。** `.agents/skills/` 是 Codex 与 Zed Agent 共用的根，它们会在那里互相重写各自的目录树。本插件从不写入该目录。
- **只有一份副本，在一处升级。** `dsh plugin update` 一次刷新所有项目的 skill，而不是逐仓库执行 `openspec update`。

有意**不**接管的部分：`openspec/` 留在你的项目里，也留在 git 里。插件只负责分发能力，不拥有你的规范。

## 维护

skill 是从上游 vendor 来的，因为上游在安装时按工具渲染它们，其 npm 包里并不带 `.agents/skills/` 目录树。刷新方式：

```bash
node scripts/vendor-skills.mjs                 # 最新已发布版本
node scripts/vendor-skills.mjs --version 1.13.0
```

该脚本会在临时目录里运行上游自己的安装器，参数为 `--tools agents`——这是上游的中立、仅 skill 目标：它不生成任何 `opsx-*` 命令文件，因此交叉引用会被渲染成 skill 名称，正好对应 DSH 寻址其 skill 目录的方式。随后把 `package.json` 中 `@fission-ai/openspec` 的版本范围对齐到它打印的版本。

改动后重新检查接线（需要插件已装进某个 profile）：

```bash
dsh plugin --profile opstest add "$PWD"
node scripts/check-load.mjs --profile opstest --require propose,apply-change
```

该检查会走 dsh 真实的 `runProfile` 路径启动 profile，并断言 skill 在**没有 `.git` 的工作区**里可见——正是直接安装会失败的那种情形。

## 目录结构

| 路径 | 作用 |
|---|---|
| `cordis.patch.yml` | 注册内置 skill 提供方 |
| `skills/` | vendor 来的 `openspec-*/SKILL.md`（生成物，见 `skills/VENDORED.md`） |
| `lib/index.js` | CLI 解析、PATH 启动器、`/openspec` 命令 |
| `scripts/vendor-skills.mjs` | 从上游重新 vendor `skills/` |
| `scripts/check-load.mjs` | 加载期集成检查 |

## 许可

MIT。OpenSpec 本身亦为 MIT 许可，此处作为未修改的依赖使用；`skills/` 下 vendor 的 skill 文本由它生成。
