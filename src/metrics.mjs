import os from 'node:os'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round = (n, d = 1) => {
  const p = 10 ** d
  return Math.round(n * p) / p
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch (_) { return null }
}

function readNumber(path) {
  const text = readText(path)
  if (text == null) return null
  const n = Number(String(text).trim())
  return Number.isFinite(n) ? n : null
}

function listDir(path) {
  try { return readdirSync(path) } catch (_) { return [] }
}

const GPU_VENDORS = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel', '0x13b5': 'ARM' }
const toMB = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576))

function firstGroup(text, re) {
  const m = text ? re.exec(text) : null
  return m ? String(m[1]).trim() : null
}

/** NVIDIA 的型号写在 /proc/driver/nvidia/gpus/<pci>/information 里，不需要 nvidia-smi。 */
function nvidiaProcName() {
  for (const id of listDir('/proc/driver/nvidia/gpus')) {
    const name = firstGroup(readText('/proc/driver/nvidia/gpus/' + id + '/information'), /Model:\s*(.+)/)
    if (name) return name
  }
  return null
}

/**
 * 探测本机显卡：先看 ARM 的 Mali sysfs（RK3588 这类板子），
 * 再看 /sys/class/drm 下的 PCI/平台显卡（NVIDIA / AMD / Intel）。
 * 只做识别，不加载任何额外依赖；识别不到返回 null。
 */
export function detectGpu() {
  if (readText('/sys/class/misc/mali0/device/utilisation') != null) {
    return { name: 'Mali GPU', vendor: 'ARM', driver: 'mali', source: 'mali-sysfs', path: '/sys/class/misc/mali0/device' }
  }
  for (const card of listDir('/sys/class/drm')) {
    if (!/^card\d+$/.test(card)) continue
    const base = '/sys/class/drm/' + card + '/device'
    const vendor = String(readText(base + '/vendor') || '').trim()
    if (!vendor) continue
    let driver = ''
    try { driver = basename(readlinkSync(base + '/driver')) } catch (_) { /* ignore */ }
    const brand = GPU_VENDORS[vendor] || vendor
    let name = null
    if (brand === 'NVIDIA') name = nvidiaProcName()
    else if (brand === 'AMD') name = firstGroup(readText(base + '/product_name'), /^(.+)$/)
    if (!name) name = brand + ' GPU' + (driver ? ' · ' + driver : '')
    return { name, vendor: brand, driver, source: 'drm-sysfs', path: base }
  }
  return null
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

// 整盘名：nvme0n1 / sda / vda / hda / xvda / mmcblk0。
// 分区（sda1、nvme0n1p2、mmcblk0p1）和虚拟设备（loop0、dm-0、zram0、md0）
// 都不匹配，避免把分区当成整盘算 IO。
const DISK_NAME_RE = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|mmcblk\d+)$/
// 分区名 → 整盘名：nvme0n1p2 → nvme0n1，mmcblk0p1 → mmcblk0，sda2 → sda。
const PARTITION_RE = /^(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+?)p?\d+$/

/** 把 /dev/xxx、分区名、dm/md 名统一成整盘名；认不出来就返回 null。 */
export function wholeDiskName(name) {
  const base = String(name || '').replace(/^\/dev\//, '')
  if (!base) return null
  if (DISK_NAME_RE.test(base)) return base
  const m = PARTITION_RE.exec(base)
  return m ? m[1] : null
}

/** dm-0 / md0 这类虚拟设备的第一个底层设备名（读 sysfs slaves）。 */
function sysfsSlave(name) {
  try {
    return readdirSync('/sys/class/block/' + name + '/slaves')[0] || null
  } catch (_) {
    return null
  }
}

/** /proc/mounts 里挂着 / 的设备，解析到它所在的物理整盘。 */
function rootDiskName() {
  const mounts = readText('/proc/mounts')
  if (!mounts) return null
  let source = null
  for (const line of mounts.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 2 && f[1] === '/') { source = f[0]; break }
  }
  if (!source) return null
  // /dev/mapper/vg-root 是符号链接，先换成 /dev/dm-N
  if (source.startsWith('/dev/mapper/')) {
    try { source = readlinkSync(source) } catch (_) { return null }
  }
  if (!source.startsWith('/dev/')) return null   // overlay / tmpfs / zfs 等
  let name = source.slice(5)
  // LVM(dm-N) / RAID(mdN) 再往下扎到物理盘；层数封顶，避免环
  for (let depth = 0; depth < 3 && /^(dm-|md)/.test(name); depth++) {
    const slave = sysfsSlave(name)
    if (!slave) break
    name = slave
  }
  return wholeDiskName(name)
}

export function parseDiskstats(text, preferred = null) {
  if (!text) return null
  // 优先取系统盘（/ 所在的那块盘）的统计：第一块盘可能是外接 U 盘或数据盘，
  // 按枚举顺序取会张冠李戴；找不到系统盘才退回第一块整盘。
  let first = null
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 14) continue
    const name = f[2]
    if (!DISK_NAME_RE.test(name)) continue
    const rec = {
      name,
      reads: Number(f[3]) || 0,
      readSectors: Number(f[5]) || 0,
      writes: Number(f[7]) || 0,
      writeSectors: Number(f[9]) || 0,
      ioMs: Number(f[12]) || 0
    }
    if (preferred && name === preferred) return rec
    first = first || rec
  }
  return first
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

/** 每核负载：基于两次采样的增量，没有上一次采样时先返回 0。 */
export function perCoreUsage(curCores, prevCores) {
  return curCores.map((c, i) => {
    const prev = prevCores && prevCores[i]
    if (!prev) return 0
    const dt = c.total - prev.total
    const di = c.idle - prev.idle
    return dt > 0 ? round(clamp((1 - di / dt) * 100, 0, 100)) : 0
  })
}

export function createMetrics() {
  const gpuDevice = detectGpu()
  const state = {
    cpu: null,
    cpuCores: [],
    cpuName: (os.cpus()[0] && os.cpus()[0].model) || 'CPU',
    ram: null,
    ramDetail: null,
    disk: null,
    net: null,
    // 先只带型号，利用率/显存由第一次采样填入
    gpu: gpuDevice
      ? { name: gpuDevice.name, utilization: null, memoryUsedMB: null, memoryTotalMB: null, source: gpuDevice.source }
      : null,
    uptimeSec: Math.round(os.uptime())
  }
  let prevCpu = null
  let prevCores = null
  let prevDisk = null
  let prevNet = null
  let nvidiaBusy = false
  let lastNvidiaAt = 0
  // nvidia-smi 的最近一次结果。必须缓存：同步采样每轮都会重写 state.gpu，
  // 不回填的话上一轮的 smi 数值会被立刻覆盖成 null。
  let nvidiaStats = null

  // NVIDIA 的利用率只能问 nvidia-smi；异步跑，避免阻塞采样循环。
  function pollNvidia(device) {
    if (nvidiaBusy || Date.now() - lastNvidiaAt < 5000) return
    nvidiaBusy = true
    lastNvidiaAt = Date.now()
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000 },
      (error, stdout) => {
        nvidiaBusy = false
        const line = String(stdout || '').trim().split('\n')[0]
        if (error || !line) return
        const [name, util, used, total] = line.split(',').map((s) => s.trim())
        const u = Number(util)
        nvidiaStats = {
          name: name || device.name,
          utilization: Number.isFinite(u) ? clamp(u, 0, 100) : null,
          memoryUsedMB: Number.isFinite(Number(used)) ? Number(used) : null,
          memoryTotalMB: Number.isFinite(Number(total)) ? Number(total) : null
        }
      }
    )
  }

  function sample() {
    const now = Date.now()

    const cur = cpuTimes()
    if (prevCpu) {
      const dt = cur.total - prevCpu.total
      const di = cur.idle - prevCpu.idle
      if (dt > 0) state.cpu = round(clamp((1 - di / dt) * 100, 0, 100))
    }
    prevCpu = cur
    // 每核必须用两次采样的增量，不能拿开机以来的累计值：
    // 累计值会收敛成一条几乎不动的直线，面板上的黄色柱看起来就像卡住了。
    const cores = os.cpus()
    const curCores = cores.map((c) => {
      const t = c.times
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
    })
    state.cpuCores = perCoreUsage(curCores, prevCores)
    prevCores = curCores

    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    state.ram = round(((totalMem - freeMem) / totalMem) * 100)
    state.ramDetail = {
      usedGB: round((totalMem - freeMem) / 1073741824, 1),
      totalGB: round(totalMem / 1073741824, 1)
    }
    state.uptimeSec = Math.round(os.uptime())

    if (process.platform === 'linux') {
      const rec = parseDiskstats(readText('/proc/diskstats'), rootDiskName())
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

      if (!gpuDevice) {
        state.gpu = null
      } else if (gpuDevice.source === 'mali-sysfs') {
        const n = readNumber(gpuDevice.path + '/utilisation')
        state.gpu = {
          name: gpuDevice.name,
          utilization: n == null ? null : clamp(n, 0, 100),
          memoryUsedMB: null,
          memoryTotalMB: null,
          source: 'mali-sysfs'
        }
      } else {
        // AMD(amdgpu) / Intel(i915) 的利用率与显存在 sysfs 里；NVIDIA 走 nvidia-smi
        const util = gpuDevice.vendor === 'AMD' ? readNumber(gpuDevice.path + '/gpu_busy_percent') : null
        const used = gpuDevice.vendor === 'AMD' ? readNumber(gpuDevice.path + '/mem_info_vram_used') : null
        const total = gpuDevice.vendor === 'AMD' ? readNumber(gpuDevice.path + '/mem_info_vram_total') : null
        if (gpuDevice.vendor === 'NVIDIA') {
          state.gpu = {
            name: (nvidiaStats && nvidiaStats.name) || gpuDevice.name,
            utilization: nvidiaStats ? nvidiaStats.utilization : null,
            memoryUsedMB: nvidiaStats ? nvidiaStats.memoryUsedMB : null,
            memoryTotalMB: nvidiaStats ? nvidiaStats.memoryTotalMB : null,
            source: nvidiaStats ? 'nvidia-smi' : gpuDevice.source
          }
          pollNvidia(gpuDevice)
        } else {
          state.gpu = {
            name: gpuDevice.name,
            utilization: util == null ? null : clamp(util, 0, 100),
            memoryUsedMB: toMB(used),
            memoryTotalMB: toMB(total),
            source: gpuDevice.source
          }
        }
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
