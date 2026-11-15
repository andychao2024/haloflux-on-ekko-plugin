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

const toMB = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576))

function firstGroup(text, re) {
  const m = text ? re.exec(text) : null
  return m ? String(m[1]).trim() : null
}

/* ---------------- 显卡 ---------------- */

// PCI vendor id → 厂商名。虚拟机/远程桌面的虚拟显卡单独归类，避免把它们当成真显卡。
const PCI_VENDORS = {
  '0x10de': 'NVIDIA',
  '0x1002': 'AMD',
  '0x8086': 'Intel',
  '0x13b5': 'ARM',
  '0x5143': 'Qualcomm',
  '0x14e4': 'Broadcom',
  '0x1010': 'ImgTec',
  '0x1af4': 'Virtual',   // virtio
  '0x15ad': 'Virtual',   // VMware
  '0x80ee': 'Virtual',   // VirtualBox
  '0x1234': 'Virtual'    // QEMU 标准 VGA
}

// 驱动名 → 厂商名。没有 PCI vendor 文件时（平台设备/老内核）靠它兜底。
const DRIVER_VENDORS = {
  nvidia: 'NVIDIA',
  nouveau: 'NVIDIA',
  amdgpu: 'AMD',
  radeon: 'AMD',
  i915: 'Intel',
  xe: 'Intel',
  msm: 'Qualcomm',
  panfrost: 'ARM',
  panthor: 'ARM',
  lima: 'ARM',
  v3d: 'Broadcom',
  vc4: 'Broadcom'
}

// 没有负载/显存指标、只负责把画面显示出来的虚拟或固件帧缓冲。
// 选中它们只会让面板多一条永远为空的曲线，所以默认跳过。
const VIRTUAL_DRIVERS = new Set([
  'virtio_gpu', 'vmwgfx', 'qxl', 'vkms', 'bochs', 'cirrus', 'vboxvideo', 'virtualbox',
  'simpledrm', 'simple-framebuffer'
])

function readUevent(path) {
  const text = readText(path + '/uevent') || ''
  const out = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  return out
}

const hex = (value) => {
  const m = /^(?:0x)?([0-9a-f]{4})$/i.exec(String(value || '').trim())
  return m ? m[1].toLowerCase() : null
}

let pciIdsText
/** pci.ids 里查型号名；Intel 等驱动不导出 product_name 时用。找不到就返回 null。 */
function pciIdsName(vendor, device) {
  const v = hex(vendor)
  const d = hex(device)
  if (!v || !d) return null
  if (pciIdsText === undefined) {
    pciIdsText = ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids', '/usr/share/pci.ids']
      .map((path) => readText(path))
      .find((text) => text != null) || ''
  }
  if (!pciIdsText) return null
  const at = pciIdsText.indexOf('\n' + v + '  ')
  if (at < 0) return null
  const lines = pciIdsText.slice(at + 1).split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // 下一个顶格厂商行表示本厂商段落结束
    if (/^[0-9a-f]{4}  /.test(line)) break
    const m = /^\t([0-9a-f]{4})  (.+)$/.exec(line)
    if (m && m[1] === d) return m[2].trim()
  }
  return null
}

/** NVIDIA 的型号写在 /proc/driver/nvidia/gpus/<pci>/information 里，不需要 nvidia-smi。 */
function nvidiaProcName() {
  for (const id of listDir('/proc/driver/nvidia/gpus')) {
    const name = firstGroup(readText('/proc/driver/nvidia/gpus/' + id + '/information'), /Model:\s*(.+)/)
    if (name) return name
  }
  return null
}

/** ARM Mali（RK3588 等板子）的 kbase sysfs；型号在读 gpuinfo。 */
function maliInfo() {
  const paths = ['/sys/class/misc/mali0/device']
  for (const name of listDir('/sys/devices/platform')) {
    if (/gpu|mali/i.test(name)) paths.push('/sys/devices/platform/' + name)
  }
  for (const path of paths) {
    if (readText(path + '/utilisation') == null) continue
    const info = readText(path + '/gpuinfo') || ''
    const name = firstGroup(info, /(Mali-[A-Za-z0-9]+)/) || 'Mali GPU'
    return { name, vendor: 'ARM', driver: 'mali', source: 'mali-sysfs', path }
  }
  return null
}

function gpuFromDrmCard(card) {
  const base = '/sys/class/drm/' + card + '/device'
  const uevent = readUevent(base)
  const pciId = String(uevent.PCI_ID || '').split(':')
  const vendor = hex(readText(base + '/vendor')) || hex(pciId[0])
  const device = hex(readText(base + '/device')) || hex(pciId[1])
  let driver = uevent.DRIVER || ''
  if (!driver) {
    try { driver = basename(readlinkSync(base + '/driver')) } catch (_) { /* ignore */ }
  }
  if (!driver && !vendor) return null
  if (VIRTUAL_DRIVERS.has(driver)) return null
  const brand = PCI_VENDORS[vendor ? '0x' + vendor : ''] || DRIVER_VENDORS[driver] || null
  if (brand === 'Virtual') return null

  let name = null
  if (brand === 'NVIDIA') name = nvidiaProcName()
  if (!name) name = firstGroup(readText(base + '/product_name'), /^(.+)$/)
  if (!name) name = pciIdsName(vendor, device)
  if (!name) name = (brand || 'Unknown') + ' GPU' + (driver ? ' · ' + driver : '')

  return {
    name,
    vendor: brand || 'GPU',
    driver,
    source: 'drm-sysfs',
    path: base,
    // 集显通常没有显存/负载指标，排序时放到独显后面
    rank: brand === 'NVIDIA' || brand === 'AMD' ? 0 : (brand === 'Intel' ? 2 : 1)
  }
}

/**
 * 探测本机显卡。依次尝试：
 *   1. ARM Mali kbase sysfs（RK3588 / RK3568 这类板子）
 *   2. /sys/class/drm 下所有 cardN（NVIDIA / AMD / Intel / 高通 / 其他平台显卡）
 *   3. /proc/driver/nvidia（没有 drm 节点的容器里也能认出 NVIDIA）
 * 只做识别，不加载任何额外依赖；识别不到返回 null。
 */
export function detectGpu() {
  const mali = maliInfo()
  if (mali) return mali

  const cards = listDir('/sys/class/drm')
    .filter((name) => /^card\d+$/.test(name))
    .map(gpuFromDrmCard)
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)

  if (cards.length) {
    const { rank, ...gpu } = cards[0]
    return gpu
  }

  const nvidia = nvidiaProcName()
  if (nvidia) {
    return { name: nvidia, vendor: 'NVIDIA', driver: 'nvidia', source: 'nvidia-proc', path: null }
  }
  return null
}

/* ---------------- CPU / 内存 ---------------- */

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

/** Linux 的 MemAvailable 才反映真实可用内存；os.freemem() 会把缓存算成已用。 */
function linuxMemory() {
  const text = readText('/proc/meminfo')
  if (!text) return null
  const kb = (key) => {
    const m = new RegExp('^' + key + ':\\s+(\\d+)', 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  if (!total) return null
  return { total, available: kb('MemAvailable') }
}

/* ---------------- 磁盘 ---------------- */

// 整盘名：nvme0n1 / nvme0c0n1 / sda / vda / hda / xvda / mmcblk0 / dasda。
// 分区（sda1、nvme0n1p2、mmcblk0p1、dasda1）和虚拟设备（loop0、dm-0、zram0、md0）
// 都不匹配，避免把分区当成整盘算 IO。
const DISK_NAME_RE = /^(nvme\d+(?:c\d+)?n\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|dasd[a-z]+|mmcblk\d+)$/
// 分区名 → 整盘名：nvme0n1p2 → nvme0n1，mmcblk0p1 → mmcblk0，sda2 → sda。
const PARTITION_RE = /^(nvme\d+(?:c\d+)?n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+?|dasd[a-z]+?)p?\d+$/

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

/** 虚拟设备沿 sysfs slaves 下扎到物理整盘；层数封顶，避免环。 */
function physicalDiskName(name) {
  let cur = String(name || '')
  for (let depth = 0; depth < 4 && /^(dm-|md)/.test(cur); depth++) {
    const slave = sysfsSlave(cur)
    if (!slave) break
    cur = slave
  }
  return wholeDiskName(cur)
}

/** /proc/self/mountinfo 里挂着 / 的 major:minor，再从 /sys/dev/block 解析设备名。 */
function rootFromMountinfo() {
  const text = readText('/proc/self/mountinfo')
  if (!text) return null
  for (const line of text.split('\n')) {
    const f = line.trim().split(' ')
    // id parentid major:minor root mountpoint ...
    if (f.length < 5 || f[4] !== '/') continue
    try { return basename(readlinkSync('/sys/dev/block/' + f[2])) } catch (_) { return null }
  }
  return null
}

/** 老内核或受限容器没有 mountinfo 时，退回 /proc/mounts 的设备路径。 */
function rootFromMounts() {
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
  return source.slice(5)
}

/** / 所在的物理整盘；overlay/tmpfs/zfs 这类没有对应块设备时返回 null。 */
function rootDiskName() {
  const name = rootFromMountinfo() || rootFromMounts()
  return name ? physicalDiskName(name) : null
}

/** 认不出 / 的设备时的候选：第一块不可移动、容量非零的整盘。 */
function firstPhysicalDisk() {
  for (const name of listDir('/sys/block').sort()) {
    if (!DISK_NAME_RE.test(name)) continue
    if (String(readText('/sys/block/' + name + '/removable') || '').trim() === '1') continue
    const size = readNumber('/sys/block/' + name + '/size')
    if (size === 0) continue
    return name
  }
  return null
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
  // 跳过回环、容器网桥和隧道：这些接口会把同一份流量重复计算。
  const skip = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|cni|flannel|kube|lxc|lxd|incus|podman|cali|weave|dummy|sit)/
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    if (skip.test(name)) continue
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

/* ---------------- 采样 ---------------- */

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

    const mem = process.platform === 'linux' ? linuxMemory() : null
    const totalMem = (mem && mem.total) || os.totalmem()
    const freeMem = mem && mem.available != null ? mem.available : os.freemem()
    state.ram = round(((totalMem - freeMem) / totalMem) * 100)
    state.ramDetail = {
      usedGB: round((totalMem - freeMem) / 1073741824, 1),
      totalGB: round(totalMem / 1073741824, 1)
    }
    state.uptimeSec = Math.round(os.uptime())

    if (process.platform === 'linux') {
      const preferred = rootDiskName() || firstPhysicalDisk()
      const rec = parseDiskstats(readText('/proc/diskstats'), preferred)
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
      } else if (gpuDevice.vendor === 'NVIDIA') {
        state.gpu = {
          name: (nvidiaStats && nvidiaStats.name) || gpuDevice.name,
          utilization: nvidiaStats ? nvidiaStats.utilization : null,
          memoryUsedMB: nvidiaStats ? nvidiaStats.memoryUsedMB : null,
          memoryTotalMB: nvidiaStats ? nvidiaStats.memoryTotalMB : null,
          source: nvidiaStats ? 'nvidia-smi' : gpuDevice.source
        }
        pollNvidia(gpuDevice)
      } else {
        // AMD(amdgpu) / Intel / 其他厂商：有标准 sysfs 指标就读，没有就显示 “—”
        const base = gpuDevice.path || ''
        const util = readNumber(base + '/gpu_busy_percent')
        const used = readNumber(base + '/mem_info_vram_used')
        const total = readNumber(base + '/mem_info_vram_total')
        state.gpu = {
          name: gpuDevice.name,
          utilization: util == null ? null : clamp(util, 0, 100),
          memoryUsedMB: toMB(used),
          memoryTotalMB: toMB(total),
          source: gpuDevice.source
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
