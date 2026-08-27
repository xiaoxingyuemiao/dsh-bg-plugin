// dsh-bg-plugin —— Host 半边（静态安装版）
// 运行环境：DSH 主进程（完整 Node ESM 模块，无沙箱限制）。
// 职责：通过 webServer 提供 JSON API 与图片字节路由：
//   GET  /dsh-bg/api/state —— 读取持久化的 UI 状态
//   POST /dsh-bg/api/state —— 合并并保存 UI 状态
//   POST /dsh-bg/api/list  —— { dir } -> { ok, images:[{name,size}] }
//   POST /dsh-bg/api/set   —— { dir, name } -> { ok, url:'/dsh-bg/api/img?v=N' }
//   GET  /dsh-bg/api/img   —— 当前图片字节（?v=N 用于刷新缓存）
// 浏览器端（lib/client.js）用 fetch 直连这些路由，无需动态包 RPC。
// 持久化：状态 JSON 保存在 $DSH_HOME/.dsh-bg-state.json（whale-widget 同款模式）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const name = 'dsh-bg-plugin'
const inject = ['fs', 'webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-bg-state.json')

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml',
}
const MAX_BYTES = 12 * 1024 * 1024 // 单张图片上限
const MAX_BODY = 64 * 1024 // JSON 请求体上限

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
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
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    // 写入失败不阻塞功能，仅本次不持久化
  }
}

function extOf(entryName) {
  const i = String(entryName).lastIndexOf('.')
  return i > 0 ? String(entryName).slice(i + 1).toLowerCase() : ''
}

function joinPath(dir, entryName) {
  return String(dir).replace(/[\\/]+$/, '') + '/' + String(entryName)
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
    url: typeof persisted.url === 'string' ? persisted.url : '',
    dir: typeof persisted.dir === 'string' ? persisted.dir : '',
    name: typeof persisted.name === 'string' ? persisted.name : '',
    clarity: clampNum(persisted.clarity, 0, 100, 60),
    dim: clampNum(persisted.dim, 0, 0.8, 0.2),
    blur: clampNum(persisted.blur, 0, 20, 0),
    current: null,
    version: 0,
  }
  // 恢复上次的本地图片：/dsh-bg/api/img 直接可服务
  if (state.dir && state.name && MIME[extOf(state.name)]) {
    state.current = { dir: state.dir, name: state.name, mime: MIME[extOf(state.name)] }
    state.version = 1
  }

  const persistState = () => {
    writeStateFile({
      enabled: state.enabled,
      mode: state.mode,
      url: state.url,
      dir: state.dir,
      name: state.name,
      clarity: state.clarity,
      dim: state.dim,
      blur: state.blur,
      version: state.version,
    })
  }

  const uiStateView = () => ({
    enabled: state.enabled,
    mode: state.mode,
    url: state.url,
    dir: state.dir,
    name: state.name,
    clarity: state.clarity,
    dim: state.dim,
    blur: state.blur,
    version: state.version,
  })

  const mergeUiState = (body) => {
    if (body === null || typeof body !== 'object') return
    if (typeof body.enabled === 'boolean') state.enabled = body.enabled
    if (body.mode === 'url' || body.mode === 'local') state.mode = body.mode
    if (typeof body.url === 'string') state.url = body.url
    if (typeof body.dir === 'string') state.dir = body.dir
    if (typeof body.name === 'string') state.name = body.name
    if (body.clarity !== undefined) state.clarity = clampNum(body.clarity, 0, 100, state.clarity)
    if (body.dim !== undefined) state.dim = clampNum(body.dim, 0, 0.8, state.dim)
    if (body.blur !== undefined) state.blur = clampNum(body.blur, 0, 20, state.blur)
  }

  const disposers = []

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
        const images = []
        for (const entry of entries) {
          if (entry.type !== 'file') continue
          if (!MIME[extOf(entry.name)]) continue
          images.push({ name: entry.name, size: typeof entry.size === 'number' ? entry.size : 0 })
          if (images.length >= 200) break
        }
        sendJson(res, { ok: true, images })
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
        const mime = MIME[extOf(entryName)]
        if (!mime) {
          sendJson(res, { ok: false, error: '不支持的图片格式' })
          return
        }
        const dirTarget = await fsService.resolve(dir)
        const fileTarget = await fsService.resolve(joinPath(dir, entryName))
        if (!fsService.contains(dirTarget, fileTarget)) {
          sendJson(res, { ok: false, error: '文件不在所选目录内' })
          return
        }
        await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
        state.current = { dir, name: entryName, mime }
        state.version += 1
        state.dir = dir
        state.name = entryName
        persistState()
        sendJson(res, { ok: true, url: '/dsh-bg/api/img?v=' + state.version })
      } catch (err) {
        sendJson(res, { ok: false, error: errText(err) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-bg/api/img',
    handler: async (req, res) => {
      const cur = state.current
      if (!cur) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no background image')
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
        res.end('failed to read image')
      }
    },
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* noop */ }
    }
  })
}

export { name, inject, apply }
