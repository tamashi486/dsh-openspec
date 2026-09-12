# dsh-openspec

中文 | [English](README.en.md)

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec)——规范驱动开发工作流
（explore → propose → apply → archive）——接入为 DeepSeek Harness 插件：
skill 目录里多出**六个 `openspec-*` skill**，agent 的 shell 里能直接解析
**`openspec` CLI**。不需要全局安装，不需要往每个项目拷一份
`.agents/skills`，而且在 git 仓库之外 skill 照常可用。

## 你会得到什么

六个 vendor 来的 skill，靠描述路由，用自然语言就能触发：

| Skill | 作用 |
|---|---|
| `openspec-explore` | 思考伙伴：在变更前后探索想法、排查问题、澄清需求 |
| `openspec-propose` | 一步创建变更及其全部规划产物（proposal、spec delta、design、tasks） |
| `openspec-apply-change` | 实现某个变更的任务清单 |
| `openspec-update-change` | 修订已有变更的规划产物（绝不改代码） |
| `openspec-sync-specs` | 把变更的 delta spec 合入主 spec，但不归档 |
| `openspec-archive-change` | 完成并归档一个变更 |

外加 CLI 接线：插件自带 `@fission-ai/openspec` 依赖，并在 profile 加载时把一个
很小的 `openspec` 启动器装进一个**已在 PATH 上**的目录——这样每个 skill 调用的
裸命令 `openspec` 才真正可解析：

```sh
#!/bin/sh
exec "/abs/path/to/node" "/abs/path/to/node_modules/@fission-ai/openspec/bin/openspec.js" "$@"
```

候选目录只取已在 PATH 上的那些，优先 Node 安装的 bin 目录、npm 全局 prefix、
`~/.local/bin` 和 Homebrew/系统 prefix。不是本插件写入的 `openspec` 绝不会被碰。

## 安装

```bash
dsh plugin add /path/to/dsh-openspec
```

重启 profile（或让 `patchReload: live` 自动接管）。加载时插件会：

1. 以**内置（bundled）提供方**的形式挂载六个 skill——任何工作区都可见，有没有 git 都一样；
2. 探测 CLI 依赖，若 `openspec` 尚不在 PATH 上则安装启动器（有日志；随时可用 `/openspec uninstall-shim` 移除）。

用 `/openspec doctor` 验证。

## 快速开始

先初始化一次项目——在项目自己的 shell 里：

```bash
openspec init --tools agents     # 生成 openspec/ 与项目配置
```

也可以直接在对话里开口：skill 检测到缺少 OpenSpec 根目录时会主动提出帮你跑
`openspec init`（`/openspec init <绝对路径>` 也行）。

之后用自然语言驱动工作流即可：

- “帮我想想怎么加暗色模式” → `openspec-explore`
- “提一个 add-dark-mode 变更” → `openspec-propose`
- “开始实现这个变更” → `openspec-apply-change`
- “归档它” → `openspec-archive-change`

注意规划边界（上游的设计）：`propose` 在产物就绪后即停止，只有当你明确要求
apply 时才开始实现。

## `/openspec` 命令

| 命令 | 用途 |
|---|---|
| `/openspec doctor` | 一屏诊断：skill 数量、CLI 版本与入口，以及 shell 实际把 `openspec` 解析到哪个二进制 |
| `/openspec shim` | 把 `openspec` 启动器（重新）安装到 PATH |
| `/openspec uninstall-shim` | 移除启动器（仅当它是本插件写入的） |
| `/openspec init <绝对路径>` | 在项目目录执行 `openspec init --tools agents`。绝对路径是**强制要求**而非建议：相对路径会按 profile 服务器进程的 cwd 解析，命令会直接拒绝，而不是初始化错的目录树 |

## 排障

先跑 `/openspec doctor`，对照下表：

| 诊断输出 | 含义 / 处理 |
|---|---|
| `CLI package : MISSING` | CLI 依赖没有装上。对本插件重跑一次 `dsh plugin add`（或 `dsh plugin add @fission-ai/openspec`），然后 `/openspec shim`。 |
| `PATH resolves : absent` | PATH 上没有任何 `openspec`，skill 的裸命令解析不到。处理：`/openspec shim`。 |
| `PATH resolves : foreign (<path>)` | 实际运行的是别人的 `openspec`，命令本身解析正常，这**不是**故障。skill 调用的就是那个二进制；若其版本与本插件 vendor 的 skill 产生漂移，请把插件的启动器放到更靠前的 PATH 目录。 |
| 启动器 `shadowed` | 启动器已写入，但 PATH 上更靠前的条目仍然优先。把它的目录在 PATH 中提前，或移除另一个安装。 |
| 启动器 `could not be installed (no-writable-path-dir)` | PATH 上没有可写目录。加一个（比如 `~/.local/bin`），重载 profile 后重试——或者自行全局安装 OpenSpec。 |

优先级说明：在 **git** 仓库里执行过 `openspec init` 后，DSH 还会发现项目自己的
`.agents/skills` 副本，其优先级高于内置副本——内容相同，无需处理。在 git 仓库
之外只有内置副本可见，而这正是本插件存在的意义。

## 为什么做成插件，而不是直接安装

OpenSpec 自带的安装器有两个前提，在 DSH 内并不成立。两条都对照当前源码验证过，不是推测：

**1. 项目级 skill 在 git 仓库之外不可见。**
`openspec init` 把 skill 写到 `<project>/.agents/skills/`。而 DSH 通过
`dsh-skill-filesystem` 的 `findProjectRoot` 发现项目级 skill，它只探测
`.git`，别的都不认：

```js
if (await pathExists(join(current, '.git'), fs)) return current;
```

在非 git 目录下，生成的 skill 确实躺在磁盘上，却永远不会被发现。本插件改用
`bundledSkillDir` 挂载，该机制与项目根探测完全无关。

**2. 裸命令 `openspec` 不在 agent 的 PATH 上。**
所有 vendor 过来的 skill 正文都调用 `openspec …`。而 profile 自己的
`node_modules/.bin` 并不在 bash 工具所见的 PATH 中，且 `ctx.shellEnv` 只注入
`DSH_*` 前缀的键——所以仅仅声明一个依赖，命令依然解析不了。这就是上面那个
启动器的由来，并且它绝不覆盖不是它自己写的 `openspec`。

这个安排还顺带带来两个结果：

- **不占用有争议的目录。** `.agents/skills/` 是 Codex 与 Zed Agent 共用的根，
  它们会在那里互相重写各自的目录树。本插件从不写入该目录。
- **只有一份副本，在一处升级。** `dsh plugin update` 一次刷新所有项目的
  skill，而不是逐仓库执行 `openspec update`。

有意**不**接管的部分：`openspec/` 留在你的项目里，也留在 git 里。插件只负责
分发能力，不拥有你的规范。

## 维护

`src/` 是唯一真源，`lib/` 是编译产物且**已提交入库**——`dsh plugin add`
直接按原样加载包，而 pnpm 默认会阻止 git 托管插件的 `prepare` 脚本，若把构建
放到安装期，每个使用者都得先改 `allowBuilds`。

```bash
npm ci
npm run typecheck    # 同时检查 src/ 与 scripts/（含契约测试）
npm run build        # src/ -> lib/（含 lib/types/）
```

CI 会在 `lib/` 相对 `src/` 过期时报错，所以每次都要把重新构建的结果一起提交。

**刷新 vendor 的 skill。** `skills/` 下的 skill 是生成物：上游在安装时按工具
渲染它们，npm 包里并不带 skill 目录树。因此 `scripts/vendor-skills.ts` 会在
一个一次性 git 仓库里运行上游自己的安装器（`--tools agents`——上游的中立、
仅 skill 目标：不生成任何 `opsx-*` 命令文件，交叉引用渲染成 skill 名称，正好
对应 DSH 寻址其 skill 目录的方式），然后拷贝结果：

```bash
npm run vendor-skills                              # 最新已发布版本
npm run vendor-skills -- --version 1.13.0
```

随后把 `package.json` 中 `@fission-ai/openspec` 的版本范围对齐到脚本打印的
版本。`skills/VENDORED.md` 记录出处。

**检查接线。** `scripts/checks/plugin-contract.ts` 是编译期契约测试：插件一旦
不再满足 cordis 的插件形状或 dsh-commands 的 `CommandDefinition`，
`npm run typecheck` 就会失败。完整集成检查（需要插件已装进某个 profile）：

```bash
dsh plugin --profile opstest add "$PWD"
npm run check-load -- --profile opstest --require propose,apply-change
```

该检查会走 dsh 真实的 `runProfile` 路径启动 profile，并断言 skill 在**没有
`.git` 的工作区**里可见——正是直接安装会失败的那种情形。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 插件源码：CLI 解析、PATH 启动器、`/openspec` 命令 |
| `lib/` | 编译产物（已提交，dsh 实际加载的就是它） |
| `cordis.patch.yml` | 注册内置 skill 提供方 |
| `skills/` | vendor 来的 `openspec-*/SKILL.md`（生成物，见 `skills/VENDORED.md`） |
| `scripts/vendor-skills.ts` | 从上游重新 vendor `skills/`（经 `tsx` 运行） |
| `scripts/check-load.ts` | 加载期集成检查（经 `tsx` 运行） |
| `scripts/checks/plugin-contract.ts` | cordis 契约的编译期测试 |
| `.github/workflows/ci.yml` | CI：类型检查与构建、`lib/` 过期检查、非 git 目录下的真实启动验证 |

## 许可

MIT。OpenSpec 本身亦为 MIT 许可，此处作为未修改的依赖使用；`skills/` 下
vendor 的 skill 文本由它生成。
