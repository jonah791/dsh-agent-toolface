/**
 * v0.4「只注入变更」的验收：
 *   ① sticky 下 **从不** 调用 `tools.restrict()`（schema 恒定 ⇒ 缓存前缀不动）；
 *   ② 开关改由执行前门禁表达（门禁不进前缀）；
 *   ③ 变更增量写进工具返回值（追加进历史，不新建注入通道）；
 *   ④ 门禁不锁逃生门（`toolface` / `run_code` 永不被自己拒绝）；
 *   ⑤ 尸体：sticky=false 时旧语义原样保留（证明没把旧路径改坏）。
 *
 * 真实代价证据在 docs/semantic.md §8（2026-11-09 会话 3e786db2 实测：
 * 短间隔 ≤120 秒里命中率 <50% 的 16 条，16/16 都紧跟工具面变化）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCHEMAS = [
  { name: 'read', description: 'read', parameters: {} },
  { name: 'sec_hydra', description: 'hydra', parameters: {} },
  { name: 'sec_nmap', description: 'nmap', parameters: {} },
  { name: 'clyan_scan', description: 'scan', parameters: {} },
  { name: 'toolface', description: 'tf', parameters: {} },
]

const DOMAINS = { security: ['sec_*'], cleanup: ['clyan_*'] }
const RESIDENT = ['read', 'toolface']

function fakeCtx(state) {
  return {
    logger: () => ({
      info: () => {},
      warn: m => state.warns.push(String(m)),
      error: m => state.errors.push(String(m)),
    }),
    tools: {
      schemas: () => state.schemas ?? SCHEMAS,
      restrict(filter) {
        state.restrictCalls.push(filter)
        return () => { state.lifted.push(true) }
      },
      guard(fn) {
        state.guards.push(fn)
        return () => { state.guardLifted.push(true) }
      },
      register: def => { state.registered.push(def.name); state.toolDefs[def.name] = def },
    },
    on: (evt, cb) => { state.events.push(evt); state.handlers[evt] = cb },
  }
}

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'toolface-sticky-'))
  process.env['DSH_HOME'] = dir
  return {
    dir, restrictCalls: [], lifted: [], guards: [], guardLifted: [],
    registered: [], events: [], handlers: {}, warns: [], errors: [], toolDefs: {},
  }
}

const { apply } = await import('../lib/index.js')

const stickyConfig = () => ({ mode: 'domain', domains: DOMAINS, resident: RESIDENT, sticky: true })
/** 当前生效的门禁（最后一次注册的那个）。 */
const liveGuard = state => state.guards[state.guards.length - 1]

test('sticky：load 不调用 restrict（schema 恒定，零前缀改动）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), stickyConfig())
  assert.equal(state.restrictCalls.length, 0)
  assert.equal(state.lifted.length, 0)
  assert.deepEqual(state.registered, ['toolface'])
})

test('sticky：只常驻时门禁拦住域内工具，放行常驻', async () => {
  const state = await freshState()
  apply(fakeCtx(state), stickyConfig())
  const gate = liveGuard(state)
  assert.match(String(gate({ name: 'sec_hydra' })), /未开启/)
  assert.equal(gate({ name: 'read' }), undefined)
})

test('sticky：open 放行该域工具，restrict 仍一次都不调', async () => {
  const state = await freshState()
  apply(fakeCtx(state), stickyConfig())
  const value = await state.toolDefs.toolface.execute({ action: 'open', name: 'security' })
  assert.equal(value.ok, true)
  assert.equal(state.restrictCalls.length, 0)
  const gate = liveGuard(state)
  assert.equal(gate({ name: 'sec_hydra' }), undefined)
  assert.match(String(gate({ name: 'clyan_scan' })), /未开启/)
  // ③ 变更增量在返回值里（这就是「只注入变更」的载体）
  assert.deepEqual(value.nowAvailable, ['sec_hydra', 'sec_nmap'])
  assert.deepEqual(value.nowGated, [])
  assert.equal(value.sticky, true)
  assert.equal(value.savedTokens, 0)   // 一个字符都没从上下文移除 ⇒ 不许虚报节省
})

test('sticky：close 收回来后重新拦，且增量方向相反', async () => {
  const state = await freshState()
  apply(fakeCtx(state), stickyConfig())
  await state.toolDefs.toolface.execute({ action: 'open', name: 'security' })
  const value = await state.toolDefs.toolface.execute({ action: 'close', name: 'security' })
  const gate = liveGuard(state)
  assert.match(String(gate({ name: 'sec_hydra' })), /未开启/)
  assert.deepEqual(value.nowGated, ['sec_hydra', 'sec_nmap'])
  assert.deepEqual(value.nowAvailable, [])
  assert.equal(state.restrictCalls.length, 0)
})

test('门禁不锁逃生门：即使整面工具都被门禁，toolface 与 run_code 仍放行', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'domain', domains: { all: ['*'] }, resident: [], sticky: true })
  const gate = liveGuard(state)
  assert.equal(gate({ name: 'toolface' }), undefined)
  assert.equal(gate({ name: 'run_code' }), undefined)
  assert.match(String(gate({ name: 'read' })), /未开启/)
})

test('尸体：sticky=false 时旧语义原样保留（照旧调 restrict）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { ...stickyConfig(), sticky: false })
  assert.equal(state.restrictCalls.length, 1)
  assert.deepEqual(state.restrictCalls[0].deny, ['clyan_scan', 'sec_hydra', 'sec_nmap'])
  assert.equal(state.guards.length, 0)
})

test('尸体：sticky 下即使宿主没有 tools.guard()，也不回落到 restrict（宁可明报，不偷偷改前缀）', async () => {
  const state = await freshState()
  const ctx = fakeCtx(state)
  delete ctx.tools.guard
  apply(ctx, stickyConfig())
  assert.equal(state.restrictCalls.length, 0)
  assert.ok(state.warns.some(w => w.includes('tools.guard()')))
})
