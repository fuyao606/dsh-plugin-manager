import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
//#region src/index.ts
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
const name = "dsh-plugin-manager";
const inject = ["webServer", "webRuntime"];
const MAX_BODY_BYTES = 1 << 20;
/** install spec 白名单：@scope/name、name，可选 @version/tag；字符严格受限。 */
const SAFE_SPEC = /^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
/** 纯包名（无版本后缀），供 remove 用：允许 @scope/name。 */
const SAFE_NAME = /^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
var ApiError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
function resolveProfileDir(profile) {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "profiles", profile);
}
async function readManifest(dir) {
	return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
}
async function writeManifest(dir, manifest) {
	const text = JSON.stringify(manifest, null, 2) + "\n";
	await writeFile(join(dir, "package.json"), text, "utf8");
}
/** node_modules/<name>/package.json 的绝对路径（含 @scope 处理）。 */
function pkgDir(dir, name) {
	return join(dir, "node_modules", ...name.split("/"));
}
async function readPackageInfo(dir, name) {
	try {
		return JSON.parse(await readFile(join(pkgDir(dir, name), "package.json"), "utf8"));
	} catch {
		return null;
	}
}
/** Extract IDs from the supported Cordis patch insert form. */
async function analyzeBundle(dir, name) {
	const patch = (await readPackageInfo(dir, name))?.dsh?.bundle?.patch;
	if (patch === void 0) return {
		isBundle: false,
		patchIds: []
	};
	try {
		const ids = [...(await readFile(join(pkgDir(dir, name), patch), "utf8")).matchAll(/^\s*-?\s*id:\s*['\"]?([^\s'\"]+)['\"]?\s*$/gm)].map((match) => match[1]).filter((id) => id !== void 0);
		return {
			isBundle: true,
			patchIds: [...new Set(ids)]
		};
	} catch {
		return {
			isBundle: true,
			patchIds: []
		};
	}
}
async function isBundle(dir, name) {
	return (await analyzeBundle(dir, name)).isBundle;
}
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
/** 与 /api 网关行为一致的浏览器信任围栏（DNS-rebinding / 跨站防御，非鉴权）。 */
function isTrustedApiRequest(req, trustedHosts) {
	const host = header(req.headers, "host");
	if (host === void 0) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) {
		if (!trustedHosts.some((entry) => {
			try {
				const entryUrl = new URL(`http://${entry}`);
				return entryUrl.host === hostUrl.host || entryUrl.hostname === hostUrl.hostname;
			} catch {
				return false;
			}
		})) return false;
	}
	if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(req.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new ApiError("bad-request", "request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new ApiError("bad-request", "request body is not valid JSON");
	}
}
function requireString(payload, key) {
	const value = payload?.[key];
	if (typeof value !== "string" || value === "") throw new ApiError("bad-request", `missing or invalid "${key}"`);
	return value;
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function writeOk(res, value) {
	writeJson(res, 200, {
		ok: true,
		value
	});
}
function writeError(res, error) {
	if (error instanceof ApiError) {
		writeJson(res, error.status, {
			ok: false,
			error: {
				code: error.code,
				message: error.message
			}
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error)
		}
	});
}
/** 串行化写操作：并发 pnpm / 清单写会互相踩锁与覆盖。 */
let queue = Promise.resolve();
function serialize(fn) {
	const run = queue.then(fn, fn);
	queue = run.then(() => void 0, () => void 0);
	return run;
}
function runCommand(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			shell: process.platform === "win32",
			windowsHide: true,
			env: {
				...process.env,
				CI: "1"
			}
		});
		let output = "";
		child.stdout?.on("data", (d) => {
			output += d.toString("utf8");
		});
		child.stderr?.on("data", (d) => {
			output += d.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code: code ?? 1,
				output
			});
		});
	});
}
function runPnpm(args, profileDir) {
	return runCommand("pnpm", args, profileDir);
}
async function readDumpConfigIds(profileDir) {
	const result = await runCommand("dsh", [
		"--profile",
		"web",
		"--dump-config"
	], profileDir);
	if (result.code !== 0) return /* @__PURE__ */ new Set();
	const ids = /* @__PURE__ */ new Set();
	for (const match of result.output.matchAll(/(?:^|[\s"'])id["']?\s*[:=]\s*["']([^"']+)["']/g)) ids.add(match[1]);
	return ids;
}
async function snapshotProfile(dir) {
	const manifest = await readFile(join(dir, "package.json"), "utf8");
	for (const lockfileName of ["pnpm-lock.yaml", "pnpm-lock.yml"]) try {
		return {
			manifest,
			lockfile: await readFile(join(dir, lockfileName), "utf8"),
			lockfileName
		};
	} catch {}
	return { manifest };
}
async function restoreProfile(dir, snapshot) {
	await writeFile(join(dir, "package.json"), snapshot.manifest, "utf8");
	if (snapshot.lockfile !== void 0 && snapshot.lockfileName !== void 0) await writeFile(join(dir, snapshot.lockfileName), snapshot.lockfile, "utf8");
}
async function inspectSpec(profileDir, spec, occupied) {
	const tempDir = await mkdtemp(join(tmpdir(), "dsh-plugin-manager-"));
	try {
		await writeFile(join(tempDir, "package.json"), JSON.stringify({ private: true }, null, 2), "utf8");
		const result = await runPnpm([
			"add",
			"--ignore-scripts",
			"--lockfile=false",
			spec
		], tempDir);
		if (result.code !== 0) throw new ApiError("preflight-failed", `安装预检失败\n${tail(result.output)}`, 500);
		const requestedName = spec.startsWith("@") ? spec.slice(1).split("@")[0] : spec.split("@")[0];
		if (requestedName === void 0 || requestedName === "") throw new ApiError("preflight-failed", "无法解析插件名", 500);
		const name = spec.startsWith("@") ? `@${requestedName}` : requestedName;
		const pkg = await readPackageInfo(tempDir, name);
		if (pkg === null) throw new ApiError("preflight-failed", `预检后找不到 ${name}`, 500);
		const analysis = await analyzeBundle(tempDir, name);
		const currentIds = new Set(occupied);
		const conflicts = analysis.patchIds.filter((id) => currentIds.has(id));
		return {
			name,
			version: pkg.version ?? "",
			analysis,
			conflicts
		};
	} finally {
		await rm(tempDir, {
			recursive: true,
			force: true
		});
	}
}
async function reconcileBundles(dir, before, after, addedName) {
	const bundles = [...after.dsh?.profile?.bundles ?? []];
	if (addedName !== void 0 && !bundles.includes(addedName) && await isBundle(dir, addedName)) {
		bundles.push(addedName);
		return {
			...after,
			dsh: {
				...after.dsh,
				profile: {
					...after.dsh?.profile,
					bundles
				}
			}
		};
	}
	const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
	const afterDeps = new Set(Object.keys(after.dependencies ?? {}));
	let changed = false;
	for (const packageName of [...bundles]) if ((beforeDeps.has(packageName) || afterDeps.has(packageName)) && !afterDeps.has(packageName)) {
		bundles.splice(bundles.indexOf(packageName), 1);
		changed = true;
	}
	return changed ? {
		...after,
		dsh: {
			...after.dsh,
			profile: {
				...after.dsh?.profile,
				bundles
			}
		}
	} : after;
}
async function occupiedBundleIds(dir, manifest) {
	const ids = await readDumpConfigIds(dir);
	if (ids.size > 0) return ids;
	for (const name of manifest.dsh?.profile?.bundles ?? []) {
		const analysis = await analyzeBundle(dir, name);
		for (const id of analysis.patchIds) ids.add(id);
	}
	return ids;
}
function buildApi(profileDir, logger) {
	const list = async () => {
		const manifest = await readManifest(profileDir);
		const deps = manifest.dependencies ?? {};
		const bundles = manifest.dsh?.profile?.bundles ?? [];
		const occupied = await occupiedBundleIds(profileDir, manifest);
		const plugins = [];
		for (const [name, range] of Object.entries(deps)) {
			const pkg = await readPackageInfo(profileDir, name);
			const analysis = await analyzeBundle(profileDir, name);
			const conflicts = analysis.patchIds.filter((id) => occupied.has(id) && !bundles.includes(name));
			plugins.push({
				name,
				range,
				version: pkg?.version ?? "",
				description: pkg?.description ?? "",
				isBundle: analysis.isBundle,
				enabled: bundles.includes(name),
				status: !analysis.isBundle ? "dependency" : conflicts.length > 0 ? "blocked" : bundles.includes(name) ? "enabled" : "disabled",
				conflicts
			});
		}
		plugins.sort((a, b) => a.name.localeCompare(b.name));
		return {
			profileDir,
			plugins,
			builtins: bundles.filter((b) => !(b in deps)).map((b) => ({ name: b }))
		};
	};
	const setEnabled = async (payload, enabled) => {
		const name = requireString(payload, "name").trim();
		if (!SAFE_NAME.test(name)) throw new ApiError("bad-request", "非法插件名");
		const manifest = await readManifest(profileDir);
		const bundles = manifest.dsh?.profile?.bundles ?? [];
		const has = bundles.includes(name);
		if (enabled && !has) {
			const analysis = await analyzeBundle(profileDir, name);
			if (!analysis.isBundle) throw new ApiError("not-bundle", "该依赖不是 DSH bundle，不能启用");
			const occupied = await occupiedBundleIds(profileDir, manifest);
			const conflicts = analysis.patchIds.filter((id) => occupied.has(id));
			if (conflicts.length > 0) throw new ApiError("bundle-conflict", `不兼容当前 web profile\n冲突的 Cordis IDs：\n- ${conflicts.join("\n- ")}`, 409);
			bundles.push(name);
		}
		if (!enabled && has) {
			const index = bundles.indexOf(name);
			if (index >= 0) bundles.splice(index, 1);
		}
		manifest.dsh = {
			...manifest.dsh,
			profile: {
				...manifest.dsh?.profile,
				bundles
			}
		};
		await writeManifest(profileDir, manifest);
		return {
			ok: true,
			restartRequired: true,
			name,
			enabled
		};
	};
	const install = async (payload) => {
		const spec = requireString(payload, "spec").trim();
		if (!SAFE_SPEC.test(spec)) throw new ApiError("bad-request", "非法插件规格：只允许 npm 包名 + 可选 @version/tag，字符限于 a-z 0-9 . _ - / @");
		const before = await readManifest(profileDir);
		const inspection = await inspectSpec(profileDir, spec, await occupiedBundleIds(profileDir, before));
		if (inspection.conflicts.length > 0) throw new ApiError("bundle-conflict", `不兼容当前 web profile\n\n${inspection.name}@${inspection.version}\n冲突的 Cordis IDs：\n- ${inspection.conflicts.join("\n- ")}\n\n建议：安装到独立 TUI profile，或不要安装。`, 409);
		const snapshot = await snapshotProfile(profileDir);
		try {
			const { code, output } = await runPnpm(["add", spec], profileDir);
			if (code !== 0) throw new ApiError("install-failed", `pnpm add 失败（exit ${code}）\n${tail(output)}`, 500);
			const after = await readManifest(profileDir);
			const reconciled = await reconcileBundles(profileDir, before, after, inspection.name);
			if (reconciled !== after) await writeManifest(profileDir, reconciled);
			return {
				ok: true,
				restartRequired: true,
				spec,
				output: tail(output)
			};
		} catch (error) {
			await restoreProfile(profileDir, snapshot);
			throw error;
		}
	};
	const remove = async (payload) => {
		const name = requireString(payload, "name").trim();
		if (!SAFE_NAME.test(name)) throw new ApiError("bad-request", "非法插件名");
		const before = await readManifest(profileDir);
		const snapshot = await snapshotProfile(profileDir);
		try {
			const { code, output } = await runPnpm(["remove", name], profileDir);
			if (code !== 0) throw new ApiError("remove-failed", `pnpm remove 失败（exit ${code}）\n${tail(output)}`, 500);
			const after = await readManifest(profileDir);
			const reconciled = await reconcileBundles(profileDir, before, after);
			if (reconciled !== after) await writeManifest(profileDir, reconciled);
			return {
				ok: true,
				restartRequired: true,
				name,
				output: tail(output)
			};
		} catch (error) {
			await restoreProfile(profileDir, snapshot);
			throw error;
		}
	};
	return {
		list: () => list(),
		enable: (payload) => serialize(() => setEnabled(payload, true)),
		disable: (payload) => serialize(() => setEnabled(payload, false)),
		install: (payload) => serialize(() => install(payload)),
		remove: (payload) => serialize(() => remove(payload))
	};
}
function tail(text) {
	return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-30).join("\n");
}
function apply(ctx, config) {
	const api = buildApi(resolveProfileDir(config?.profile?.trim() || "web"), ctx.logger);
	const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/plugin-manager/api",
		handler: async (req, res) => {
			if (!fence(req)) {
				writeJson(res, 403, {
					ok: false,
					error: {
						code: "forbidden",
						message: "forbidden"
					}
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: {
						code: "method-error",
						message: "method not allowed"
					}
				});
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith("/plugin-manager/api/") ? pathname.slice(20) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeError(res, new ApiError("not-found", "unknown method", 404));
				return;
			}
			try {
				const payload = await readJsonBody(req);
				const handler = api[method];
				if (handler === void 0) throw new ApiError("not-found", `unknown API method "${method}"`, 404);
				writeOk(res, await handler(payload));
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-plugin-manager: /plugin-manager/api routes");
}
//#endregion
export { apply, inject, name };
