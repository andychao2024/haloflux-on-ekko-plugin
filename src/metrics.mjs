import os from 'node:os'
import { readFileSync } from 'node:fs'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round = (n, d = 1) => {
  const p = 10 ** d
  return Math.round(n * p) / p
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch (_) { return null }
}

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

function parseDiskstats(text) {
  if (!text) return null
  let best = null
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 14) continue
    const name = f[2]
    if (!/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/.test(name)) continue
    const rec = {
      name,
      reads: Number(f[3]) || 0,
      readSectors: Number(f[5]) || 0,
      writes: Number(f[7]) || 0,
      writeSectors: Number(f[9]) || 0,
      ioMs: Number(f[12]) || 0
    }
    if (/^nvme/.test(name)) return rec
    best = best || rec
  }
  return best
}

function parseNetdev(text) {
  if (!text) return null
  let rx = 0
  let tx = 0
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    if (name === 'lo' || /^(docker|br-|veth|virbr)/.test(name)) continue
    const cols = m[2].trim().split(/\s+/).map(Number)
    rx += cols[0] || 0
    tx += cols[8] || 0
  }
  return { rx, tx }
}

export function createMetrics() {
  const state = {
    cpu: null,
    cpuCores: [],
    cpuName: (os.cpus()[0] && os.cpus()[0].model) || 'CPU',
    ram: null,
    ramDetail: null,
    disk: null,
    net: null,
    uptimeSec: Math.round(os.uptime())
  }
  let prevCpu = null
  let prevDisk = null
  let prevNet = null

  function sample() {
    const now = Date.now()

    const cur = cpuTimes()
    if (prevCpu) {
      const dt = cur.total - prevCpu.total
      const di = cur.idle - prevCpu.idle
      if (dt > 0) state.cpu = round(clamp((1 - di / dt) * 100, 0, 100))
    }
    prevCpu = cur
    const cores = os.cpus()
    state.cpuCores = cores.map((c) => {
      const t = c.times
      const total = t.user + t.nice + t.sys + t.idle + t.irq
      return total ? Math.round(((total - t.idle) / total) * 100) : 0
    })

    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    state.ram = round(((totalMem - freeMem) / totalMem) * 100)
    state.ramDetail = {
      usedGB: round((totalMem - freeMem) / 1073741824, 1),
      totalGB: round(totalMem / 1073741824, 1)
    }
    state.uptimeSec = Math.round(os.uptime())

    if (process.platform === 'linux') {
      const rec = parseDiskstats(readText('/proc/diskstats'))
      if (rec) {
        if (prevDisk && prevDisk.name === rec.name) {
          const dt = (now - prevDisk.t) / 1000
          if (dt > 0.2) {
            const busy = Math.max(0, rec.ioMs - prevDisk.ioMs)
            state.disk = {
              device: rec.name,
              utilization: round(clamp(busy / (dt * 1000) * 100, 0, 100)),
              readMBps: round(Math.max(0, (rec.readSectors - prevDisk.readSectors) * 512 / dt / 1048576), 2),
              writeMBps: round(Math.max(0, (rec.writeSectors - prevDisk.writeSectors) * 512 / dt / 1048576), 2),
              iops: Math.round(Math.max(0, ((rec.reads + rec.writes) - (prevDisk.reads + prevDisk.writes)) / dt))
            }
          }
        }
        prevDisk = { ...rec, t: now }
      } else {
        state.disk = null
      }

      const net = parseNetdev(readText('/proc/net/dev'))
      if (net) {
        if (prevNet) {
          const dt = (now - prevNet.t) / 1000
          if (dt > 0.2) {
            state.net = {
              rxPerSec: Math.max(0, (net.rx - prevNet.rx) / dt),
              txPerSec: Math.max(0, (net.tx - prevNet.tx) / dt)
            }
          }
        }
        prevNet = { ...net, t: now }
      }
    }
  }

  return { state, sample }
}
