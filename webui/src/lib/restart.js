/**
 * 触发 Agent 软重启，并轮询 /api/health 等待服务真正恢复。
 *
 * 重启会让当前 HTTP 服务先关闭再重开，因此不能依赖 /api/restart 的返回值，
 * 只能靠健康检查判定结果（响应可能在连接被掐断前就丢了）。
 */
const POLL_INTERVAL_MS = 800
const POLL_TIMEOUT_MS = 90000

/**
 * @param {(phase: 'running' | 'ok' | 'fail') => void} onPhase - 过程回调
 * @returns {Promise<'ok' | 'fail'>}
 */
export async function restartAgent(onPhase = () => {}) {
  onPhase('running')

  try {
    const res = await fetch('/api/restart', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
  } catch (e) {
    // 服务可能在响应送达前就断开，交由健康检查判定真实结果
    console.warn('[WebUI] restart request:', e.message)
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      const data = await res.json()
      if (data.ok && !data.restarting) {
        onPhase('ok')
        return 'ok'
      }
    } catch {
      // 服务尚未恢复，继续轮询
    }
  }

  onPhase('fail')
  return 'fail'
}
