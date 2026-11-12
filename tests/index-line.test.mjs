import assert from 'node:assert/strict'
import test from 'node:test'
import { domainSizes, indexLine } from '../lib/logic.js'

const NAMES = [
  'memory_merge', 'memory_check', 'memory_dispose', 'recall',
  'fs_read', 'fs_write', 'fs_grep',
  'bash',
]
const DOMAINS = {
  memory: ['memory_*', 'recall'],
  fs: ['fs_*'],
  shell: ['bash'],
}

test('domainSizes：按工具数降序，同数按 id 升序', () => {
  const sizes = domainSizes(NAMES, DOMAINS)
  assert.deepEqual(sizes.map(s => [s.id, s.tools]), [['memory', 4], ['fs', 3], ['shell', 1]])
})

test('indexLine：一行里带域数、工具总数、每域工具数', () => {
  const line = indexLine(NAMES, DOMAINS)
  assert.match(line, /3 域/)
  assert.match(line, /8 工具/)
  assert.match(line, /memory 4/)
  assert.match(line, /fs 3/)
  assert.match(line, /shell 1/)
  // 关键教义必须在行里：收窄 ≠ 不存在
  assert.match(line, /收窄≠不存在/)
  assert.doesNotMatch(line, /\n/, '必须是一行')
})

test('indexLine：域数超过 max 时折成「还有 N 域」', () => {
  const line = indexLine(NAMES, DOMAINS, 2)
  assert.match(line, /memory 4/)
  assert.match(line, /fs 3/)
  assert.doesNotMatch(line, /shell 1/)
  assert.match(line, /还有 1 域/)
})

test('indexLine：没有域 / 域全空 ⇒ 空串（调用方据此跳过注入）', () => {
  assert.equal(indexLine(NAMES, {}), '')
  assert.equal(indexLine([], DOMAINS), '')
})

test('indexLine：实测长度可控（12 域满配 < 700 字符）', () => {
  const names = []
  const domains = {}
  for (let d = 0; d < 12; d += 1) {
    domains[`domain-${d}`] = [`d${d}_*`]
    for (let t = 0; t < 40; t += 1) names.push(`d${d}_tool_${t}`)
  }
  const line = indexLine(names, domains, 12)
  assert.ok(line.length < 700, `实际 ${line.length} 字符`)
})
