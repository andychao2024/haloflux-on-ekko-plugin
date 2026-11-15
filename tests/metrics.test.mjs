import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiskstats, perCoreUsage, wholeDiskName } from '../src/metrics.mjs'

test('per-core usage uses sample deltas instead of cumulative boot totals', () => {
  const prev = [
    { idle: 100, total: 200 },
    { idle: 50, total: 100 }
  ]
  const cur = [
    { idle: 150, total: 300 },   // 100 ticks passed, 50 idle -> 50%
    { idle: 50, total: 200 }     // 100 ticks passed, 0 idle -> 100%
  ]
  assert.deepEqual(perCoreUsage(cur, prev), [50, 100])
})

test('per-core usage is zero before the first comparison and clamps bad deltas', () => {
  const cur = [{ idle: 1, total: 2 }]
  assert.deepEqual(perCoreUsage(cur, null), [0])
  assert.deepEqual(perCoreUsage([{ idle: 0, total: 0 }], [{ idle: 5, total: 5 }]), [0])
})

test('partition names resolve to their whole disk', () => {
  assert.equal(wholeDiskName('sda2'), 'sda')
  assert.equal(wholeDiskName('nvme0n1p3'), 'nvme0n1')
  assert.equal(wholeDiskName('mmcblk0p1'), 'mmcblk0')
  assert.equal(wholeDiskName('/dev/vda1'), 'vda')
  assert.equal(wholeDiskName('nvme0n1'), 'nvme0n1')
  // 多控制器 NVMe、S390 DASD、eMMC 的整盘/分区也要认出来
  assert.equal(wholeDiskName('nvme0c0n1p2'), 'nvme0c0n1')
  assert.equal(wholeDiskName('dasda1'), 'dasda')
  assert.equal(wholeDiskName('mmcblk0'), 'mmcblk0')
  assert.equal(wholeDiskName('dm-0'), null)
  assert.equal(wholeDiskName('overlay'), null)
})

// /proc/diskstats 的列：major minor name reads .. sectors_read .. writes .. sectors_written .. io_ms
const DISKSTATS = [
  '   8       0 sda 100 0 800 10 200 0 1600 20 0 30 30 0',
  '   8       1 sda1 50 0 400 5 100 0 800 10 0 15 15 0',
  ' 259       0 nvme0n1 7 0 56 1 8 0 64 1 0 2 2 0'
].join('\n')

test('disk stats prefer the root disk instead of the first entry', () => {
  assert.equal(parseDiskstats(DISKSTATS, 'nvme0n1').name, 'nvme0n1')
  assert.equal(parseDiskstats(DISKSTATS, 'sda').name, 'sda')
})

test('disk stats fall back to the first whole disk and skip partitions', () => {
  const rec = parseDiskstats(DISKSTATS)
  assert.equal(rec.name, 'sda')
  // ioMs 取第 13 列（index 12），不是分区行
  assert.equal(rec.ioMs, 30)
  assert.equal(parseDiskstats(DISKSTATS, 'mmcblk0').name, 'sda')
  assert.equal(parseDiskstats('', 'sda'), null)
})
