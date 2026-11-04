/**
 * v0.3 多域（2026-11-04）：一次开多个域 + 让「切之前先知道代价」成为可能。
 *
 * 动机（33 天审计 2,205 行 / 156 次真实切换的读数）：域切换约 4.7 次/天，而
 * 「改插件 + 查情报 + 生成素材」这类跨域活只能靠来回切，每切一次付一次全量 schema
 * 快照（274 工具 ≈ 8s）。多域让并集一次生效。**不碰 I5**（仍是运行期状态）。
 *
 * 判据：单域行为零回归（v0.2 的 30 条测试仍全绿）+ 多域并集 + 未知域 fail-loud 不半开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainCosts, domainCoverage, planDomain } from '../lib/logic.js'

const KNOWN = ['sec_hydra', 'sec_nmap', 'red_dir_brute', 'read', 'edit', 'wq_simulate', 'clyan_scan']
const DOMAINS = {
  quant: ['wq_*', 'quant_*'],
  cleanup: ['clyan_*'],
  security: ['sec_*'],
}
const RESIDENT = ['read', 'edit', 'remember']

test('多域：数组形态 ⇒ 各域工具取并集都保留，其余被 deny', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, ['quant', 'cleanup'])
  assert.equal(plan.known, true)
  assert.deepEqual(plan.domainTools, ['clyan_scan', 'wq_simulate'])
  // 只 deny「域内 ∧ 非常驻 ∧ 非目标域」：sec_* 两个。
  // red_dir_brute 不在任何域 ⇒ 按 I9 ③ 永不被 deny（这是 fail-safe 的落点，不是遗漏）。
  assert.deepEqual(plan.deny, ['sec_hydra', 'sec_nmap'])
  assert.equal(plan.deny.includes('red_dir_brute'), false, '域外工具不得被收窄')
})

test('多域：单字符串与「数组含一个」等价（向后兼容 v0.2 调用点）', () => {
  const one = planDomain(KNOWN, DOMAINS, RESIDENT, 'quant')
  const arr = planDomain(KNOWN, DOMAINS, RESIDENT, ['quant'])
  assert.deepEqual(one.deny, arr.deny)
  assert.deepEqual(one.domainTools, arr.domainTools)
  assert.deepEqual(one.unknownDomains, arr.unknownDomains)
  assert.equal(one.known, arr.known)
})

test('多域：重复域 id 去重（不重复计入 domainTools）', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, ['quant', 'quant'])
  assert.deepEqual(plan.domainTools, ['wq_simulate'])
})

test('多域：任一域未知 ⇒ known=false、零 deny、unknownDomains 逐个列出', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, ['quant', 'nope', 'alsonope'])
  assert.equal(plan.known, false)
  assert.deepEqual(plan.deny, [])
  assert.deepEqual(plan.unknownDomains, ['nope', 'alsonope'])
  // unmatched 保持 v0.2 语义：未知域名先进这里（排在前），随后是域内未命中的模式。
  // quant 域的 'quant_*' 在 KNOWN 里没有对应工具 ⇒ 属 I3「未命中不静默」。
  assert.deepEqual(plan.unmatched, ['nope', 'alsonope', 'quant_*'])
})

test('尸体：多域里有一个未知时**不得**只开已知的那个（半开是沉默的假读数）', () => {
  const plan = planDomain(KNOWN, DOMAINS, RESIDENT, ['quant', 'nope'])
  assert.deepEqual(plan.domainTools, [], '未知域存在时不得返回部分域的工具')
  assert.equal(plan.known, false)
})

test('多域：空数组 ≡ undefined（都是「只常驻」）', () => {
  const a = planDomain(KNOWN, DOMAINS, RESIDENT, [])
  const b = planDomain(KNOWN, DOMAINS, RESIDENT, undefined)
  assert.deepEqual(a.deny, b.deny)
  assert.equal(a.known, true)
  assert.deepEqual(a.unknownDomains, [])
})

test('domainCosts：逐域给出工具数与 token，按 token 降序', () => {
  const schemas = KNOWN.map(n => ({ name: n, description: n + ' desc', parameters: {} }))
  const rows = domainCosts(schemas, DOMAINS)
  assert.deepEqual(rows.map(r => r.id).sort(), ['cleanup', 'quant', 'security'])
  const sec = rows.find(r => r.id === 'security')
  assert.equal(sec.tools, 2)
  assert.ok(sec.tokens > 0)
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].tokens >= rows[i].tokens, '必须按 token 降序')
  }
})

test('domainCosts：域内模式全未命中时 tools=0（暴露拼写错误，不静默消失）', () => {
  const schemas = [{ name: 'read', description: 'x', parameters: {} }]
  const rows = domainCosts(schemas, { typo: ['zzz_*'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tools, 0)
})

test('domainCoverage：域外工具数 + 体量（收窄的地板）', () => {
  const schemas = KNOWN.map(n => ({ name: n, description: n + ' d', parameters: {} }))
  const cov = domainCoverage(schemas, DOMAINS)
  // 被域覆盖 sec_hydra/sec_nmap/wq_simulate/clyan_scan = 4；域外 read/edit/red_dir_brute = 3
  assert.equal(cov.covered, 4)
  assert.equal(cov.outside, 3)
  assert.ok(cov.outsideTokens > 0)
})

test('domainCoverage：空域表 ⇒ 全部域外（未配置时什么都不收窄，零回归）', () => {
  const schemas = KNOWN.map(n => ({ name: n, description: '', parameters: {} }))
  const cov = domainCoverage(schemas, {})
  assert.equal(cov.covered, 0)
  assert.equal(cov.outside, KNOWN.length)
})
