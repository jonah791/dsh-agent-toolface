/**
 * dsh-agent-toolface 纯逻辑单测（跑 lib 产物，与生态约定一致）。
 * 判据：tests > 0 且 fail == 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditLine, denyFor, expandPatterns, faceCost, parseMode, planDomain } from '../lib/logic.js'

const KNOWN = ['sec_hydra', 'sec_nmap', 'red_dir_brute', 'read', 'edit', 'wq_simulate', 'clyan_scan']

test('expandPatterns：前缀模式命中多个', () => {
  const plan = expandPatterns(['sec_*'], KNOWN)
  assert.deepEqual(plan.matched, ['sec_hydra', 'sec_nmap'])
  assert.deepEqual(plan.unmatched, [])
})

test('expandPatterns：精确名命中', () => {
  const plan = expandPatterns(['read', 'edit'], KNOWN)
  assert.deepEqual(plan.matched, ['edit', 'read'])
})

test('expandPatterns：混合模式去重且保序输出未命中', () => {
  const plan = expandPatterns(['sec_*', 'read', 'sec_hydra', 'zzz_*', 'nope'], KNOWN)
  assert.deepEqual(plan.matched, ['read', 'sec_hydra', 'sec_nmap'])
  assert.deepEqual(plan.unmatched, ['zzz_*', 'nope'])
})

test('expandPatterns：空串/空白被忽略，空列表得空结果', () => {
  assert.deepEqual(expandPatterns(['', '   '], KNOWN), { matched: [], unmatched: [] })
  assert.deepEqual(expandPatterns([], KNOWN), { matched: [], unmatched: [] })
})

test('expandPatterns：裸前缀星号匹配全部', () => {
  const plan = expandPatterns(['*'], KNOWN)
  assert.equal(plan.matched.length, KNOWN.length)
  assert.deepEqual(plan.unmatched, [])
})

test('faceCost：只统计列名工具，token 按 4 字符口径上取整', () => {
  const schemas = [
    { name: 'read', description: 'read a file', parameters: { path: { type: 'string' } } },
    { name: 'edit', description: 'edit a file', parameters: {} },
    { name: 'other', description: 'x', parameters: {} },
  ]
  const cost = faceCost(schemas, ['read'])
  assert.equal(cost.count, 1)
  assert.ok(cost.chars > 0)
  assert.equal(cost.tokens, Math.ceil(cost.chars / 4))
})

test('faceCost：空集合得零（防线：不得虚报节省）', () => {
  const schemas = [{ name: 'read', description: 'x', parameters: {} }]
  assert.deepEqual(faceCost(schemas, []), { count: 0, chars: 0, tokens: 0 })
  assert.deepEqual(faceCost([], ['read']), { count: 0, chars: 0, tokens: 0 })
})

test('faceCost：缺 description/parameters 时按空值计价，不崩', () => {
  const cost = faceCost([{ name: 'bare' }], ['bare'])
  assert.equal(cost.count, 1)
  assert.ok(cost.chars > 0)
})

test('denyFor：full 一律空（撤销收窄）', () => {
  assert.deepEqual(denyFor('full', ['sec_*'], ['read']), [])
  assert.deepEqual(denyFor('full', [], undefined), [])
})

test('denyFor：lean 用配置，覆盖优先', () => {
  assert.deepEqual(denyFor('lean', ['sec_*'], undefined), ['sec_*'])
  assert.deepEqual(denyFor('lean', ['sec_*'], ['read']), ['read'])
  assert.deepEqual(denyFor('lean', [], undefined), [])
})

test('parseMode：只接受 lean/full', () => {
  assert.equal(parseMode('lean'), 'lean')
  assert.equal(parseMode('full'), 'full')
  assert.equal(parseMode('LEAN'), undefined)
  assert.equal(parseMode(''), undefined)
  assert.equal(parseMode(undefined), undefined)
  assert.equal(parseMode(42), undefined)
})

test('auditLine：单行 JSON、以换行结尾、字段可回读', () => {
  const line = auditLine({
    at: '2026-09-13T00:00:00.000Z',
    action: 'lean',
    mode: 'lean',
    applied: true,
    deniedCount: 63,
    globalTools: 274,
    savedTokens: 7708,
    unmatched: ['zzz_*'],
  })
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.trimEnd().includes('\n'), false)
  const parsed = JSON.parse(line)
  assert.equal(parsed.action, 'lean')
  assert.equal(parsed.applied, true)
  assert.equal(parsed.deniedCount, 63)
  assert.equal(parsed.globalTools, 274)
  assert.equal(parsed.savedTokens, 7708)
  assert.deepEqual(parsed.unmatched, ['zzz_*'])
  assert.equal('reason' in parsed, false)
})

test('auditLine：reason 存在时才写入该字段', () => {
  const parsed = JSON.parse(auditLine({
    at: 't', action: 'load', mode: 'full', applied: false,
    deniedCount: 0, globalTools: 3, savedTokens: 0, unmatched: [], reason: '示例原因',
  }))
  assert.equal(parsed.reason, '示例原因')
  assert.equal(parsed.mode, 'full')
})

// ── 按域开启（planDomain） ────────────────────────────────────────────────
// 域覆盖集 = 所有域工具并集；只有被域覆盖的工具才可能被 deny。
// 不在任何域里的工具永不被 deny（官方基础工具与新插件自动常驻，fail-safe）。

const DOMAINS = {
  quant: ['wq_*', 'quant_*'],
  cleanup: ['clyan_*'],
  security: ['sec_*'],
}
const RESIDENT = ['read', 'edit', 'remember']

test('planDomain：目标域不存在 ⇒ known=false、deny 为空（fail-loud，不许静默当「没东西可开」）', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, 'nope')
  assert.equal(plan.known, false)
  assert.deepEqual(plan.deny, [])
  assert.deepEqual(plan.unmatched, ['nope'])
})

test('planDomain：只 deny「被域覆盖 ∧ 非常驻 ∧ 非目标域」的工具', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, 'quant')
  // KNOWN 里被域覆盖：sec_hydra, sec_nmap, wq_simulate, clyan_scan
  // 目标域 quant ⇒ wq_simulate 保留；其余三个 deny
  assert.deepEqual(plan.deny, ['clyan_scan', 'sec_hydra', 'sec_nmap'])
  assert.deepEqual(plan.domainTools, ['wq_simulate'])
})

test('planDomain：不在任何域里的工具永不被 deny（read/edit 是官方基础工具）', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, 'quant')
  assert.equal(plan.deny.includes('read'), false)
  assert.equal(plan.deny.includes('edit'), false)
  assert.equal(plan.deny.includes('wq_simulate'), false) // 目标域，保留
})

test('planDomain：常驻模式可覆盖域内工具（常驻优先于域划分）', () => {
  const plan = planDomain(KNOWN, DOMAINS, ['read', 'wq_*'], 'cleanup')
  assert.deepEqual(plan.deny, ['sec_hydra', 'sec_nmap'])
  // 常驻模式解析的是**全部**工具（不限域内）⇒ read（域外）与 wq_simulate（域内）都命中
  assert.deepEqual(plan.residentTools, ['read', 'wq_simulate'])
  assert.deepEqual(plan.domainTools, ['clyan_scan'])
})

test('planDomain：空域表 ⇒ known=false 且零 deny（未配置时零回归）', () => {
  const plan = planDomain(KNOWN, {}, RESIDENT, 'quant')
  assert.equal(plan.known, false)
  assert.deepEqual(plan.deny, [])
})

test('planDomain：目标域内未命中的模式如实报出（不静默吞掉拼写错误）', () => {
  const plan = planDomain(KNOWN, { x: ['zzz_*', 'read'] }, [], 'x')
  assert.deepEqual(plan.unmatched, ['zzz_*'])
  assert.deepEqual(plan.domainTools, ['read'])
})

test('planDomain：目标域自身不被 deny（否则「开启」等于没开）', () => {
  for (const target of Object.keys(DOMAINS)) {
    const plan = planDomain(KNOWN, DOMAINS, RESIDENT, target)
    for (const tool of plan.domainTools) {
      assert.equal(plan.deny.includes(tool), false, `${target} 域工具 ${tool} 不该被 deny`)
    }
  }
})

test('parseMode：domain 是合法档位', () => {
  assert.equal(parseMode('domain'), 'domain')
})

test('planDomain：target=undefined ⇒「只常驻」（mode=domain 的默认态，不是错误）', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, undefined)
  assert.equal(plan.known, true)
  assert.deepEqual(plan.unmatched, [])
  assert.deepEqual(plan.domainTools, [])
  // 只留常驻 read/edit/remember ⇒ 被域覆盖的四个全 deny
  assert.deepEqual(plan.deny, ['clyan_scan', 'sec_hydra', 'sec_nmap', 'wq_simulate'])
  // 未归类工具仍不出现
  assert.equal(plan.deny.includes('read'), false)
})
