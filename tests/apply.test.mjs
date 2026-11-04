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
      register: def => { state.registered.push(def.name); state.toolDefs[def.name] = def },
    },
    on: (evt, cb) => { state.events.push(evt); state.handlers[evt] = cb },
  }
}

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'toolface-'))
  process.env['DSH_HOME'] = dir
  return { dir, restrictCalls: [], lifted: [], registered: [], events: [], handlers: {}, warns: [], errors: [], toolDefs: {} }
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

// ── v0.3 多域开关（open / close / domain 替换） ──────────────────────────
// 这三条走工具入口（execute），logic 层测不到——而它们才是「开关策略」的实质。
async function callTool(state, args) {
  const def = state.toolDefs['toolface']
  return await def.execute(args, {})
}

/** 带域表的装载配置：cleanup=clyan_* / security=sec_* / resident=read。
 *  SCHEMAS 里 read 与 red_dir_brute 不在任何域 ⇒ 永久可见（域外地板）。 */
function domainCfg() {
  return {
    mode: 'domain',
    domains: { cleanup: ['clyan_*'], security: ['sec_*'] },
    resident: ['read'],
    deny: [],
  }
}

test('open：累加——开第二个域不关掉第一个', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup' })
  assert.deepEqual(state.restrictCalls[state.restrictCalls.length - 1].deny, ['sec_hydra', 'sec_nmap'])
  const r = await callTool(state, { action: 'open', name: 'security' })
  assert.deepEqual([...r.openDomains].sort(), ['cleanup', 'security'])
  // 两域并集覆盖了全部域内工具 ⇒ deniedCount=0。
  // ⚠ 此时**不会**新增 restrict 调用（原验收 4：deny 为空时不调 restrict，避免宿主对空收窄抛错），
  // 所以判据必须看返回值，不能看「最后一次 restrict 调用」——它在收窄解除时会停在旧值上。
  assert.equal(r.deniedCount, 0, '两域并集覆盖全部域内工具 ⇒ 无可 deny 项')
})

test('domain：替换语义（v0.2 行为不变）——只留最后给的那个域', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup' })
  const r = await callTool(state, { action: 'domain', name: 'security' })
  assert.deepEqual(r.openDomains, ['security'])
  assert.deepEqual(state.restrictCalls[state.restrictCalls.length - 1].deny, ['clyan_scan'])
})

test('close：移除指定域；不带 name 则清空回只常驻', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup' })
  await callTool(state, { action: 'open', name: 'security' })
  const after = await callTool(state, { action: 'close', name: 'cleanup' })
  assert.deepEqual(after.openDomains, ['security'])
  const all = await callTool(state, { action: 'close' })
  assert.deepEqual(all.openDomains, [])
})

test('open：name 缺失 ⇒ ok=false 且不重挂（不许静默 no-op）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const before = state.restrictCalls.length
  const r = await callTool(state, { action: 'open' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /需要 name/)
  assert.equal(state.restrictCalls.length, before)
})

test('open：重复开同一个域 ⇒ 幂等，不新增 restrict 调用（I2）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup' })
  const before = state.restrictCalls.length
  await callTool(state, { action: 'open', name: 'cleanup' })
  assert.equal(state.restrictCalls.length, before, '已开的域不应触发重挂')
})

test('status：报已开域 + 各域成本 + 域外地板（切之前先知道代价）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup,security' })
  const r = await callTool(state, { action: 'status' })
  assert.deepEqual([...r.openDomains].sort(), ['cleanup', 'security'])
  assert.ok(Array.isArray(r.domainCosts) && r.domainCosts.length === 2)
  assert.ok(r.domainCosts.every(c => typeof c.tools === 'number' && typeof c.tokens === 'number'))
  assert.equal(r.outside.tools, 2, 'read 与 red_dir_brute 在域外')
})

test('尸体：open 一个拼错的域名不改变已开域（不许因为拼错就把状态清空）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  await callTool(state, { action: 'open', name: 'cleanup' })
  const r = await callTool(state, { action: 'open', name: 'typo-domain' })
  assert.match(r.reason, /未知域/, '必须响亮报出未知域')
  assert.deepEqual(r.openDomains, ['cleanup'], '已开域必须保留')
})
