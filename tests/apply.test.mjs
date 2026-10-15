/**
 * 装载路径验证：用最小 fake ctx 调 apply()，证明
 *   ① deny 模式真被展开成具体工具名并交给宿主 restrict；
 *   ② toolface 工具真被注册；
 *   ③ 审计行真落盘；
 *   ④ 非法 mode 加载即抛错（fail-loud）；
 *   ⑤ restrict 抛错时插件仍加载（fail-soft 但不静默）。
 * 真实组合证据由线上会话日志的工具面实测提供（见 docs/semantic.md §7）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCHEMAS = [
  { name: 'read', description: 'read', parameters: {} },
  { name: 'sec_hydra', description: 'hydra', parameters: {} },
  { name: 'sec_nmap', description: 'nmap', parameters: {} },
  { name: 'red_dir_brute', description: 'brute', parameters: {} },
  { name: 'clyan_scan', description: 'scan', parameters: {} },
]

function fakeCtx(state) {
  return {
    logger: () => ({ info: () => {}, warn: m => state.warns.push(String(m)), error: m => state.errors.push(String(m)) }),
    tools: {
      schemas: () => SCHEMAS,
      restrict(filter) {
        state.restrictCalls.push(filter)
        if (state.restrictThrows) throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
        return () => { state.lifted.push(true) }
      },
      register: def => { state.registered.push(def.name) },
    },
    on: (evt, cb) => { state.events.push(evt); state.handlers[evt] = cb },
  }
}

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'toolface-'))
  process.env['DSH_HOME'] = dir
  return { dir, restrictCalls: [], lifted: [], registered: [], events: [], handlers: {}, warns: [], errors: [] }
}

const { apply } = await import('../lib/index.js')

test('apply：lean 档把模式展开成具体工具名并调用 restrict', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'lean', deny: ['sec_*', 'red_*', 'nope'] })
  assert.equal(state.restrictCalls.length, 1)
  assert.deepEqual(state.restrictCalls[0].deny, ['red_dir_brute', 'sec_hydra', 'sec_nmap'])
  assert.deepEqual(state.registered, ['toolface'])
  assert.deepEqual(state.events, ['tools/change'])
})

test('apply：未命中的模式不静默——写入 warning 且不出现在 deny 里', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'lean', deny: ['sec_*', 'zzz_*'] })
  assert.equal(state.restrictCalls[0].deny.includes('zzz_*'), false)
})

test('apply：full 档不调用 restrict（零副作用）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'full', deny: ['sec_*'] })
  assert.equal(state.restrictCalls.length, 0)
  assert.deepEqual(state.registered, ['toolface'])
})

test('apply：deny 全未命中时不调用 restrict（宿主对未知工具名抛错）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'lean', deny: ['zzz_*'] })
  assert.equal(state.restrictCalls.length, 0)
  assert.equal(state.warns.some(w => w.includes('全部未命中')), true)
})

test('apply：非法 mode 加载即抛错（fail-loud）', async () => {
  const state = await freshState()
  assert.throws(() => apply(fakeCtx(state), { mode: 'LEAN', deny: [] }), /必须是 'lean' 或 'full'/)
})

test('apply：restrict 抛错时插件仍加载，错误落 logger', async () => {
  const state = await freshState()
  state.restrictThrows = true
  apply(fakeCtx(state), { mode: 'lean', deny: ['sec_*'] })
  assert.deepEqual(state.registered, ['toolface'])
  assert.equal(state.errors.some(e => e.includes('收窄失败')), true)
})

test('apply：审计行落盘且可回读（含 applied/deniedCount/savedTokens）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'lean', deny: ['sec_*'] })
  await new Promise(r => setTimeout(r, 50))
  const text = await readFile(join(state.dir, 'toolface-events.log'), 'utf8')
  const entry = JSON.parse(text.trim().split('\n').pop())
  assert.equal(entry.action, 'load')
  assert.equal(entry.mode, 'lean')
  assert.equal(entry.applied, true)
  assert.equal(entry.deniedCount, 2)
  assert.equal(entry.globalTools, SCHEMAS.length)
  assert.ok(entry.savedTokens > 0)
})

// ── 2026-10-03 自激循环回归 ────────────────────────────────────────────────
// 症状（线上实测）：web 进程 34% 单核持续占用、审计日志 231 万行 / 439 MB、
// 工具调用后主模型请求长时间无响应。根因＝原守卫 `unmatched.length === 0` 在
// 「配置里有永不命中的模式」时恒不成立，而 reapply 内的 restrict() 又触发
// tools/change ⇒ 自激。
// 本测试锁住新判据：**未命中数没变少 ⇒ 不得重挂**。
test('apply：unmatched 恒定（无新工具注册）时 tools/change 不重挂 —— 防自激循环', async () => {
  const state = await freshState()
  apply(fakeCtx(state), { mode: 'lean', deny: ['sec_*', 'zzz_*'] }) // zzz_* 永不命中
  const before = state.restrictCalls.length
  const handler = state.handlers['tools/change']
  assert.equal(typeof handler, 'function', 'tools/change 监听器应已注册')
  for (let i = 0; i < 5; i += 1) handler()          // 模拟 restrict() 反复触发
  await new Promise(r => setTimeout(r, 500))        // 越过 250 ms 去抖
  assert.equal(state.restrictCalls.length, before,
    'unmatched 未变少时不得重挂（否则自激：每 ~275ms 一次全量 schema 快照）')
})
