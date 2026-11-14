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
const page = readFileSync(join(root, 'page-html.mjs'), 'utf8')
const html = JSON.parse(page.slice(page.indexOf('export const PAGE_HTML = ') + 'export const PAGE_HTML = '.length, page.indexOf('\nexport const PAGE_BUILD')).trim())

const out = '/* 由 scripts/build-client.mjs 生成，勿手改。源码：src-client/client.src.mjs */\n' +
  'const PAGE_HTML = ' + JSON.stringify(html) + '\n' + src
writeFileSync(join(root, 'client.mjs'), out)
console.log('client.mjs', out.length, 'bytes')
