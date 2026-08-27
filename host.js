// DSH 自定义背景插件 —— Host 半边（pkg-6）
// 职责：列出目录图片、设置当前图片、通过唯一 HTTP 路由把图片字节提供给浏览器。
// 运行环境：DSH Cordis 动态插件 Host 沙箱（plain JS，无 import/require）。
return {
  apply(ctx) {
    const fsService = ctx.get('fs')
    const webServer = ctx.get('webServer')
    if (fsService === undefined || webServer === undefined) return

    const MIME = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      avif: 'image/avif', svg: 'image/svg+xml',
    }
    const MAX_BYTES = 12 * 1024 * 1024
    const state = { current: null, version: 0 }
    // 每次运行使用唯一路由路径：旧版本泄漏的 /dsh-bg/current 无法回收，
    // 且路由注册必须随 fiber 清理（ctx.effect），否则更新/停止会重复注册报错。
    const routePath = '/dsh-bg/img-' + Math.random().toString(36).slice(2, 10)

    const extOf = (name) => {
      const i = String(name).lastIndexOf('.')
      return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''
    }
    const joinPath = (dir, name) => String(dir).replace(/[\\/]+$/, '') + '/' + String(name)
    const errText = (err) => {
      try {
        return err && typeof err.message === 'string' && err.message ? String(err.message) : '未知错误'
      } catch (e) {
        return '未知错误'
      }
    }

    harness.handle('list-images', async (args) => {
      try {
        const dir = String((args && args.dir) || '').trim()
        if (!dir) return { ok: false, error: '缺少目录参数' }
        const dirTarget = await fsService.resolve(dir)
        const entries = await fsService.listDir(dirTarget)
        const images = []
        for (const entry of entries) {
          if (entry.type !== 'file') continue
          if (!MIME[extOf(entry.name)]) continue
          images.push({ name: entry.name, size: typeof entry.size === 'number' ? entry.size : 0 })
          if (images.length >= 200) break
        }
        return { ok: true, images }
      } catch (err) {
        return { ok: false, error: errText(err) }
      }
    })

    harness.handle('set-image', async (args) => {
      try {
        const dir = String((args && args.dir) || '').trim()
        const name = String((args && args.name) || '')
        if (!dir || !name) return { ok: false, error: '参数不完整' }
        const mime = MIME[extOf(name)]
        if (!mime) return { ok: false, error: '不支持的图片格式' }
        const dirTarget = await fsService.resolve(dir)
        const fileTarget = await fsService.resolve(joinPath(dir, name))
        if (!fsService.contains(dirTarget, fileTarget)) return { ok: false, error: '文件不在所选目录内' }
        await fsService.readBytes(fileTarget, undefined, MAX_BYTES)
        state.current = { dir, name, mime }
        state.version += 1
        return { ok: true, url: routePath + '?v=' + state.version }
      } catch (err) {
        return { ok: false, error: errText(err) }
      }
    })

    harness.handle('clear-image', async () => {
      state.current = null
      state.version += 1
      return { ok: true }
    })

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: routePath,
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
  },
}
