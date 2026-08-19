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
dsh plugin --profile web add github:<你的用户名>/dsh-plugin-manager
```

### 方式二：本地开发

```sh
git clone https://github.com/<你的用户名>/dsh-plugin-manager.git
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

## License

[MIT](./LICENSE)
