# dsh-plugin-manager

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 的「设置」面板里管理本机插件：**列出、启用、禁用、安装、卸载** web profile 的插件，无需命令行手动操作。

## 功能

- **列出**：读取 `$DSH_HOME/profiles/web/package.json`（`dependencies` + `dsh.profile.bundles`）与 `node_modules` 里的实际版本，区分「用户插件」与「内置模块」。
- **启用 / 禁用**：切换插件在 `dsh.profile.bundles` 中的挂载（禁用保留安装，仅下次启动不再加载）。
- **安装**：输入 npm 包名，在 profile 目录跑 `pnpm add <spec>`，并按安装状态自动对账 bundles。
- **卸载**：一键 `pnpm remove <name>`，并对账 bundles。

> 所有改动只落到 profile 的 `package.json` / `node_modules`，需**重启 `dsh web` 并硬刷新浏览器**后生效（host 半改动无法热加载）。

## 安装

### 方式一：从 GitHub（推荐，免构建脚本）

仓库已提交构建产物 `lib/`，直接装：

```sh
dsh plugin --profile web add github:fuyao606/dsh-plugin-manager
```

### 方式二：本地开发

```sh
git clone https://github.com/fuyao606/dsh-plugin-manager.git
cd dsh-plugin-manager
pnpm install
pnpm build

# 装进 web profile（本地 link，改完 rebuild 后重启即可）
dsh plugin --profile web add ../dsh-plugin-manager
```

### 方式三：npm（若已发布）

```sh
dsh plugin --profile web add dsh-plugin-manager@latest
```

装完**重启 `dsh web` 并硬刷新浏览器**，打开 **设置 →「插件管理」**即可使用。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.js（host）+ lib/client.js（client）
```

> 仓库刻意提交了构建产物 `lib/`（见 `.gitignore` 注释），改 `src/` 后需 `pnpm build` 重新生成并提交，保证 GitHub 安装免构建脚本。

## 安全

- 路由走与 `/api` 网关一致的浏览器信任围栏（Host 回环 / trustedHosts + 同源），阻止恶意网页对本地 DSH 服务做 CSRF 安装/卸载。
- `install` 的包名规格做白名单校验，避免经 `shell: true` 调 pnpm 时被注入；仅支持 npm 包名（`name` / `@scope/name`，可选 `@version`），`github:` / `file:` 等规格需走命令行。

## 架构

- **host 半** `src/index.ts` → `lib/index.js`：`/plugin-manager/api` JSON API（list / enable / disable / install / remove）。
- **client 半** `src/client/index.tsx` → `lib/client.js`：注册 `settings.section` slot，渲染管理界面。
- 只依赖模块表提供的 `react`；`@deepseek-ai/*` 服务面全部用结构化类型镜像，无值依赖。

## 快速开始

### 安装并打开管理器

仓库已提交 `lib/` 构建产物，推荐直接从 GitHub 安装：

```sh
dsh plugin --profile web add github:fuyao606/dsh-plugin-manager
```

也可以固定到指定版本：

```sh
dsh plugin --profile web add github:fuyao606/dsh-plugin-manager#v0.1.1
```

安装完成后重启 DSH：

```sh
dsh web
```

然后进入 **设置 → 插件管理**。安装、升级或修改任意插件后，都要重启 `dsh web`，并在浏览器执行硬刷新（Windows/Linux：`Ctrl+Shift+R`，macOS：`Cmd+Shift+R`）。Host 侧的 bundle 挂载不会热加载，仅刷新页面不会使配置生效。

### 界面中的安装规格

「安装插件」输入框接受普通 npm 包名和版本/标签，例如：

```text
@tonydua/dsh-web-search-exa
dsh-better-sidebar@latest
dsh-plugin@1.2.3
```

支持 `name`、`name@version`、`name@tag`、`@scope/name` 和 `@scope/name@version`。为避免命令注入，输入会经过严格字符校验；`github:`、`file:`、本地路径和 tarball URL 等规格请改用命令行安装。

### 状态说明

| 状态 | 含义 | 说明 |
| --- | --- | --- |
| 已启用 | DSH bundle 已挂载到 `dsh.profile.bundles` | 下次启动加载 |
| 已禁用 | 包仍安装，但已移出 bundle 挂载列表 | 不会删除包 |
| 已阻断 | 与当前 profile 的 Cordis patch ID 冲突 | 不能强行启用 |
| 普通依赖 | npm 依赖，不是 DSH bundle | 不支持启用/禁用 |
| 内置 | profile 原有的内置 bundle | 不可卸载 |

## 配置与文件位置

默认管理 `web` profile：

```text
$DSH_HOME/profiles/web/
├── package.json       # dependencies 与 dsh.profile.bundles
├── pnpm-lock.yaml     # pnpm 锁文件
└── node_modules/      # 已安装包
```

Host API 挂载在 `/plugin-manager/api/*`，客户端在 DSH 设置页注册「插件管理」section。默认 profile 在 bundle 配置中指定为 `web`；使用其他 profile 时，请确保该 profile 已存在且能由 DSH 正常启动。

## 常见问题

### 安装后页面没有出现

确认命令使用了 `--profile web`，然后重启 `dsh web` 并硬刷新浏览器。仅刷新设置页不足以重新加载 Host bundle。

### 启用时提示冲突

该 bundle 声明的 Cordis patch ID 与当前已启用模块重复。请先禁用冲突模块，或将插件安装到独立 profile；管理器不会覆盖现有模块。

### 安装失败后是否需要手动修复

安装和卸载前会创建 profile 快照，命令失败时会尝试恢复 `package.json` 和 `node_modules`。如果 pnpm 被强制中断，请手动检查 `$DSH_HOME/profiles/web/package.json` 和 `node_modules`，再运行 `pnpm install`。

### 为什么普通依赖不能启用

只有带有 DSH bundle 元数据的包才会写入 `dsh.profile.bundles`。普通 npm 依赖由其他插件间接使用，不是可独立挂载的 DSH bundle。

## 开发与发布

要求 Node.js `>=20`，包管理器使用 pnpm：

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm build         # tsdown，生成 lib/index.js 与 lib/client.js
```

修改 `src/` 后必须重新构建并提交 `lib/`，保证 GitHub 安装不需要构建脚本。发布新版本时更新 `package.json` 版本号，运行类型检查和构建，提交源码与构建产物，创建同名 Git 标签，再在 GitHub Releases 页面基于该标签创建公开 Release。

## 安全边界补充

- API 复用 DSH Web API 的请求信任围栏，检查回环 Host、`trustedHosts` 和同源请求。
- API 只接受 `POST`，方法限定为 `list`、`enable`、`disable`、`install`、`remove`。
- 安装规格和插件名使用白名单校验，不会把未经校验的输入直接拼进 shell 命令。
- 插件仍会以本机 DSH 进程权限运行，请只安装信任的 npm 包。

## License

[MIT](./LICENSE)
