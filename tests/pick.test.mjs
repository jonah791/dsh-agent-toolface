/**
 * v0.6 单工具粒度（主人 2026-11-09 定调）：
 *   「禁止开 full，而且要能做到按需取用某个具体的工具，而不是开一整个域」
 *
 * 这两条都要**机制**而不是记性——所以各有尸体样本：
 *   ① pick 只放行那一个工具，同域的其他工具仍被 deny（证明粒度真是 1，不是 1 个域）
 *   ② unpick 收回（证明不是单向的）
 *   ③ pick 拼错名字必须响亮报错 + 给候选（静默无效是最坏的失效形态）
 *   ④ pick 不动已开域（否则开到一半的活会被 pick 打断）
 *   ⑤ full 无 reason ⇒ 拒绝执行（尸体：证明这道门真的会拦）
 *   ⑥ full 有 reason ⇒ 照常执行（证明门不是永远关死的）
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
  { name: 'red_dir_brute', description: 'brute', parameters: {} },
  { name: 'clyan_scan', description: 'scan', parameters: {} },
]

function fakeCtx(state) {
  return {
    logger: () => ({ info: () => {}, warn: m => state.warns.push(String(m)), error: m => state.errors.push(String(m)) }),
    tools: {
      schemas: () => state.schemas ?? SCHEMAS,
      restrict(filter) {
        state.restrictCalls.push(filter)
        return () => { state.lifted.push(true) }
      },
      register: def => { state.registered.push(def.name); state.toolDefs[def.name] = def },
    },
    on: (evt, cb) => { state.events.push(evt); state.handlers[evt] = cb },
  }
}

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'toolface-pick-'))
  process.env['DSH_HOME'] = dir
  return { dir, restrictCalls: [], lifted: [], registered: [], events: [], handlers: {}, warns: [], errors: [], toolDefs: {} }
}

const { apply } = await import('../lib/index.js')

function domainCfg() {
  return {
    mode: 'domain',
    domains: { cleanup: ['clyan_*'], security: ['sec_*'] },
    resident: ['read'],
    deny: [],
  }
}

async function callTool(state, args) {
  return state.toolDefs['toolface'].execute(args, {})
}

/** 最后一次 restrict 的 deny 集——「当前谁不可见」的唯一真源。 */
function lastDeny(state) {
  const last = state.restrictCalls[state.restrictCalls.length - 1]
  return last?.deny ?? []
}

test('pick：只放行这一个工具，同域其他工具仍被 deny（粒度 = 1，不是 1 个域）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'domain', name: 'cleanup' })
  assert.ok(lastDeny(state).includes('sec_hydra'), '基线：sec_hydra 应被 deny')
  assert.ok(lastDeny(state).includes('sec_nmap'), '基线：sec_nmap 应被 deny')

  const r = await callTool(state, { action: 'pick', name: 'sec_hydra' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.picked, ['sec_hydra'])
  assert.equal(lastDeny(state).includes('sec_hydra'), false, 'pick 后必须可见')
  assert.ok(lastDeny(state).includes('sec_nmap'), '同域的另一个工具必须仍被 deny')
})

test('unpick：收回刚放行的工具（不是单向开关）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'domain', name: 'cleanup' })
  await callTool(state, { action: 'pick', name: 'sec_hydra' })
  assert.equal(lastDeny(state).includes('sec_hydra'), false)

  const r = await callTool(state, { action: 'unpick', name: 'sec_hydra' })
  assert.deepEqual(r.picked, [])
  assert.ok(lastDeny(state).includes('sec_hydra'), 'unpick 后必须重新被 deny')
})

test('pick：拼错名字必须响亮报错并给相近候选（不许静默无效）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const r = await callTool(state, { action: 'pick', name: 'sec_hydr' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /未知工具名/)
  assert.match(r.reason, /sec_hydra/, '必须给出相近候选')
  assert.deepEqual(r.picked, [], '失败的 pick 不许留下任何放行')
})

test('pick：不动已开域（开到一半的活不该被 pick 打断）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup,security' })
  const r = await callTool(state, { action: 'pick', name: 'red_dir_brute' })
  assert.deepEqual([...r.openDomains].sort(), ['cleanup', 'security'], '已开域必须原样保留')
  assert.deepEqual(r.picked, ['red_dir_brute'])
})

test('尸体：full 不带 reason ⇒ 拒绝执行，档位不变', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'domain', name: 'cleanup' })
  const before = state.restrictCalls.length
  const r = await callTool(state, { action: 'full' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /reason/)
  assert.equal(state.restrictCalls.length, before, '被拒的 full 不许产生任何副作用')
  assert.notEqual(r.mode, 'full', '档位不许变成 full')
})

test('full 带 reason ⇒ 照常执行（门不是永远关死的）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'domain', name: 'cleanup' })
  const r = await callTool(state, { action: 'full', reason: '整批跨域作业，需要一次看全' })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'full')
})

// ── render 层的尸体样本 ─────────────────────────────────────────────
// 2026-11-09 实测：full 被拒后 render 只印了档位行，reason 被吞 ⇒ 我把「没执行」
// 读成了「执行了」。工具返回给我的**是 render 后的文本**，不渲染 = 我看不见。

function renderText(state, args, value) {
  const def = state.toolDefs['toolface']
  // render 住在 output 下（defineTool 的 output.render），不是工具定义顶层。
  const fn = def.render ?? def.output?.render
  const out = fn?.(args, value) ?? []
  return out.map(x => x.text ?? '').join('\n')
}

test('render：ok=false 时必须显式说「未执行」并带出原因', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const args = { action: 'full' }
  const value = await callTool(state, args)
  const text = renderText(state, args, value)
  assert.match(text, /未执行/, '必须显式说没执行')
  assert.match(text, /reason/, '必须把手带出原因')
})

test('render：pick 成功后能看见被放行的工具名（否则我不知道成没成）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const args = { action: 'pick', name: 'sec_hydra' }
  const value = await callTool(state, args)
  const text = renderText(state, args, value)
  assert.match(text, /sec_hydra/)
  assert.match(text, /单独放行/)
})
