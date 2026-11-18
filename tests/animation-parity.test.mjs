import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../page-src/ai-link.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../page-src/index.html', import.meta.url), 'utf8')

test('动效启停保留 Docker 版的钩子结构', () => {
  assert.doesNotMatch(js, /camBlend/)
  assert.match(js, /if \(!CONFIG\.camWhenIdle && !CAM\.spinActive\) return;/)
  assert.match(js, /if \(CONFIG\.autoSpin && CAM\.spinActive\) \{ origUpdate\(dt \* CAM\.rate\); return; \}/)
  assert.doesNotMatch(js, /CAM\.spinActive \|\| CAM\.rate/)
})

test('空闲时按设置间隔轻转圆环，且不改动忙碌时的自转', () => {
  assert.match(js, /idleSpinSec: 3/)
  assert.match(js, /function updateIdleSpin\(now\)/)
  assert.match(js, /window\.idleRingNudge/)
  assert.match(js, /if \(CONFIG\.autoSpin && CAM\.spinActive\)/)
  assert.match(html, /function idleRingNudge\(\)/)
  assert.match(js, /classList\.toggle\('hl-idle-only'/)
  assert.match(html, /html\.hl-idle-only/)
  assert.match(html, /aix-pane\.ap \.ag::after/)
  assert.match(html, /aix-pane\.ap \.ag\.on \.cell\.on/)
  assert.doesNotMatch(html, /stageBlend|motionDt|hlIdleOnlyRing/)
  assert.match(html, /webRot \+= dt \* \(0\.03 \+ env \* 0\.12\)/)
  assert.match(html, /drawBokeh\(dt\)/)
})
