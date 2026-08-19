window.__ModuleLoader__.load({
	id: "dsh-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* dsh-plugin-manager client 半：在 DSH 设置面板注册「插件管理」section，
		* 通过 host 的 /plugin-manager/api 列出 / 启用 / 禁用 / 安装 / 卸载 web profile 插件。
		* 只依赖模块表提供的 react；类型全部结构化，不 import @deepseek-ai/* 值。
		*/
		const inject = ["slots"];
		async function apiCall(method, payload = {}) {
			let response;
			try {
				response = await fetch(`/plugin-manager/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
			} catch (error) {
				throw new Error(error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
			return parsed.value;
		}
		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				gap: 16
			},
			intro: {
				margin: 0,
				opacity: .72,
				fontSize: 13,
				lineHeight: 1.6
			},
			group: {
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			heading: {
				fontSize: 13,
				fontWeight: 600,
				letterSpacing: .2
			},
			installRow: {
				display: "flex",
				gap: 8,
				alignItems: "center"
			},
			input: {
				flex: 1,
				padding: "8px 10px",
				borderRadius: 8,
				border: "1px solid rgba(128,128,128,0.35)",
				background: "transparent",
				color: "inherit",
				fontSize: 13
			},
			button: {
				padding: "8px 12px",
				borderRadius: 8,
				border: "1px solid rgba(128,128,128,0.35)",
				background: "transparent",
				color: "inherit",
				fontSize: 13,
				cursor: "pointer"
			},
			primary: {
				padding: "8px 12px",
				borderRadius: 8,
				border: "1px solid transparent",
				background: "#4d6bfe",
				color: "#fff",
				fontSize: 13,
				cursor: "pointer"
			},
			danger: {
				padding: "6px 10px",
				borderRadius: 8,
				border: "1px solid rgba(224,90,90,0.5)",
				background: "transparent",
				color: "#e05a5a",
				fontSize: 12,
				cursor: "pointer"
			},
			row: {
				display: "flex",
				gap: 10,
				alignItems: "center",
				padding: "10px 12px",
				borderRadius: 10,
				border: "1px solid rgba(128,128,128,0.18)"
			},
			rowMain: {
				flex: 1,
				minWidth: 0
			},
			name: {
				fontSize: 13,
				fontWeight: 600,
				wordBreak: "break-all"
			},
			meta: {
				fontSize: 12,
				opacity: .62,
				marginTop: 2,
				wordBreak: "break-word"
			},
			badge: {
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "rgba(128,128,128,0.15)",
				whiteSpace: "nowrap"
			},
			badgeOn: {
				background: "rgba(77,107,254,0.18)",
				color: "#9db2ff"
			},
			badgeOff: {
				background: "rgba(128,128,128,0.12)",
				color: "inherit"
			},
			notice: {
				padding: "10px 12px",
				borderRadius: 8,
				background: "rgba(77,107,254,0.12)",
				color: "#9db2ff",
				fontSize: 12,
				lineHeight: 1.5
			},
			error: {
				padding: "10px 12px",
				borderRadius: 8,
				background: "rgba(224,90,90,0.12)",
				color: "#f2a1a1",
				fontSize: 12,
				whiteSpace: "pre-wrap"
			},
			muted: {
				opacity: .55,
				fontSize: 12
			}
		};
		function ToggleButton(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: {
					...styles.button,
					minWidth: 76
				},
				disabled: props.busy,
				onClick: props.onClick,
				children: props.enabled ? "禁用" : "启用"
			});
		}
		function PluginManagerSection() {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [spec, setSpec] = (0, react.useState)("");
			const load = () => {
				apiCall("list").then((value) => {
					setData(value);
					setError(null);
				}).catch((e) => setError(e instanceof Error ? e.message : String(e)));
			};
			(0, react.useEffect)(() => {
				load();
			}, []);
			const mutate = (label, method, payload) => {
				setBusy(label);
				setError(null);
				setNotice(null);
				apiCall(method, payload).then((result) => {
					if (result.restartRequired) setNotice("✅ 已修改。改动在重启 dsh web 并硬刷新浏览器（Ctrl+Shift+R）后生效。");
					return apiCall("list");
				}).then((value) => setData(value)).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
			};
			const plugins = data?.plugins ?? [];
			const builtins = data?.builtins ?? [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: styles.intro,
						children: ["管理本机 web profile 已安装的插件。启用 / 禁用 / 安装 / 卸载后需重启 dsh web 生效。", data !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: styles.muted,
							children: [
								" ",
								"目录：",
								data.profileDir
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.heading,
							children: "安装插件"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.installRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								placeholder: "例如 @tonydua/dsh-web-search-exa 或 dsh-better-sidebar@latest",
								value: spec,
								onChange: (event) => setSpec(event.currentTarget.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && spec.trim() !== "" && busy === null) mutate("install", "install", { spec: spec.trim() });
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.primary,
								disabled: busy !== null || spec.trim() === "",
								onClick: () => mutate("install", "install", { spec: spec.trim() }),
								children: busy === "install" ? "安装中…" : "安装"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.heading,
								children: [
									"已安装插件（",
									plugins.length,
									"）"
								]
							}),
							plugins.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: styles.muted,
								children: "暂无用户安装的插件。"
							}),
							plugins.map((plugin) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: styles.rowMain,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: styles.name,
											children: plugin.name
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: styles.meta,
											children: [
												plugin.version !== "" ? `v${plugin.version}` : plugin.range,
												plugin.isBundle ? " · bundle" : " · 普通依赖",
												plugin.description !== "" ? ` · ${plugin.description}` : ""
											]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											...styles.badge,
											...plugin.enabled ? styles.badgeOn : styles.badgeOff
										},
										children: plugin.enabled ? "已启用" : "已禁用"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleButton, {
										enabled: plugin.enabled,
										busy: busy !== null,
										onClick: () => mutate(plugin.name, plugin.enabled ? "disable" : "enable", { name: plugin.name })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: styles.danger,
										disabled: busy !== null,
										onClick: () => {
											if (window.confirm(`确定卸载 ${plugin.name} 吗？卸载后需重启 dsh web 生效。`)) mutate(plugin.name, "remove", { name: plugin.name });
										},
										children: "卸载"
									})
								]
							}, plugin.name))
						]
					}),
					builtins.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.heading,
							children: [
								"内置模块（",
								builtins.length,
								"，不可卸载）"
							]
						}), builtins.map((b) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: styles.rowMain,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: styles.name,
									children: b.name
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.badge,
								children: "内置"
							})]
						}, b.name))]
					}),
					notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.notice,
						children: notice
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.error,
						children: error
					})
				]
			});
		}
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "plugin-manager",
				order: 110,
				label: "插件管理"
			}, PluginManagerSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
