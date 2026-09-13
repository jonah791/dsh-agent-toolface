/**
 * dsh-agent-toolface 纯逻辑单测（跑 lib 产物，与生态约定一致）。
 * 判据：tests > 0 且 fail == 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditLine, denyFor, expandPatterns, faceCost, parseMode } from '../lib/logic.js'

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
