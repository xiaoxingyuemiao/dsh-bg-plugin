// dsh-bg-plugin —— Client 半边（静态安装版）
// 运行环境：浏览器。必须通过 __ModuleLoader__.load({ id, factory }) 注册工厂，
// 否则模块表在启动时抛 "bundle loaded without registering ... via __ModuleLoader__.load"。
// id 必须等于行的 name（即包名 dsh-bg-plugin）；factory(require) 的返回值即模块导出。
// 与动态版差异：无 host/styles 内置 —— API 走 fetch('/dsh-bg/api/...')，
// 样式用 document.createElement('style') 注入；不注册 tool.view.cordis（动态专属座位）。
// 功能：背景图片 + 框选展示区域（crop 以图片分数存储，随 /state 持久化）。
window.__ModuleLoader__.load({
  id: 'dsh-bg-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'dsh-bg-plugin'
    const inject = ['slots', 'theme']

    function insertCss(css) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-bg-plugin'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        try { tag.remove() } catch (err) { /* noop */ }
      }
    }

    async function apiCall(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      return res.json()
    }

    async function apiGet(path) {
      const res = await fetch(path)
      return res.json()
    }

    function clampCrop(crop) {
      const box = crop !== null && typeof crop === 'object' ? crop : {}
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
      let fx = Math.max(0, Math.min(1, num(box.fx, 0)))
      let fy = Math.max(0, Math.min(1, num(box.fy, 0)))
      let fw = Math.max(0.05, Math.min(1, num(box.fw, 1)))
      let fh = Math.max(0.05, Math.min(1, num(box.fh, 1)))
      if (fx + fw > 1) fx = 1 - fw
      if (fy + fh > 1) fy = 1 - fh
      return { fx, fy, fw, fh }
    }

    async function apply(ctx) {
      const h = React.createElement
      const slots = ctx.slots
      const theme = ctx.theme

      const state = {
        enabled: false, mode: 'url',
        urlDraft: '', url: '',
        dirDraft: '', dir: '', files: [], selected: '', localUrl: '',
        clarity: 60, dim: 0.2, blur: 0,
        crop: { fx: 0, fy: 0, fw: 1, fh: 1 },
        busy: false, error: '',
        tokenDispose: null, styleDispose: null,
      }
      let naturalSize = null // 当前背景图片原始尺寸 {w,h}，用于裁切换算

      // 从 Host 恢复持久化状态（$DSH_HOME/.dsh-bg-state.json）
      try {
        const res = await apiGet('/dsh-bg/api/state')
        if (res && res.ok === true && res.state && typeof res.state === 'object') {
          const s = res.state
          if (typeof s.enabled === 'boolean') state.enabled = s.enabled
          if (s.mode === 'url' || s.mode === 'local') state.mode = s.mode
          if (typeof s.url === 'string') state.url = s.url
          if (typeof s.dir === 'string') { state.dir = s.dir; state.dirDraft = s.dir }
          if (typeof s.name === 'string' && s.name) { state.selected = s.name }
          if (typeof s.clarity === 'number') state.clarity = Math.max(0, Math.min(100, s.clarity))
          if (typeof s.dim === 'number') state.dim = Math.max(0, Math.min(0.8, s.dim))
          if (typeof s.blur === 'number') state.blur = Math.max(0, Math.min(20, s.blur))
          if (s.crop !== undefined) state.crop = clampCrop(s.crop)
          if (state.mode === 'local' && state.selected) state.localUrl = '/dsh-bg/api/img?v=' + Date.now()
        }
      } catch (err) { /* 恢复失败则使用默认状态 */ }

      const UI_CSS = '.dshbg-page{display:flex;flex-direction:column;gap:12px;padding:2px 0 8px;max-width:560px}' +
        '.dshbg-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
        '.dshbg-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
        '.dshbg-row{display:flex;align-items:center;gap:10px;min-height:30px}' +
        '.dshbg-col{display:flex;flex-direction:column;gap:8px}' +
        '.dshbg-label{flex:1;font-size:13px;color:var(--dsw-alias-label-primary)}' +
        '.dshbg-hint{font-size:11px;color:var(--dsw-alias-label-caption,#81858c);word-break:break-all}' +
        '.dshbg-status{font-size:12px;color:var(--dsw-alias-state-error-primary)}' +
        '.dshbg-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}' +
        '.dshbg-switch{padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}' +
        '.dshbg-switch.dshbg-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}' +
        '.dshbg-seg{display:flex;gap:6px}' +
        '.dshbg-segbtn{padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}' +
        '.dshbg-segbtn[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}' +
        '.dshbg-input{flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}' +
        '.dshbg-btn{padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}' +
        '.dshbg-btn.dshbg-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}' +
        '.dshbg-btn:disabled{opacity:.5;cursor:default}' +
        '.dshbg-range{flex:1;accent-color:var(--dsw-alias-brand-primary)}' +
        '.dshbg-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:4px;position:relative}' +
        '.dshbg-file{flex:none;position:relative;text-align:left;padding:5px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.dshbg-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}' +
        '.dshbg-file[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}' +
        // —— 预览与框选 ——
        '.dshbg-preview{display:flex;flex-direction:column;gap:8px;align-items:center}' +
        '.dshbg-previewbox{position:relative;display:inline-block;max-width:100%;max-height:260px;cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:repeating-conic-gradient(#0000000f 0 25%,transparent 0 50%) 50%/14px 14px}' +
        '.dshbg-previewimg{display:block;max-width:100%;max-height:260px;pointer-events:none}' +
        '.dshbg-crop{position:absolute;border:1.5px solid var(--dsw-alias-brand-primary);background:rgba(65,118,230,.12);box-shadow:0 0 0 9999px rgba(0,0,0,.25)}' +
        '.dshbg-cropcorner{position:absolute;width:10px;height:10px;border:2px solid #fff;border-radius:2px;background:var(--dsw-alias-brand-primary)}' +
        '.dshbg-crop-nw{left:-6px;top:-6px;cursor:nwse-resize}.dshbg-crop-ne{right:-6px;top:-6px;cursor:nesw-resize}' +
        '.dshbg-crop-sw{left:-6px;bottom:-6px;cursor:nesw-resize}.dshbg-crop-se{right:-6px;bottom:-6px;cursor:nwse-resize}'

      // 设置面板原色恢复：背景启用时，面板及其内部表面保持 DSH 默认不透明色值，不跟随背景变化。
      // 色值取自设计平台基础样式（--dsw-static-neutral-bluish-*）。
      const SETTINGS_RESTORE_CSS = '[role="dialog"][aria-modal="true"]{' +
        '--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#ffffff;--dsw-specific-sidebar-fill:#f9fafb}' +
        'body[data-ds-dark-theme] [role="dialog"][aria-modal="true"]{' +
        '--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-specific-sidebar-fill:#1b1b1c}'

      const escapeCssString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const backgroundSrc = () => {
        if (state.mode === 'url' && state.url.trim()) return state.url.trim()
        if (state.mode === 'local' && state.localUrl) return state.localUrl
        return null
      }

      // 裁切区域 → 纯 CSS 背景公式（vw/vh 自适应视口，窗口缩放自动跟随）：
      // 整图按统一比例 scale = max(vw/裁切宽, vh/裁切高) 均匀缩放（保持原宽高比），
      // 再平移使「裁切区域中心」对准「视口中心」；全部用 calc/max + 无单位系数表达。
      const buildImageCss = (url, natural) => {
        const q = 'url("' + escapeCssString(url) + '")'
        if (!natural || natural.w <= 0 || natural.h <= 0) {
          return { bg: q, size: 'auto, cover', pos: '0 0, center' }
        }
        const c = state.crop
        const f = (v) => v.toFixed(6)
        const k = natural.w / natural.h // 图片原始宽高比
        const r1 = 1 / c.fw // 视口宽 / 裁切宽 的系数
        const r2 = 1 / c.fh // 视口高 / 裁切高 的系数
        const Sx = 'max(100vw * ' + f(r1) + ', 100vh * ' + f(r2 * k) + ')'
        const Sy = 'max(100vw * ' + f(r1 / k) + ', 100vh * ' + f(r2) + ')'
        const cx = f(c.fx + c.fw * 0.5) // 裁切中心 x（图片宽分数）
        const cy = f(c.fy + c.fh * 0.5) // 裁切中心 y（图片高分数）
        const Px = 'calc(50vw - ' + Sx + ' * ' + cx + ')'
        const Py = 'calc(50vh - ' + Sy + ' * ' + cy + ')'
        return { bg: q, size: 'auto, ' + Sx + ' ' + Sy, pos: '0 0, ' + Px + ' ' + Py }
      }

      const disposeLayers = () => {
        if (state.tokenDispose) { try { state.tokenDispose() } catch (e) { /* noop */ } }
        if (state.styleDispose) { try { state.styleDispose() } catch (e) { /* noop */ } }
        state.tokenDispose = null
        state.styleDispose = null
      }

      const applyBackground = () => {
        disposeLayers()
        if (!state.enabled) return
        const src = backgroundSrc()
        if (!src) return
        // 背景清晰度：越高表面越透明、图片越清楚；内容卡片表面略不透明保证可读
        const clarity = Math.max(0, Math.min(100, Number(state.clarity) || 0))
        const base = 0.88 - (clarity / 100) * 0.73
        const alphaBase = base.toFixed(2)
        const alphaLayer1 = Math.min(0.92, base + 0.28).toFixed(2)
        const alphaLayer2 = Math.min(0.95, base + 0.33).toFixed(2)
        state.tokenDispose = theme.overrideTokens('dsh-bg-plugin', {
          '--dsw-alias-bg-base': { light: 'rgba(255,255,255,' + alphaBase + ')', dark: 'rgba(21,21,23,' + alphaBase + ')' },
          '--dsw-alias-bg-layer-1': { light: 'rgba(255,255,255,' + alphaLayer1 + ')', dark: 'rgba(35,35,36,' + alphaLayer1 + ')' },
          '--dsw-alias-bg-layer-2': { light: 'rgba(255,255,255,' + alphaLayer2 + ')', dark: 'rgba(44,44,46,' + alphaLayer2 + ')' },
          '--dsw-specific-sidebar-fill': { light: 'rgba(249,250,251,' + alphaBase + ')', dark: 'rgba(27,27,28,' + alphaBase + ')' },
        })
        const dim = Math.max(0, Math.min(0.8, Number(state.dim) || 0))
        const blur = Math.max(0, Math.min(20, Number(state.blur) || 0))
        const extras = blur > 0 ? 'filter:blur(' + blur + 'px);transform:scale(1.08);' : ''
        const imgCss = buildImageCss(src, naturalSize)
        const scrim = 'linear-gradient(rgba(0,0,0,' + dim.toFixed(2) + '),rgba(0,0,0,' + dim.toFixed(2) + '))'
        const css = 'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' + extras +
          'background-image:' + scrim + ',' + imgCss.bg + ';' +
          'background-repeat:no-repeat,no-repeat;' +
          'background-size:' + imgCss.size + ';' +
          'background-position:' + imgCss.pos + ';' +
          'background-attachment:fixed,fixed;}' +
          SETTINGS_RESTORE_CSS
        state.styleDispose = insertCss(css)
      }

      const persist = () => {
        // 持久化 UI 状态到 Host（$DSH_HOME/.dsh-bg-state.json）
        apiCall('/dsh-bg/api/state', {
          enabled: state.enabled,
          mode: state.mode,
          url: state.url,
          dir: state.dir,
          name: state.selected,
          clarity: state.clarity,
          dim: state.dim,
          blur: state.blur,
          crop: state.crop,
        }).catch(() => { /* 保存失败不打断交互 */ })
      }

      ctx.effect(() => () => disposeLayers())
      ctx.effect(() => insertCss(UI_CSS))

      // 恢复持久化状态后自动重应用背景（若上次是启用状态）
      if (state.enabled) applyBackground()

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'dsh-bg', order: 5, label: '背景' },
        function BackgroundSettings() {
          const [tick, setTick] = React.useState(0)
          const boxRef = React.useRef(null)
          const dragRef = React.useRef(null)
          const dragTimerRef = React.useRef(null)
          const refresh = () => setTick((t) => t + 1)
          const patch = (p) => { Object.assign(state, p); refresh() }
          const apply = (p) => { Object.assign(state, p); refresh(); applyBackground(); persist() }

          const previewSrc = state.mode === 'url' ? state.url.trim() : (state.mode === 'local' ? state.localUrl : '')

          // 加载当前背景图的原始尺寸（裁切换算需要）
          React.useEffect(() => {
            if (!previewSrc) { naturalSize = null; return }
            let cancelled = false
            const img = new Image()
            img.onload = () => {
              if (cancelled) return
              naturalSize = { w: img.naturalWidth, h: img.naturalHeight }
              if (state.enabled) applyBackground()
            }
            img.onerror = () => {
              if (cancelled) return
              naturalSize = null
              if (state.enabled) applyBackground()
            }
            img.src = previewSrc
            return () => { cancelled = true }
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [previewSrc])

          const loadDir = async (dir) => {
            const target = String(dir || '').trim()
            if (!target) { patch({ error: '请输入或选择文件夹路径' }); return }
            patch({ busy: true, error: '', dirDraft: target, dir: target, files: [], selected: '' })
            try {
              const res = await apiCall('/dsh-bg/api/list', { dir: target })
              if (res && res.ok === true && Array.isArray(res.images)) {
                // 防御性排序：与 Host 端一致（数字自然序、忽略大小写），条目互不重叠
                const list = res.images.slice().sort((a, b) =>
                  String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }))
                patch({ dir: target, files: list, selected: '', busy: false })
                if (list.length === 0) patch({ error: '该文件夹中没有支持的图片（png/jpg/gif/webp/bmp/avif/svg）' })
              } else {
                patch({ busy: false, error: (res && res.error) || '读取文件夹失败' })
              }
            } catch (err) {
              let msg = '读取文件夹失败'
              try { if (err && typeof err.message === 'string' && err.message) msg = msg + '：' + err.message } catch (e) { /* noop */ }
              patch({ busy: false, error: msg })
            }
          }

          const pickDir = async () => {
            const workspaces = ctx.get('workspaces')
            if (workspaces === undefined) { patch({ error: '目录选择不可用，请直接输入文件夹路径' }); return }
            patch({ busy: true, error: '' })
            try {
              const dir = await workspaces.pickDirectory()
              if (!dir) { patch({ busy: false }); return }
              await loadDir(dir)
            } catch (err) {
              let msg = '目录选择失败'
              try { if (err && typeof err.message === 'string' && err.message) msg = msg + '：' + err.message } catch (e) { /* noop */ }
              patch({ busy: false, error: msg + '，可直接在上方输入框粘贴文件夹路径' })
            }
          }

          const pickFile = async (imgName) => {
            patch({ busy: true, error: '' })
            try {
              const res = await apiCall('/dsh-bg/api/set', { dir: state.dir, name: imgName })
              if (res && res.ok === true && typeof res.url === 'string') {
                patch({ selected: imgName, localUrl: res.url, busy: false })
                applyBackground()
                persist()
              } else {
                patch({ busy: false, error: (res && res.error) || '设置图片失败' })
              }
            } catch (err) {
              let msg = '设置图片失败'
              try { if (err && typeof err.message === 'string' && err.message) msg = msg + '：' + err.message } catch (e) { /* noop */ }
              patch({ busy: false, error: msg })
            }
          }

          const applyUrl = () => {
            if (!state.urlDraft.trim()) { patch({ error: '请输入图片 URL' }); return }
            apply({ url: state.urlDraft.trim(), error: '' })
          }

          const fmtSize = (size) => {
            if (!size || size <= 0) return ''
            if (size >= 1024 * 1024) return '  (' + (size / 1024 / 1024).toFixed(1) + ' MB)'
            return '  (' + Math.round(size / 1024) + ' KB)'
          }

          // —— 框选交互 ——
          const fracFromEvent = (e) => {
            const rect = boxRef.current.getBoundingClientRect()
            return {
              x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
              y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
            }
          }

          const onBoxPointerDown = (e) => {
            if (boxRef.current === null) return
            const p = fracFromEvent(e)
            const c = state.crop
            const handleR = 0.04
            const corners = {
              nw: [c.fx, c.fy],
              ne: [c.fx + c.fw, c.fy],
              sw: [c.fx, c.fy + c.fh],
              se: [c.fx + c.fw, c.fy + c.fh],
            }
            let corner = null
            for (const key of Object.keys(corners)) {
              const pt = corners[key]
              if (Math.abs(p.x - pt[0]) <= handleR && Math.abs(p.y - pt[1]) <= handleR) { corner = key; break }
            }
            const inside = p.x >= c.fx && p.x <= c.fx + c.fw && p.y >= c.fy && p.y <= c.fy + c.fh
            try { boxRef.current.setPointerCapture(e.pointerId) } catch (err) { /* noop */ }
            if (corner) {
              // 对角的固定锚点
              const ax = corner === 'nw' || corner === 'sw' ? c.fx + c.fw : c.fx
              const ay = corner === 'nw' || corner === 'ne' ? c.fy + c.fh : c.fy
              dragRef.current = { mode: 'resize', ax, ay }
            } else if (inside) {
              dragRef.current = { mode: 'move', sx: p.x, sy: p.y, orig: { fx: c.fx, fy: c.fy, fw: c.fw, fh: c.fh } }
            } else {
              dragRef.current = { mode: 'draw', ax: p.x, ay: p.y }
            }
          }

          const onBoxPointerMove = (e) => {
            const d = dragRef.current
            if (!d) return
            const p = fracFromEvent(e)
            let crop = null
            if (d.mode === 'draw') {
              crop = clampCrop({ fx: Math.min(d.ax, p.x), fy: Math.min(d.ay, p.y), fw: Math.abs(p.x - d.ax), fh: Math.abs(p.y - d.ay) })
            } else if (d.mode === 'resize') {
              crop = clampCrop({ fx: Math.min(p.x, d.ax), fy: Math.min(p.y, d.ay), fw: Math.abs(p.x - d.ax), fh: Math.abs(p.y - d.ay) })
            } else if (d.mode === 'move') {
              const dx = p.x - d.sx
              const dy = p.y - d.sy
              crop = clampCrop({ fx: d.orig.fx + dx, fy: d.orig.fy + dy, fw: d.orig.fw, fh: d.orig.fh })
            }
            if (crop) {
              state.crop = crop
              refresh()
              if (dragTimerRef.current) clearTimeout(dragTimerRef.current)
              dragTimerRef.current = setTimeout(() => { dragTimerRef.current = null; applyBackground() }, 120)
            }
          }

          const onBoxPointerUp = (e) => {
            const d = dragRef.current
            if (!d) return
            // 纯点击（几乎没拖动）不改变裁切框
            if (d.mode === 'draw') {
              const p = fracFromEvent(e)
              if (Math.abs(p.x - d.ax) < 0.02 && Math.abs(p.y - d.ay) < 0.02) {
                dragRef.current = null
                return
              }
            }
            dragRef.current = null
            if (dragTimerRef.current) { clearTimeout(dragTimerRef.current); dragTimerRef.current = null }
            applyBackground()
            persist()
          }

          const cropIsFull = state.crop.fx <= 0.001 && state.crop.fy <= 0.001 && state.crop.fw >= 0.999 && state.crop.fh >= 0.999
          const c = state.crop

          return h('div', { className: 'dshbg-page' }, [
            h('div', { className: 'dshbg-title' }, '自定义背景'),
            h('div', { className: 'dshbg-desc' }, '为 DSH 应用自定义图片作为背景：图片铺在应用底层，界面表面变为半透明叠加在其上；设置面板保持原本外观。可框选图片中想展示的区域。所有调整会自动保存，刷新页面或重启 DSH 后自动恢复。'),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '启用自定义背景'),
              h('button', { className: 'dshbg-switch' + (state.enabled ? ' dshbg-on' : ''), onClick: () => apply({ enabled: !state.enabled }) },
                state.enabled ? '已启用' : '已禁用'),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '图片来源'),
              h('div', { className: 'dshbg-seg' }, [
                ['url', '图片 URL'], ['local', '本地图片'],
              ].map((pair) => h('button', {
                key: pair[0],
                className: 'dshbg-segbtn',
                'data-active': state.mode === pair[0] || undefined,
                onClick: () => apply({ mode: pair[0], error: '' }),
              }, pair[1]))),
            ]),
            state.mode === 'url' && h('div', { className: 'dshbg-col' }, [
              h('div', { className: 'dshbg-row' }, [
                h('input', { className: 'dshbg-input', placeholder: 'https://example.com/wallpaper.jpg', value: state.urlDraft, onChange: (e) => patch({ urlDraft: e.target.value }) }),
                h('button', { className: 'dshbg-btn dshbg-primary', onClick: applyUrl }, '应用'),
              ]),
              state.url && h('div', { className: 'dshbg-hint' }, '当前图片：' + state.url),
            ]),
            state.mode === 'local' && h('div', { className: 'dshbg-col' }, [
              h('div', { className: 'dshbg-row' }, [
                h('input', { className: 'dshbg-input', placeholder: '例如 D:\\壁纸 或 C:\\Users\\你\\Pictures', value: state.dirDraft, onChange: (e) => patch({ dirDraft: e.target.value }) }),
              ]),
              h('div', { className: 'dshbg-row' }, [
                h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => loadDir(state.dirDraft), disabled: state.busy || undefined }, '列出图片'),
                h('button', { className: 'dshbg-btn', onClick: pickDir, disabled: state.busy || undefined }, '浏览文件夹…'),
              ]),
              state.dir && h('div', { className: 'dshbg-hint' }, '文件夹：' + state.dir),
              state.files.length > 0 && h('div', { className: 'dshbg-list' }, state.files.map((f) => h('button', {
                key: f.name,
                className: 'dshbg-file',
                'data-active': state.selected === f.name || undefined,
                onClick: () => pickFile(f.name),
              }, f.name + fmtSize(f.size)))),
              state.selected && h('div', { className: 'dshbg-ok' }, '已应用：' + state.selected + '，点击其他图片可切换'),
            ]),
            previewSrc && h('div', { className: 'dshbg-preview' }, [
              h('div', {
                className: 'dshbg-previewbox',
                ref: boxRef,
                onPointerDown: onBoxPointerDown,
                onPointerMove: onBoxPointerMove,
                onPointerUp: onBoxPointerUp,
              }, [
                h('img', { className: 'dshbg-previewimg', src: previewSrc, draggable: false, alt: '' }),
                h('div', {
                  className: 'dshbg-crop',
                  style: {
                    left: (c.fx * 100) + '%',
                    top: (c.fy * 100) + '%',
                    width: (c.fw * 100) + '%',
                    height: (c.fh * 100) + '%',
                  },
                }, [
                  h('div', { className: 'dshbg-cropcorner dshbg-crop-nw' }),
                  h('div', { className: 'dshbg-cropcorner dshbg-crop-ne' }),
                  h('div', { className: 'dshbg-cropcorner dshbg-crop-sw' }),
                  h('div', { className: 'dshbg-cropcorner dshbg-crop-se' }),
                ]),
              ]),
              h('div', { className: 'dshbg-hint' }, '在预览图上拖动框选展示区域；拖动选框移动位置，拖四角调整大小' + (cropIsFull ? '（当前为完整图片）' : '')),
              h('div', { className: 'dshbg-row', style: { justifyContent: 'center', gap: 10 } }, [
                h('button', {
                  className: 'dshbg-btn',
                  onClick: () => apply({ crop: { fx: 0, fy: 0, fw: 1, fh: 1 } }),
                  disabled: cropIsFull || undefined,
                }, '重置为完整图片'),
              ]),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '背景清晰度 ' + state.clarity + '%'),
              h('input', { type: 'range', min: '0', max: '100', step: '5', value: state.clarity, className: 'dshbg-range', onChange: (e) => apply({ clarity: Number(e.target.value) }) }),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '压暗 ' + Math.round(state.dim * 100) + '%'),
              h('input', { type: 'range', min: '0', max: '0.8', step: '0.05', value: state.dim, className: 'dshbg-range', onChange: (e) => apply({ dim: Number(e.target.value) }) }),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '模糊 ' + state.blur + 'px'),
              h('input', { type: 'range', min: '0', max: '20', step: '1', value: state.blur, className: 'dshbg-range', onChange: (e) => apply({ blur: Number(e.target.value) }) }),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('button', {
                className: 'dshbg-btn',
                onClick: () => {
                  state.urlDraft = ''
                  apply({ enabled: false, mode: 'url', url: '', dirDraft: '', dir: '', files: [], selected: '', localUrl: '', clarity: 60, dim: 0.2, blur: 0, crop: { fx: 0, fy: 0, fw: 1, fh: 1 }, error: '' })
                },
              }, '恢复默认'),
            ]),
            state.error && h('div', { className: 'dshbg-status' }, state.error),
          ])
        },
      ))
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
