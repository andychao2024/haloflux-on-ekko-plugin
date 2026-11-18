import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('../page-html.mjs', import.meta.url), 'utf8')
const client = readFileSync(new URL('../client.mjs', import.meta.url), 'utf8')

test('plugin page reports the embedded page build to checkBuild', () => {
  const inline = (page.match(/var BUILD = '([^']+)'/) || [])[1]
  const exported = (page.match(/export const PAGE_BUILD = "([^"]+)"/) || [])[1]
  assert.ok(inline)
  assert.equal(exported, inline)
  assert.match(client, /const PAGE_BUILD = \(PAGE_HTML\.match/)
  assert.match(client, /if \(data\.ai && PAGE_BUILD\) data\.ai\.build = PAGE_BUILD/)
  assert.match(client, /function firstCheck\(meta\)/)
  assert.match(client, /if \(!messagesWorking\(messages\)\) return/)
  assert.match(client, /first: true/)
  assert.match(client, /recentWorkIds\.has\(id\) \|\| rec\.first/)
})
