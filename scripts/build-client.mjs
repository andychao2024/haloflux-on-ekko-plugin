#!/usr/bin/env node
/**
 * 客户端必须是单文件：Studio 以 blob/inline module 加载 client.mjs，
 * 相对 import 会报 “base scheme isn't hierarchical”。这里把舞台 HTML
 * 直接内联成常量，生成最终的 client.mjs。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src-client/client.src.mjs'), 'utf8')
// 会话历史解析器与单元测试共用同一份源码，这里去掉 export 后内联进单文件客户端
const toolHistory = readFileSync(join(root, 'src/tool-history.mjs'), 'utf8')
  .replace(/^export function parseToolMessages/m, 'function parseToolMessages')
const sessionState = readFileSync(join(root, 'src/session-state.mjs'), 'utf8')
  .replace(/^export function messagesWorking/m, 'function messagesWorking')
const motionSignals = readFileSync(join(root, 'src/motion-signals.mjs'), 'utf8')
  .replace(/^export function applyMotionSignals/m, 'function applyMotionSignals')
const page = readFileSync(join(root, 'page-html.mjs'), 'utf8')
const html = JSON.parse(page.slice(page.indexOf('export const PAGE_HTML = ') + 'export const PAGE_HTML = '.length, page.indexOf('\nexport const PAGE_BUILD')).trim())

const out = '/* 由 scripts/build-client.mjs 生成，勿手改。源码：src-client/client.src.mjs */\n' +
  'const PAGE_HTML = ' + JSON.stringify(html) + '\n' + src + '\n' + toolHistory + '\n' + sessionState + '\n' + motionSignals
writeFileSync(join(root, 'client.mjs'), out)
console.log('client.mjs', out.length, 'bytes')
