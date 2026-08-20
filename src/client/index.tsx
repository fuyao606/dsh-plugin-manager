/**
 * dsh-plugin-manager client 半：在 DSH 设置面板注册「插件管理」section，
 * 通过 host 的 /plugin-manager/api 列出 / 启用 / 禁用 / 安装 / 卸载 web profile 插件。
 * 只依赖模块表提供的 react；类型全部结构化，不 import @deepseek-ai/* 值。
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'

interface SlotsService {
  register(options: unknown, component: unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}
interface ClientContext {
  slots: SlotsService
}

export const inject = ['slots']

interface PluginRow {
  name: string
  range: string
  version: string
  description: string
  isBundle: boolean
  enabled: boolean
  status: 'enabled' | 'disabled' | 'blocked' | 'dependency'
  conflicts: string[]
}
interface BuiltinRow {
  name: string
}
interface ListResult {
  profileDir: string
  plugins: PluginRow[]
  builtins: BuiltinRow[]
}
interface MutateResult {
  restartRequired?: boolean
  output?: string
}

async function apiCall<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/plugin-manager/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const parsed = (await response.json().catch(() => null)) as
    | { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
    | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value as T
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 16 },
  intro: { margin: 0, opacity: 0.72, fontSize: 13, lineHeight: 1.6 },
  group: { display: 'flex', flexDirection: 'column', gap: 8 },
  heading: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2 },
  installRow: { display: 'flex', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
  },
  button: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  },
  primary: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid transparent',
    background: '#4d6bfe',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
  danger: {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(224,90,90,0.5)',
    background: 'transparent',
    color: '#e05a5a',
    fontSize: 12,
    cursor: 'pointer',
  },
  row: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(128,128,128,0.18)',
  },
  rowMain: { flex: 1, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 600, wordBreak: 'break-all' },
  meta: { fontSize: 12, opacity: 0.62, marginTop: 2, wordBreak: 'break-word' },
  badge: {
    fontSize: 11,
    padding: '2px 6px',
    borderRadius: 6,
    background: 'rgba(128,128,128,0.15)',
    whiteSpace: 'nowrap',
  },
  badgeOn: { background: 'rgba(77,107,254,0.18)', color: '#9db2ff' },
  badgeOff: { background: 'rgba(128,128,128,0.12)', color: 'inherit' },
  badgeBlocked: { background: 'rgba(224,90,90,0.18)', color: '#f2a1a1' },
  conflict: { marginTop: 6, color: '#f2a1a1', whiteSpace: 'pre-wrap' },
  notice: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(77,107,254,0.12)',
    color: '#9db2ff',
    fontSize: 12,
    lineHeight: 1.5,
  },
  error: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(224,90,90,0.12)',
    color: '#f2a1a1',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
  },
  muted: { opacity: 0.55, fontSize: 12 },
}

function ToggleButton(props: { enabled: boolean; blocked: boolean; onClick: () => void; busy: boolean }) {
  if (props.blocked) return null
  return (
    <button
      type="button"
      style={{ ...styles.button, minWidth: 76 }}
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.enabled ? '禁用' : '启用'}
    </button>
  )
}

function PluginManagerSection(): ReactNode {
  const [data, setData] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')

  const load = (): void => {
    apiCall<ListResult>('list')
      .then((value) => {
        setData(value)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    load()
  }, [])

  const mutate = (label: string, method: string, payload: Record<string, unknown>): void => {
    setBusy(label)
    setError(null)
    setNotice(null)
    apiCall<MutateResult>(method, payload)
      .then((result) => {
        if (result.restartRequired) {
          setNotice('✅ 已修改。改动在重启 dsh web 并硬刷新浏览器（Ctrl+Shift+R）后生效。')
        }
        return apiCall<ListResult>('list')
      })
      .then((value) => setData(value))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  const plugins = data?.plugins ?? []
  const builtins = data?.builtins ?? []

  return (
    <div style={styles.section}>
      <p style={styles.intro}>
        管理本机 web profile 已安装的插件。启用 / 禁用 / 安装 / 卸载后需重启 dsh web 生效。
        {data !== null && (
          <span style={styles.muted}>
            {' '}目录：{data.profileDir}
          </span>
        )}
      </p>

      <div style={styles.group}>
        <div style={styles.heading}>安装插件</div>
        <div style={styles.installRow}>
          <input
            style={styles.input}
            placeholder="例如 @tonydua/dsh-web-search-exa 或 dsh-better-sidebar@latest"
            value={spec}
            onChange={(event) => setSpec(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && spec.trim() !== '' && busy === null) {
                mutate('install', 'install', { spec: spec.trim() })
              }
            }}
          />
          <button
            type="button"
            style={styles.primary}
            disabled={busy !== null || spec.trim() === ''}
            onClick={() => mutate('install', 'install', { spec: spec.trim() })}
          >
            {busy === 'install' ? '安装中…' : '安装'}
          </button>
        </div>
      </div>

      <div style={styles.group}>
        <div style={styles.heading}>已安装插件（{plugins.length}）</div>
        {plugins.length === 0 && <div style={styles.muted}>暂无用户安装的插件。</div>}
        {plugins.map((plugin) => (
          <div key={plugin.name} style={styles.row}>
            <div style={styles.rowMain}>
              <div style={styles.name}>{plugin.name}</div>
              <div style={styles.meta}>
                {plugin.version !== '' ? `v${plugin.version}` : plugin.range}
                {plugin.isBundle ? ' · bundle' : ' · 普通依赖'}
                {plugin.description !== '' ? ` · ${plugin.description}` : ''}
                {plugin.status === 'blocked' && <div style={styles.conflict}>冲突：{plugin.conflicts.join(', ')}</div>}
              </div>
            </div>
            <span style={{ ...styles.badge, ...(plugin.status === 'blocked' ? styles.badgeBlocked : plugin.enabled ? styles.badgeOn : styles.badgeOff) }}>
              {plugin.status === 'blocked' ? '已阻断' : plugin.status === 'dependency' ? '普通依赖' : plugin.enabled ? '已启用' : '已禁用'}
            </span>
            <ToggleButton
              enabled={plugin.enabled}
              blocked={plugin.status === 'blocked' || plugin.status === 'dependency'}
              busy={busy !== null}
              onClick={() => mutate(plugin.name, plugin.enabled ? 'disable' : 'enable', { name: plugin.name })}
            />
            <button
              type="button"
              style={styles.danger}
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(`确定卸载 ${plugin.name} 吗？卸载后需重启 dsh web 生效。`)) {
                  mutate(plugin.name, 'remove', { name: plugin.name })
                }
              }}
            >
              卸载
            </button>
          </div>
        ))}
      </div>

      {builtins.length > 0 && (
        <div style={styles.group}>
          <div style={styles.heading}>内置模块（{builtins.length}，不可卸载）</div>
          {builtins.map((b) => (
            <div key={b.name} style={styles.row}>
              <div style={styles.rowMain}>
                <div style={styles.name}>{b.name}</div>
              </div>
              <span style={styles.badge}>内置</span>
            </div>
          ))}
        </div>
      )}

      {notice !== null && <div style={styles.notice}>{notice}</div>}
      {error !== null && <div style={styles.error}>{error}</div>}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'plugin-manager',
        order: 110,
        label: '插件管理',
      },
      PluginManagerSection,
    ),
  )
}
