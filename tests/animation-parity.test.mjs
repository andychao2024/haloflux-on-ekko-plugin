import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../page-src/ai-link.js', import.meta.url), 'utf8')

test('动效启停保持 Docker 版的即时冻结方式', () => {
  assert.doesNotMatch(js, /camBlend/)
  assert.match(js, /if \(!CONFIG\.camWhenIdle && !CAM\.spinActive\) return;/)
  assert.match(js, /if \(CONFIG\.autoSpin && CAM\.spinActive\) \{ origUpdate\(dt \* CAM\.rate\); return; \}/)
  assert.doesNotMatch(js, /CAM\.spinActive \|\| CAM\.rate/)
})
