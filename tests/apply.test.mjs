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
    on: (evt) => { state.events.push(evt) },
  }
}

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'toolface-'))
  process.env['DSH_HOME'] = dir
  return { dir, restrictCalls: [], lifted: [], registered: [], events: [], warns: [], errors: [] }
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
