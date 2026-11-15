import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertContracts, validateModel } from '../sdk/harness/contracts.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8')))

test('settings model requires the ten declared fields', () => {
  const value = {
    anim: true, compat: false, gpu: true, showIcon: true,
    wallpaper: false, wallpaperPort: 8790, wallpaperToken: 'test-token',
    toolRows: 8, agentRows: 8, title: 'HALOFLUX ON Ekko'
  }
  assert.deepEqual(validateModel(contract, 'settings', value), value)
  assert.throws(() => validateModel(contract, 'settings', { anim: true }), /missing/)
  assert.throws(() => validateModel(contract, 'settings', { ...value, extra: 1 }), /unknown property/)
  assert.throws(() => validateModel(contract, 'settings', { ...value, title: 1 }), /expected string/)
  assert.throws(() => validateModel(contract, 'settings', { ...value, toolRows: 2 }), /outside range/)
  assert.throws(() => validateModel(contract, 'settings', { ...value, agentRows: 13 }), /outside range/)
})

test('wallpaper status model reports viewers and running state', () => {
  const value = { viewers: 1, running: true }
  assert.deepEqual(validateModel(contract, 'wallpaperStatus', value), value)
  assert.throws(() => validateModel(contract, 'wallpaperStatus', { viewers: -1, running: true }), /outside range/)
  assert.throws(() => validateModel(contract, 'wallpaperStatus', { viewers: 0 }), /missing/)
  assert.equal(contract.rpc['wallpaper-status'].output, 'wallpaperStatus')
})
