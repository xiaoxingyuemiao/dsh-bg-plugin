// dsh-bg-plugin —— Host 半边（静态安装版）
// 运行环境：DSH 主进程（完整 Node ESM 模块，无沙箱限制）。
// 职责：通过 webServer 提供 JSON API 与媒体字节路由：
//   GET  /dsh-bg/api/state —— 读取持久化的 UI 状态
//   POST /dsh-bg/api/state —— 合并并保存 UI 状态
//   POST /dsh-bg/api/list  —— { dir } -> { ok, files:[{name,size,kind}] }（kind: image|video）
//   POST /dsh-bg/api/set   —— { dir, name } -> { ok, url:'/dsh-bg/api/media?v=N', kind }
//   GET  /dsh-bg/api/media —— 当前背景媒体字节（图片或视频；?v=N 用于刷新缓存）
// 浏览器端（lib/client.js）用 fetch 直连这些路由，无需动态包 RPC。
// 持久化：状态 JSON 保存在 $DSH_HOME/.dsh-bg-state.json（whale-widget 同款模式）。
import fs from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  applyOrbPatch,
  backupRootOf,
  isOrbPatched,
  orbFilePaths,
  orbPatchVersion,
  PATCH_VERSION,
  resolveOrbDir,
  revertOrbPatch,
} from './orb-patch.js'

const name = 'dsh-bg-plugin'
const inject = ['fs', 'webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-bg-state.json')

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml',
}
// 浏览器可播放的常见视频容器（mkv 兼容性差，仍列出以便用户自行尝试）
const VIDEO_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', ogg: 'video/ogg', mov: 'video/quicktime',
  mkv: 'video/x-matroska',
}
const MAX_BYTES = 64 * 1024 * 1024 // 单个媒体文件上限（视频放宽到 64MB）
const MAX_BODY = 64 * 1024 // JSON 请求体上限

// 按扩展名判定媒体类型；不支持则返回 null
function mediaOf(entryName) {
  const ext = extOf(entryName)
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] }
  if (VIDEO_MIME[ext]) return { kind: 'video', mime: VIDEO_MIME[ext] }
  return null
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// 裁切区域校验/钳制：{fx,fy,fw,fh} 为图片宽高的分数（0..1），宽高至少 5%
function clampCrop(crop) {
  const box = crop !== null && typeof crop === 'object' ? crop : {}
  let fx = clampNum(box.fx, 0, 1, 0)
  let fy = clampNum(box.fy, 0, 1, 0)
  let fw = clampNum(box.fw, 0.05, 1, 1)
  let fh = clampNum(box.fh, 0.05, 1, 1)
  if (fx + fw > 1) fx = 1 - fw
  if (fy + fh > 1) fy = 1 - fh
  return { fx, fy, fw, fh }
}

function readStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch (err) {
    return null
  }
}

function writeStateFile(data) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    backupStateFile()
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    // 写入失败不阻塞功能，仅本次不持久化
  }
}

const PREV_STATE_FILE = path.join(DSH_HOME, '.dsh-bg-state.prev.json')
const STATE_BACKUP_PREFIX = '.dsh-bg-state.bak-'
const STATE_BACKUP_KEEP = 3
const STATE_SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000

/**
 * 落盘前留底：始终保留「上一份」内容，并按 ≥10 分钟间隔留最多 3 个时间戳快照。
 * 这样任何一次误覆盖（例如把空背景同步过去）都能用「恢复上一份」找回。
 */
function backupStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    fs.copyFileSync(STATE_FILE, PREV_STATE_FILE)
    const names = fs.readdirSync(DSH_HOME).filter((n) => n.startsWith(STATE_BACKUP_PREFIX)).sort()
    const newest = names.length === 0
      ? 0
      : fs.statSync(path.join(DSH_HOME, names[names.length - 1])).mtimeMs
    if (Date.now() - newest > STATE_SNAPSHOT_MIN_INTERVAL_MS) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(STATE_FILE, path.join(DSH_HOME, STATE_BACKUP_PREFIX + stamp + '.json'))
      const after = fs.readdirSync(DSH_HOME).filter((n) => n.startsWith(STATE_BACKUP_PREFIX)).sort()
      for (const old of after.slice(0, Math.max(0, after.length - STATE_BACKUP_KEEP))) {
        try { fs.unlinkSync(path.join(DSH_HOME, old)) } catch (err) { /* noop */ }
      }
    }
  } catch (err) {
    // 备份失败不阻塞写入
  }
}

function extOf(entryName) {
  const i = String(entryName).lastIndexOf('.')
  return i > 0 ? String(entryName).slice(i + 1).toLowerCase() : ''
}

function joinPath(dir, entryName) {
  return String(dir).replace(/[\\/]+$/, '') + '/' + String(entryName)
}

// —— 目录选择诊断日志（$DSH_HOME/.dsh-bg-picklog.json，最多保留 50 条）——
const PICK_LOG_FILE = path.join(DSH_HOME, '.dsh-bg-picklog.json')
function logPick(entry) {
  try {
    let list = []
    try {
      const raw = fs.readFileSync(PICK_LOG_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch (err) { /* 首次写入 */ }
    list.push({ at: new Date().toISOString(), ...entry })
    fs.writeFileSync(PICK_LOG_FILE, JSON.stringify(list.slice(-50), null, 2), 'utf8')
  } catch (err) { /* 日志失败不影响功能 */ }
}

/**
 * 调用操作系统的「选择文件夹」对话框（宿主是完整 Node，可直接弹）。
 * 桌面端 DSH 宿主没有注册目录选择能力，所以由本插件自己弹。
 * 返回：{ dir } 选中路径；{ cancelled: true } 用户取消；{ error } 调用失败/平台不支持。
 */
function pickFolderNative() {
  if (process.env.DSH_BG_DIALOG_DISABLED === '1') return Promise.resolve({ error: '对话框已被禁用（测试模式）' })
  const runDialog = (label, command, args) => new Promise((resolve) => {
    const startedAt = Date.now()
    // 3 分钟：超时后 PowerShell 会被杀掉，界面不会一直卡在"等待中"
    execFile(command, args, { windowsHide: true, timeout: 3 * 60 * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const ms = Date.now() - startedAt
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      if (err !== null) {
        logPick({ source: 'host', method: label, ms, exit: err.code === undefined ? null : err.code, killed: err.killed === true, error: String((err && err.message) || err).slice(0, 300), stdout: out.slice(0, 200), stderr: errOut.slice(0, 400) })
        if (out !== '') return resolve({ dir: out })
        return resolve({ cancelled: true, error: String((err && err.message) || err) })
      }
      logPick({ source: 'host', method: label, ms, exit: 0, stdout: out.slice(0, 200), stderr: errOut.slice(0, 400) })
      return resolve(out === '' ? { cancelled: true } : { dir: out })
    })
  })

  if (process.platform === 'win32') {
    // 首选：WinForms 文件夹对话框 + 「隐形置顶属主窗口」把它带到前台。
    // 实测（枚举窗口确认过）：ShowDialog(owner) 期间 GetForegroundWindow() 就是
    // [#32770] 浏览文件夹，即对话框确实显示在最前面；属主窗口 Opacity=0 不可见。
    // 关键点：属主窗口尺寸必须用 -ArgumentList 传（写 Size(1, 1) 会静默失败，
    // 变成 300×300 的空白窗体把对话框挡住——之前"一个啥也没有的窗口"就是这个）。
    const formsScript = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      'Add-Type -AssemblyName System.Drawing | Out-Null',
      "if ($env:DSH_BG_DIALOG_PROBE -eq '1') { [Console]::Out.Write('probe-ok'); exit 0 }",
      "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(System.IntPtr hWnd);'",
      "Add-Type -Namespace DshBg -Name Fg -MemberDefinition $sig | Out-Null",
      '$owner = New-Object System.Windows.Forms.Form',
      "$owner.FormBorderStyle = 'None'",
      '$owner.ShowInTaskbar = $false',
      '$owner.TopMost = $true',
      '$owner.Opacity = 0',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.ClientSize = New-Object -TypeName System.Drawing.Size -ArgumentList 1, 1',
      '$owner.Show()',
      '$owner.Activate()',
      '[void][DshBg.Fg]::SetForegroundWindow($owner.Handle)',
      '[void][DshBg.Fg]::BringWindowToTop($owner.Handle)',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$f.Description = "\u9009\u62e9\u80cc\u666f\u56fe\u7247/\u89c6\u9891\u6240\u5728\u7684\u6587\u4ef6\u5939"',
      '$f.ShowNewFolderButton = $false',
      '$result = $f.ShowDialog($owner)',
      '$owner.Close()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
    ].join('; ')
    // 备用：Shell COM 的经典浏览文件夹对话框（无属主窗口；本机实测它会直接返回空，
    // 所以只作为兜底）
    const shellScript = [
      "if ($env:DSH_BG_DIALOG_PROBE -eq '1') { [Console]::Out.Write('probe-ok'); exit 0 }",
      '$shell = New-Object -ComObject Shell.Application',
      "$folder = $shell.BrowseForFolder(0, '\u9009\u62e9\u80cc\u666f\u56fe\u7247/\u89c6\u9891\u6240\u5728\u7684\u6587\u4ef6\u5939', 0, 0)",
      'if ($folder -ne $null) { [Console]::Out.Write($folder.Self.Path) }',
    ].join('; ')
    const args = ['-NoProfile', '-STA', '-Command']
    // -STA：WinForms / Shell 对话框都要求在单线程单元里跑
    logPick({ source: 'host', method: 'start', note: 'pick-folder requested' })
    return runDialog('win-winforms', 'powershell.exe', [...args, formsScript]).then((first) => {
      // 用户主动取消（干净退出且无输出）→ 直接返回；脚本报错才换备用方案
      if (first.cancelled === true && first.error === undefined) return first
      if (typeof first.dir === 'string' && first.dir !== '') return first
      logPick({ source: 'host', method: 'fallback', note: 'winforms failed, trying shell com' })
      return runDialog('win-shell-com', 'powershell.exe', [...args, shellScript])
    })
  }
  if (process.platform === 'darwin') {
    return runDialog('macos-osascript', 'osascript', ['-e', 'POSIX path of (choose folder with prompt "\u9009\u62e9\u80cc\u666f\u56fe\u7247/\u89c6\u9891\u6240\u5728\u6587\u4ef6\u5939")'])
  }
  return runDialog('linux-zenity', 'zenity', ['--file-selection', '--directory', '--title=\u9009\u62e9\u80cc\u666f\u56fe\u7247/\u89c6\u9891\u6240\u5728\u6587\u4ef6\u5939'])
}

function errText(err) {
  try {
    return err && typeof err.message === 'string' && err.message ? String(err.message) : '未知错误'
  } catch (e) {
    return '未知错误'
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, obj) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function apply(ctx) {
  const fsService = ctx.fs
  const webServer = ctx.webServer

  // UI 状态（可持久化）：从 $DSH_HOME/.dsh-bg-state.json 恢复
  const saved = readStateFile()
  const persisted = saved !== null && typeof saved === 'object' ? saved : {}
  const state = {
    enabled: persisted.enabled === true,
    mode: persisted.mode === 'url' || persisted.mode === 'local' ? persisted.mode : 'url',
    kind: persisted.kind === 'video' ? 'video' : 'image',
    url: typeof persisted.url === 'string' ? persisted.url : '',
    dir: typeof persisted.dir === 'string' ? persisted.dir : '',
    name: typeof persisted.name === 'string' ? persisted.name : '',
    clarity: clampNum(persisted.clarity, 0, 100, 60),
    crop: clampCrop(persisted.crop),
    current: null,
    version: 0,
  }
  // 悬浮球（展开面板）背景：独立于主应用的一套设置
  const savedOrb = persisted.orb !== null && typeof persisted.orb === 'object' ? persisted.orb : {}
  const orb = {
    enabled: savedOrb.enabled === true,
    mode: savedOrb.mode === 'url' || savedOrb.mode === 'local' ? savedOrb.mode : 'local',
    kind: savedOrb.kind === 'video' ? 'video' : 'image',
    url: typeof savedOrb.url === 'string' ? savedOrb.url : '',
    dir: typeof savedOrb.dir === 'string' ? savedOrb.dir : '',
    name: typeof savedOrb.name === 'string' ? savedOrb.name : '',
    clarity: clampNum(savedOrb.clarity, 0, 100, 60),
    crop: clampCrop(savedOrb.crop),
    current: null,
    version: 0,
  }
  // 悬浮球面板实测比例（由 patched 助手回报；默认按 340×440 窗口 − 10px chrome×2）
  const orbMetrics = { panelW: 320, panelH: 420, aspect: 320 / 420 }
  // 恢复上次的本地媒体：/dsh-bg/api/media 直接可服务
  const restoredMedia = state.name ? mediaOf(state.name) : null
  if (state.dir && state.name && restoredMedia) {
    state.current = { dir: state.dir, name: state.name, mime: restoredMedia.mime }
    state.kind = restoredMedia.kind
    state.version = 1
  }
  const restoredOrbMedia = orb.name ? mediaOf(orb.name) : null
  if (orb.dir && orb.name && restoredOrbMedia) {
    orb.current = { dir: orb.dir, name: orb.name, mime: restoredOrbMedia.mime }
    orb.kind = restoredOrbMedia.kind
    orb.version = 1
  }

  const persistState = () => {
    writeStateFile({
      enabled: state.enabled,
      mode: state.mode,
      kind: state.kind,
      url: state.url,
      dir: state.dir,
      name: state.name,
      clarity: state.clarity,
      crop: state.crop,
      version: state.version,
      orb: {
        enabled: orb.enabled,
        mode: orb.mode,
        kind: orb.kind,
        url: orb.url,
        dir: orb.dir,
        name: orb.name,
        clarity: orb.clarity,
        crop: orb.crop,
      },
    })
  }

  const uiStateView = () => ({
    enabled: state.enabled,
    mode: state.mode,
    kind: state.kind,
    url: state.url,
    dir: state.dir,
    name: state.name,
    clarity: state.clarity,
    crop: state.crop,
    version: state.version,
  })

  const mergeUiState = (body) => {
    if (body === null || typeof body !== 'object') return
    if (typeof body.enabled === 'boolean') state.enabled = body.enabled
    if (body.mode === 'url' || body.mode === 'local') state.mode = body.mode
    if (body.kind === 'image' || body.kind === 'video') state.kind = body.kind
    if (typeof body.url === 'string') state.url = body.url
    if (typeof body.dir === 'string') state.dir = body.dir
    if (typeof body.name === 'string') state.name = body.name
    if (body.clarity !== undefined) state.clarity = clampNum(body.clarity, 0, 100, state.clarity)
    if (body.crop !== undefined) state.crop = clampCrop(body.crop)
  }

  /** 悬浮球设置视图（供设置页与 patched 助手共用）。 */
  const orbView = () => ({
    enabled: orb.enabled,
    mode: orb.mode,
    kind: orb.kind,
    url: orb.url,
    dir: orb.dir,
    name: orb.name,
    clarity: orb.clarity,
    crop: orb.crop,
    version: orb.version,
  })

  const mergeOrbState = (body) => {
    if (body === null || typeof body !== 'object') return
    if (typeof body.enabled === 'boolean') orb.enabled = body.enabled
    if (body.mode === 'url' || body.mode === 'local') orb.mode = body.mode
    if (body.kind === 'image' || body.kind === 'video') orb.kind = body.kind
    if (typeof body.url === 'string') orb.url = body.url
    if (typeof body.dir === 'string') orb.dir = body.dir
    if (typeof body.name === 'string') orb.name = body.name
    if (body.clarity !== undefined) orb.clarity = clampNum(body.clarity, 0, 100, orb.clarity)
    if (body.crop !== undefined) orb.crop = clampCrop(body.crop)
  }

  /** 供 patched 助手轮询的配置：只有启用且有媒体时才带 url。 */
  const orbRuntimeConfig = () => {
    const port = Number(ctx.webServer && ctx.webServer.port) || 0
    const src = orb.enabled ? orbSrc() : null
    if (src === null) return { enabled: false }
    return {
      enabled: true,
      kind: orb.kind,
      url: src,
      // 与主应用同一套映射：清晰度 100% → 0（面板完全透明，不蒙白）
      tint: (0.88 * (1 - orb.clarity / 100)).toFixed(3),
      // 视频不做框选（铺满面板）；图片按框选区域渲染
      crop: orb.kind === 'video' ? { fx: 0, fy: 0, fw: 1, fh: 1 } : orb.crop,
      port,
      version: orb.version,
    }
  }

  /** 悬浮球当前媒体地址：本地走 /dsh-bg/api/media/orb，远程 URL 原样返回。 */
  const orbSrc = () => {
    if (orb.mode === 'local') {
      return orb.current !== null ? '/dsh-bg/api/media/orb?v=' + orb.version : null
    }
    return orb.url.trim() !== '' ? orb.url.trim() : null
  }

  const disposers = []

  // —— 悬浮球（dsh-orb）状态探测 ——
  // installed：当前 profile 的 node_modules 下是否有 dsh-orb 包；
  // running  ：它的端点是否活着（返回 401 也说明路由在，只有 404/连不上才算没运行）；
  // patched  ：是否已由本插件写入面板背景补丁。
  const orbProfileDir = () => {
    const fromEnv = process.env.DSH_PROFILE_DIR
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
      ? process.env.DSH_PROFILE
      : 'desktop'
    return path.join(DSH_HOME, 'profiles', profile)
  }

  const orbPaths = () => {
    const orbDir = resolveOrbDir(orbProfileDir())
    return orbDir === null ? null : { orbDir, files: orbFilePaths(orbDir) }
  }

  const probeOrb = async () => {
    const resolved = orbPaths()
    const installed = resolved !== null
    const patchVersion = resolved !== null ? orbPatchVersion(resolved.files) : null
    const patched = patchVersion !== null
    const port = Number(ctx.webServer && ctx.webServer.port) || 0
    if (port <= 0) return { installed, patched, patchVersion, patchLatest: PATCH_VERSION, running: false, httpStatus: 0 }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/.dsh-orb/settings', { signal: controller.signal })
      // 401/403 说明路由存在（需要 helper token），即插件在运行；只有 404 才代表没挂载
      return { installed, patched, patchVersion, patchLatest: PATCH_VERSION, running: res.status !== 404, httpStatus: res.status }
    } catch (err) {
      return { installed, patched, patchVersion, patchLatest: PATCH_VERSION, running: false, httpStatus: 0 }
    } finally {
      clearTimeout(timer)
    }
  }

  // 读取/写入悬浮球设置后，用名字重建媒体指向（恢复时用）
  const refreshCurrentMedia = () => {
    const appMedia = state.name ? mediaOf(state.name) : null
    if (state.dir && state.name && appMedia !== null) {
      state.current = { dir: state.dir, name: state.name, mime: appMedia.mime }
      state.kind = appMedia.kind
      state.version += 1
    }
    const orbMedia = orb.name ? mediaOf(orb.name) : null
    if (orb.dir && orb.name && orbMedia !== null) {
      orb.current = { dir: orb.dir, name: orb.name, mime: orbMedia.mime }
      orb.kind = orbMedia.kind
      orb.version += 1
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/orb/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('GET only')
        return
      }
      try {
        sendJson(res, { ok: true, orb: orbView(), metrics: orbMetrics, ...(await probeOrb()) })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 悬浮球设置：读/写（设置页用）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/orb',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        // patched 助手每 3 秒轮询这里，必须轻量：只返回渲染所需字段
        sendJson(res, orbRuntimeConfig())
        return
      }
      if (req.method === 'POST') {
        try {
          mergeOrbState(JSON.parse(await readBody(req)))
          persistState()
          sendJson(res, { ok: true, orb: orbView() })
        } catch (err) {
          sendJson(res, { ok: false, error: errText(err) })
        }
        return
      }
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('GET or POST only')
    },
  }))

  // 悬浮球面板实测尺寸回报（patched 助手在展开时 POST；设置页据此按面板比例框选）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/orb/metrics',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const panelW = clampNum(body && body.panelW, 8, 10000, orbMetrics.panelW)
        const panelH = clampNum(body && body.panelH, 8, 10000, orbMetrics.panelH)
        const aspect = clampNum(body && body.aspect, 0.05, 20, panelW / panelH)
        orbMetrics.panelW = Math.round(panelW)
        orbMetrics.panelH = Math.round(panelH)
        orbMetrics.aspect = Number(aspect.toFixed(4))
        sendJson(res, { ok: true, metrics: orbMetrics })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 悬浮球选媒体（与主应用 /set 同构，写入 orb 分区）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/orb/set',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const dir = String((body && body.dir) || '').trim()
        const entryName = String((body && body.name) || '')
        if (!dir || !entryName) {
          sendJson(res, { ok: false, error: '参数不完整' })
          return
        }
        const media = mediaOf(entryName)
        if (media === null) {
          sendJson(res, { ok: false, error: '不支持的文件格式' })
          return
        }
        const dirTarget = await fsService.resolve(dir)
        const fileTarget = await fsService.resolve(joinPath(dir, entryName))
        if (!fsService.contains(dirTarget, fileTarget)) {
          sendJson(res, { ok: false, error: '文件不在所选目录内' })
          return
        }
        await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
        orb.current = { dir, name: entryName, mime: media.mime }
        orb.version += 1
        orb.dir = dir
        orb.name = entryName
        orb.kind = media.kind
        orb.mode = 'local'
        persistState()
        sendJson(res, { ok: true, url: '/dsh-bg/api/media/orb?v=' + orb.version, kind: media.kind })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 悬浮球媒体字节
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/media/orb',
    handler: async (req, res) => {
      const cur = orb.current
      if (cur === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no orb media')
        return
      }
      try {
        const dirTarget = await fsService.resolve(cur.dir)
        const fileTarget = await fsService.resolve(joinPath(cur.dir, cur.name))
        if (!fsService.contains(dirTarget, fileTarget)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        const bytes = await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
        res.writeHead(200, {
          'Content-Type': cur.mime,
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.byteLength),
        })
        res.end(bytes)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('failed to read orb media')
      }
    },
  }))

  // 主应用 ⇄ 悬浮球 背景互相同步（from: 'app' | 'orb'）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/sync',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const from = body && body.from === 'orb' ? 'orb' : 'app'
        // 安全阀：源没有媒体时拒绝同步，绝不把空的覆盖到另一侧
        const srcHasMedia = from === 'app'
          ? (state.mode === 'local' ? state.current !== null : state.url.trim() !== '')
          : (orb.mode === 'local' ? orb.current !== null : orb.url.trim() !== '')
        if (!srcHasMedia) {
          sendJson(res, {
            ok: false,
            error: from === 'app' ? '主应用还没有选择背景媒体，已取消同步' : '悬浮球还没有选择背景媒体，已取消同步',
          })
          return
        }
        if (from === 'app') {
          orb.mode = state.mode
          orb.kind = state.kind
          orb.url = state.url
          orb.dir = state.dir
          orb.name = state.name
          orb.clarity = state.clarity
          // 主应用框选是屏幕比例、悬浮球是面板比例，直接搬会变形 → 目标侧重置为铺满
          orb.crop = { fx: 0, fy: 0, fw: 1, fh: 1 }
          orb.current = state.current === null ? null : { ...state.current }
          orb.version += 1
        } else {
          state.mode = orb.mode
          state.kind = orb.kind
          state.url = orb.url
          state.dir = orb.dir
          state.name = orb.name
          state.clarity = orb.clarity
          state.crop = { fx: 0, fy: 0, fw: 1, fh: 1 }
          state.current = orb.current === null ? null : { ...orb.current }
          state.version += 1
        }
        persistState()
        sendJson(res, { ok: true, from, state: uiStateView(), orb: orbView() })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 目录选择诊断：客户端把「点了/宿主返回了什么」写进同一份日志，便于定位
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/log',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        logPick({ source: 'client', text: String((body && body.text) || '').slice(0, 300) })
        sendJson(res, { ok: true })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 由宿主自己弹系统「选择文件夹」对话框（桌面端 DSH 没注册目录选择能力时用）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/pick-folder',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const result = await pickFolderNative()
        if (typeof result.dir === 'string' && result.dir !== '') {
          sendJson(res, { ok: true, dir: result.dir })
          return
        }
        sendJson(res, { ok: false, cancelled: result.cancelled === true, error: result.error })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  // 写入 / 撤销 悬浮球面板背景补丁（写文件前先备份）
  const patchHandler = (mode) => async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('POST only')
      return
    }
    const resolved = orbPaths()
    if (resolved === null) {
      sendJson(res, { ok: false, error: '未找到已安装的悬浮球（dsh-orb）' })
      return
    }
    const backupRoot = backupRootOf(DSH_HOME)
    const result = mode === 'apply'
      ? applyOrbPatch(resolved.files, backupRoot)
      : revertOrbPatch(resolved.files, backupRoot)
    sendJson(res, { ok: result.ok === true, action: mode, ...result, patched: isOrbPatched(resolved.files) })
  }

  disposers.push(webServer.register({ kind: 'exact', path: '/dsh-bg/api/orb/patch', handler: patchHandler('apply') }))
  disposers.push(webServer.register({ kind: 'exact', path: '/dsh-bg/api/orb/unpatch', handler: patchHandler('revert') }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/state',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, { ok: true, state: uiStateView() })
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          mergeUiState(body)
          persistState()
          sendJson(res, { ok: true, state: uiStateView() })
        } catch (err) {
          sendJson(res, { ok: false, error: errText(err) })
        }
        return
      }
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('GET or POST only')
    },
  }))

  // 恢复「上一份」状态（覆盖前自动留底的那份），用于误覆盖后的找回
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/state/restore',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        if (!fs.existsSync(PREV_STATE_FILE)) {
          sendJson(res, { ok: false, error: '没有可用的上一份状态' })
          return
        }
        const prev = JSON.parse(fs.readFileSync(PREV_STATE_FILE, 'utf8'))
        if (prev === null || typeof prev !== 'object') {
          sendJson(res, { ok: false, error: '上一份状态不可解析' })
          return
        }
        mergeUiState(prev)
        if (prev.orb !== undefined) mergeOrbState(prev.orb)
        refreshCurrentMedia()
        persistState()
        sendJson(res, { ok: true, restored: true, state: uiStateView(), orb: orbView() })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/list',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const dir = String((body && body.dir) || '').trim()
        if (!dir) {
          sendJson(res, { ok: false, error: '缺少目录参数' })
          return
        }
        const dirTarget = await fsService.resolve(dir)
        const entries = await fsService.listDir(dirTarget)
        // 确定性排序 + 按名去重，保证列表顺序稳定、条目互不重叠（重复）
        const nameCompare = (a, b) => String(a.name).localeCompare(String(b.name), undefined, {
          numeric: true,
          sensitivity: 'base',
        })
        const files = []
        const seen = new Set()
        for (const entry of entries) {
          if (entry.type !== 'file') continue
          const media = mediaOf(entry.name)
          if (media === null) continue
          if (seen.has(entry.name)) continue
          seen.add(entry.name)
          files.push({ name: entry.name, size: typeof entry.size === 'number' ? entry.size : 0, kind: media.kind })
        }
        files.sort(nameCompare)
        if (files.length > 300) files.length = 300
        // 兼容层：同时返回新版 files（含 kind）与旧版 images（仅图片），
        // 使浏览器端 bundle 版本领先于 Host（未重启）时仍可正常读取列表。
        const legacyImages = files
          .filter((f) => f.kind === 'image')
          .map((f) => ({ name: f.name, size: f.size }))
        sendJson(res, { ok: true, files, images: legacyImages })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/set',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('POST only')
        return
      }
      try {
        const body = JSON.parse(await readBody(req))
        const dir = String((body && body.dir) || '').trim()
        const entryName = String((body && body.name) || '')
        if (!dir || !entryName) {
          sendJson(res, { ok: false, error: '参数不完整' })
          return
        }
        const media = mediaOf(entryName)
        if (media === null) {
          sendJson(res, { ok: false, error: '不支持的文件格式' })
          return
        }
        const dirTarget = await fsService.resolve(dir)
        const fileTarget = await fsService.resolve(joinPath(dir, entryName))
        if (!fsService.contains(dirTarget, fileTarget)) {
          sendJson(res, { ok: false, error: '文件不在所选目录内' })
          return
        }
        await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
        state.current = { dir, name: entryName, mime: media.mime }
        state.version += 1
        state.dir = dir
        state.name = entryName
        state.kind = media.kind
        persistState()
        sendJson(res, { ok: true, url: '/dsh-bg/api/media?v=' + state.version, kind: media.kind })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  const serveMedia = async (req, res) => {
    const cur = state.current
    if (!cur) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('no background media')
      return
    }
    try {
      const dirTarget = await fsService.resolve(cur.dir)
      const fileTarget = await fsService.resolve(joinPath(cur.dir, cur.name))
      if (!fsService.contains(dirTarget, fileTarget)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const bytes = await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
      res.writeHead(200, {
        'Content-Type': cur.mime,
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.byteLength),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('failed to read media')
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/media',
    handler: serveMedia,
  }))

  // 兼容层：旧路由 /img 作为 /media 的别名，使旧版浏览器端 bundle 仍可加载媒体
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/img',
    handler: serveMedia,
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* noop */ }
    }
  })
}

export { name, inject, apply }
