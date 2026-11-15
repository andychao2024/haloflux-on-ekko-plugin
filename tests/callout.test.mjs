import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../page-src/index.html', import.meta.url), 'utf8')
const js = readFileSync(new URL('../page-src/ai-link.js', import.meta.url), 'utf8')

test('光环标注框由工具调用触发随机公式，不再自动轮换', () => {
  assert.match(html, /id="chkK">MASS CONSERVATION</)
  assert.match(html, /Σ ρ dV = const/)
  assert.match(html, /const CHECKS =/)
  assert.doesNotMatch(html, /chkI/)
  assert.match(js, /function updateCheckCallout/)
  assert.match(js, /Math\.random\(\) \* CHECKS\.length/)
  assert.match(js, /__hlSetCheckVisible/)
  assert.doesNotMatch(js, /chkBox\.style\.display = 'none'/)
})
