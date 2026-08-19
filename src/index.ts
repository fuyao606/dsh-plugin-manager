/**
 * dsh-plugin-manager host 半：一个 fenced JSON API，管理 web profile 里安装的 DSH 插件。
 *
 * 能力：
 *  - list    读取 profile 的 package.json（dependencies + dsh.profile.bundles）与
 *            node_modules 里的实际版本，返回可管理清单。
 *  - enable  把插件名加回 dsh.profile.bundles（重新挂载）。
 *  - disable 把插件名从 dsh.profile.bundles 移除（保留安装，下次启动不再加载）。
 *  - install 在 profile 目录跑 `pnpm add <spec>`，然后按安装状态对账 bundles。
 *  - remove  在 profile 目录跑 `pnpm remove <name>`，然后对账 bundles。
 *
 * 所有写操作只改 $DSH_HOME/profiles/<profile> 下的 package.json / node_modules，
 * 不触碰正在运行的进程；host 半改动要等下次 `dsh web` 重启才生效，因此每个写操作
 * 都返回 restartRequired: true，由 client 提示用户。
 *
 * 安全：路由走与 /api 网关相同的浏览器信任围栏（Host 回环 / trustedHosts + 同源），
 * 阻止恶意网页对本地 DSH 服务做 CSRF 安装/卸载。install 的 spec 做白名单校验，
 * 只允许安全字符，避免经 `shell: true` 的 pnpm 调用被注入。
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 结构化类型（不与 @deepseek-ai/* 产生值依赖，只声明用到的服务面） ──────────

interface WebRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
}
interface WebServerService {
  register(route: WebRoute): () => void
}
interface WebRuntimeService {
  trustedHosts: readonly string[]
}
interface HostContext {
  webServer: WebServerService
  webRuntime: WebRuntimeService
  effect(fn: () => void | (() => void), label?: string): void
  logger?: { warn(msg: string): void; info(msg: string): void }
}

/** 路由 handler 拿到的请求面（Node IncomingMessage 的结构子集）。 */
interface HttpRequestLike {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}
/** 路由 handler 拿到的响应面（Node ServerResponse 的结构子集）。 */
interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

interface Manifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export const name = 'dsh-plugin-manager'
export const inject = ['webServer', 'webRuntime']

const MAX_BODY_BYTES = 1 << 20
/** install spec 白名单：@scope/name、name，可选 @version/tag；字符严格受限。 */
const SAFE_SPEC = /^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/
/** 纯包名（无版本后缀），供 remove 用：允许 @scope/name。 */
const SAFE_NAME = /^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/

class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function resolveProfileDir(profile: string): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const text = JSON.stringify(manifest, null, 2) + '\n'
  await writeFile(join(dir, 'package.json'), text, 'utf8')
}

/** node_modules/<name>/package.json 的绝对路径（含 @scope 处理）。 */
function pkgDir(dir: string, name: string): string {
  return join(dir, 'node_modules', ...name.split('/'))
}

/** 该依赖是否声明了 dsh.bundle（即是否作为 profile 层挂载）。 */
async function isBundle(dir: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(pkgDir(dir, name), 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    return pkg.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

function header(headers: HttpRequestLike['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 与 /api 网关行为一致的浏览器信任围栏（DNS-rebinding / 跨站防御，非鉴权）。 */
function isTrustedApiRequest(req: HttpRequestLike, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) {
    const trusted = trustedHosts.some((entry) => {
      try {
        const entryUrl = new URL(`http://${entry}`)
        return entryUrl.host === hostUrl.host || entryUrl.hostname === hostUrl.hostname
      } catch {
        return false
      }
    })
    if (!trusted) return false
  }
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

async function readJsonBody(req: HttpRequestLike): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

function requireString(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string' || value === '') throw new ApiError('bad-request', `missing or invalid "${key}"`)
  return value
}

function writeJson(res: HttpResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res: HttpResponseLike, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: HttpResponseLike, error: unknown): void {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
}

// ── pnpm 与 bundles 对账 ─────────────────────────────────────────────────────

/** 串行化写操作：并发 pnpm / 清单写会互相踩锁与覆盖。 */
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function runPnpm(args: string[], profileDir: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: profileDir,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, CI: '1' },
    })
    let output = ''
    child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { output += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code: code ?? 1, output }) })
  })
}

/**
 * 按安装状态对账 dsh.profile.bundles —— 等价于 `dsh plugin` 的 reconcilePlugins：
 * 依赖里声明了 dsh.bundle 的包进入 bundles（按依赖顺序追加）；曾经是依赖、现在
 * 不再是的包从 bundles 移除。内置 base bundles（非依赖）永不触碰。
 */
async function reconcileBundles(
  dir: string,
  before: Manifest,
  after: Manifest,
): Promise<Manifest> {
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const afterDeps = new Set(Object.keys(after.dependencies ?? {}))
  const bundles = [...(after.dsh?.profile?.bundles ?? [])]
  let changed = false

  for (const packageName of Object.keys(after.dependencies ?? {})) {
    if (await isBundle(dir, packageName) && !bundles.includes(packageName)) {
      bundles.push(packageName)
      changed = true
    }
  }
  for (const packageName of [...bundles]) {
    const wasDependency = beforeDeps.has(packageName) || afterDeps.has(packageName)
    const stillBundle = afterDeps.has(packageName) && (await isBundle(dir, packageName))
    if (wasDependency && !stillBundle) {
      const index = bundles.indexOf(packageName)
      if (index >= 0) bundles.splice(index, 1)
      changed = true
    }
  }

  if (!changed) return after
  return {
    ...after,
    dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles } },
  }
}

// ── API 方法表 ──────────────────────────────────────────────────────────────

function buildApi(profileDir: string, logger?: HostContext['logger']) {
  const list = async (): Promise<Record<string, unknown>> => {
    const manifest = await readManifest(profileDir)
    const deps = manifest.dependencies ?? {}
    const bundles = manifest.dsh?.profile?.bundles ?? []

    const plugins = []
    for (const [name, range] of Object.entries(deps)) {
      let version = ''
      let description = ''
      let bundle = false
      try {
        const pkg = JSON.parse(await readFile(join(pkgDir(profileDir, name), 'package.json'), 'utf8')) as {
          version?: string
          description?: string
          dsh?: { bundle?: { patch?: string } }
        }
        version = pkg.version ?? ''
        description = pkg.description ?? ''
        bundle = pkg.dsh?.bundle?.patch !== undefined
      } catch {
        // 已声明但未落盘的依赖（例如 pnpm 未 install）——版本留空。
      }
      plugins.push({
        name,
        range,
        version,
        description,
        isBundle: bundle,
        enabled: bundles.includes(name),
      })
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name))

    const builtins = bundles.filter((b) => !(b in deps)).map((b) => ({ name: b }))

    return { profileDir, plugins, builtins }
  }

  const setEnabled = async (payload: unknown, enabled: boolean): Promise<Record<string, unknown>> => {
    const name = requireString(payload, 'name').trim()
    if (!SAFE_NAME.test(name)) throw new ApiError('bad-request', '非法插件名')
    const manifest = await readManifest(profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const has = bundles.includes(name)
    if (enabled && !has) bundles.push(name)
    if (!enabled && has) {
      const index = bundles.indexOf(name)
      if (index >= 0) bundles.splice(index, 1)
    }
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await writeManifest(profileDir, manifest)
    return { ok: true, restartRequired: true, name, enabled }
  }

  const install = async (payload: unknown): Promise<Record<string, unknown>> => {
    const spec = requireString(payload, 'spec').trim()
    if (!SAFE_SPEC.test(spec)) {
      throw new ApiError('bad-request', '非法插件规格：只允许 npm 包名 + 可选 @version/tag，字符限于 a-z 0-9 . _ - / @')
    }
    const before = await readManifest(profileDir)
    const { code, output } = await runPnpm(['add', spec], profileDir)
    if (code !== 0) {
      throw new ApiError('install-failed', `pnpm add 失败（exit ${code}）\n${tail(output)}`, 500)
    }
    const after = await readManifest(profileDir)
    const reconciled = await reconcileBundles(profileDir, before, after)
    if (reconciled !== after) await writeManifest(profileDir, reconciled)
    return { ok: true, restartRequired: true, spec, output: tail(output) }
  }

  const remove = async (payload: unknown): Promise<Record<string, unknown>> => {
    const name = requireString(payload, 'name').trim()
    if (!SAFE_NAME.test(name)) {
      throw new ApiError('bad-request', '非法插件名')
    }
    const before = await readManifest(profileDir)
    const { code, output } = await runPnpm(['remove', name], profileDir)
    if (code !== 0) {
      throw new ApiError('remove-failed', `pnpm remove 失败（exit ${code}）\n${tail(output)}`, 500)
    }
    const after = await readManifest(profileDir)
    const reconciled = await reconcileBundles(profileDir, before, after)
    if (reconciled !== after) await writeManifest(profileDir, reconciled)
    return { ok: true, restartRequired: true, name, output: tail(output) }
  }

  const table: Record<string, (payload: unknown) => Promise<unknown> | unknown> = {
    list: () => list(),
    enable: (payload) => serialize(() => setEnabled(payload, true)),
    disable: (payload) => serialize(() => setEnabled(payload, false)),
    install: (payload) => serialize(() => install(payload)),
    remove: (payload) => serialize(() => remove(payload)),
  }

  void logger
  return table
}

function tail(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(-30).join('\n')
}

// ── 插件体 ──────────────────────────────────────────────────────────────────

export function apply(ctx: HostContext, config?: { profile?: string }): void {
  const profile = config?.profile?.trim() || 'web'
  const profileDir = resolveProfileDir(profile)
  const api = buildApi(profileDir, ctx.logger)
  const fence = (req: HttpRequestLike): boolean => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugin-manager/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/plugin-manager/api/') ? pathname.slice('/plugin-manager/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new ApiError('not-found', 'unknown method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) throw new ApiError('not-found', `unknown API method "${method}"`, 404)
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-plugin-manager: /plugin-manager/api routes')
}
