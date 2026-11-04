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
      // 可变快照：模拟「启动期 tools.schemas() 不全 → 运行期陆续注册齐」这条真实路径
      // （2026-11-04 线上实测 load 时 329 个、稳定后 440 个）。
      schemas: () => state.schemas ?? SCHEMAS,
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

// ── output schema 一致性（2026-11-04 实测踩到） ──────────────────────────
// 症状：status 返回 domainCosts[].chars，而 output schema 只声明了 id/tools/tokens，
// 宿主按 additionalProperties:false 校验 ⇒ 整个调用失败：
//   tool "toolface" returned invalid output: "value.domainCosts[0].chars" is not a declared property
// 根因：测试只断言字段**类型**，没跑 output schema 校验 ⇒ 测试绿而线上红。
// 判据：每个 action 的返回值都必须通过它自己的 output schema。

/** 最小 JSON-schema 校验器（只覆盖本插件 schema 用到的 keyword） */
function validateSchema(value, schema, path = '$', errs = []) {
  if (schema === undefined) return errs
  const t = schema.type
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errs.push(path + ' 应为 object')
      return errs
    }
    const props = schema.properties ?? {}
    for (const [k, sub] of Object.entries(props)) {
      if (sub?.required === true && !(k in value)) errs.push(path + '.' + k + ' 缺失（required）')
      else if (k in value) validateSchema(value[k], sub, path + '.' + k, errs)
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errs.push(path + '.' + k + ' 未声明（additionalProperties:false）')
      }
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { errs.push(path + ' 应为 array'); return errs }
    value.forEach((v, i) => validateSchema(v, schema.items, path + '[' + i + ']', errs))
  } else if (t === 'number') {
    if (typeof value !== 'number') errs.push(path + ' 应为 number')
  } else if (t === 'string') {
    if (typeof value !== 'string') errs.push(path + ' 应为 string')
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') errs.push(path + ' 应为 boolean')
  }
  return errs
}

test('schema-parity：每个 action 的返回值都通过自身 output schema', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const schema = state.toolDefs['toolface'].output.schema
  assert.ok(schema, 'toolface 应声明 output.schema')

  const cases = [
    { action: 'status' },
    { action: 'open', name: 'cleanup,security' },
    { action: 'domain', name: 'cleanup' },
    { action: 'close', name: 'cleanup' },
    { action: 'close' },
    { action: 'full' },
    { action: 'lean', deny: ['sec_*'] },
    { action: 'open' },              // 缺 name ⇒ ok:false 分支也要合规
    { action: 'domain', name: 'nope' }, // 未知域分支
  ]
  for (const args of cases) {
    const r = await callTool(state, args)
    const errs = validateSchema(r, schema)
    assert.deepEqual(errs, [], 'action=' + args.action + ' 返回值不合 output schema：' + errs.join('; '))
  }
})

test('尸体：schema 校验器本身会拦——手工构造一个多字段的返回值必须报错', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', required: true } },
  }
  const errs = validateSchema({ id: 'x', chars: 42 }, schema)
  assert.equal(errs.length, 1, '未声明字段必须被拦（否则本套 parity 测试恒真）')
  assert.match(errs[0], /chars/)
})

// ── 启动期快照不全（2026-11-04 线上实测，主人批准修） ────────────────────
// 症状：load 时 tools.schemas() 只有 329 个工具（其他插件还没注册完），而
// `deny = covered − keep` 是从那次快照算的 ⇒ 19 个该被收窄的工具从启动到关停
// 一直可见（实测白占 2,554 tok/轮），直到手动切一次档才修正。
// 根因：补挂守卫 `unmatched.length === 0` 在域模式下恒成立 ⇒ 永不重挂。
// 那个守卫是 2026-10-03 自激事故（231 万行日志 / 34% CPU）留下的——治自激是对的，
// 但把「工具数增长」这个正当的重挂理由也一起挡掉了。

test('启动期工具未注册齐 ⇒ 工具数增长时补挂重算，新注册的域内工具必须被纳入 deny', async () => {
  const state = await freshState()
  // 启动瞬间：只有前 3 个（read / sec_hydra / sec_nmap）
  state.schemas = SCHEMAS.slice(0, 3)
  apply(fakeCtx(state), domainCfg())
  assert.deepEqual(state.restrictCalls[0].deny, ['sec_hydra', 'sec_nmap'],
    '启动瞬间只能 deny 已知的域内工具（这就是快照不全的现场）')

  // 运行期：其余工具陆续注册（clyan_scan 属 cleanup 域）
  state.schemas = SCHEMAS
  const before = state.restrictCalls.length
  state.handlers['tools/change']()
  await new Promise(r => setTimeout(r, 600))   // 越过 250ms 去抖

  assert.ok(state.restrictCalls.length > before, '工具数变多必须触发补挂（否则漏 deny 永久生效）')
  const last = state.restrictCalls[state.restrictCalls.length - 1]
  assert.ok(last.deny.includes('clyan_scan'), '新注册的域内工具必须进入 deny')
})

test('尸体：工具数没变时反复触发 tools/change ⇒ 最多重算 1 次（不自激）', async () => {
  const state = await freshState()
  apply(fakeCtx(state), domainCfg())
  const before = state.restrictCalls.length
  const handler = state.handlers['tools/change']
  for (let i = 0; i < 30; i += 1) handler()   // 模拟 restrict() 自身触发的 change 风暴
  await new Promise(r => setTimeout(r, 800))
  const extra = state.restrictCalls.length - before
  assert.ok(extra <= 1, '工具数没变时最多重算 1 次，实际 ' + extra + ' 次 —— 自激！')
})

test('启动期分批注册：中间夹一次「无进展」的 change 不得提前关闸', async () => {
  const state = await freshState()
  state.schemas = SCHEMAS.slice(0, 3)          // 启动瞬间：read/sec_hydra/sec_nmap
  apply(fakeCtx(state), domainCfg())
  const handler = state.handlers['tools/change']
  const base = state.restrictCalls.length

  // 批次 1：red_dir_brute 注册进来（工具数涨了，但它不在任何域 ⇒ deny 不变）
  state.schemas = SCHEMAS.slice(0, 4)
  handler()
  await new Promise(r => setTimeout(r, 400))
  assert.equal(state.restrictCalls.length, base + 1, '批次 1 应触发一次补挂')

  // 夹一次「无进展」（模拟 restrict 自身触发的 change，此时工具集没动）
  handler()
  await new Promise(r => setTimeout(r, 400))

  // 批次 2：clyan_scan 注册进来（属 cleanup 域 ⇒ 必须被纳入 deny）
  state.schemas = SCHEMAS
  handler()
  await new Promise(r => setTimeout(r, 400))

  const last = state.restrictCalls[state.restrictCalls.length - 1]
  assert.ok(last.deny.includes('clyan_scan'),
    '夹一次无进展后仍须跟到后续批次——v0.3.0 初版在这里提前关闸，实测 deny 停在 282 而正确值是 299')
})
