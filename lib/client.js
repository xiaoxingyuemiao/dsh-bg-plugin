// dsh-bg-plugin —— Client 半边（静态安装版）
// 运行环境：浏览器。必须通过 __ModuleLoader__.load({ id, factory }) 注册工厂，
// 否则模块表在启动时抛 "bundle loaded without registering ... via __ModuleLoader__.load"。
// id 必须等于行的 name（即包名 dsh-bg-plugin）；factory(require) 的返回值即模块导出。
// 与动态版差异：无 host/styles 内置 —— API 走 fetch('/dsh-bg/api/...')，
// 样式用 document.createElement('style') 注入；不注册 tool.view.cordis（动态专属座位）。
// 功能：背景图片 + 框选展示区域（crop 以图片分数存储，随 /state 持久化）。
// 功能：背景图片（CSS 背景 + 框选展示区域）/ 背景视频（真实 <video> 元素，等比 cover 铺满，不裁剪）。
window.__ModuleLoader__.load({
  id: 'dsh-bg-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'dsh-bg-plugin'
    const inject = ['slots', 'theme']

    const VIDEO_EXTS = { mp4: true, m4v: true, webm: true, ogv: true, ogg: true, mov: true, mkv: true }

    // 按扩展名猜测媒体类型（URL 模式用；本地模式以 Host 返回的 kind 为准）
    function guessKind(nameOrUrl) {
      const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(nameOrUrl || ''))
      return m && VIDEO_EXTS[m[1].toLowerCase()] ? 'video' : 'image'
    }

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

    // 悬浮球设置归一化：旧版宿主的 /orb 视图没有 crop（也没有 metrics），
    // 直接读 state.orb.crop.fx 会抛异常把整个设置页渲染搞崩，所以统一补齐字段。
    function normalizeOrbView(raw) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
      return {
        enabled: src.enabled === true,
        mode: src.mode === 'url' ? 'url' : 'local',
        kind: src.kind === 'video' ? 'video' : 'image',
        url: typeof src.url === 'string' ? src.url : '',
        dir: typeof src.dir === 'string' ? src.dir : '',
        name: typeof src.name === 'string' ? src.name : '',
        clarity: Math.max(0, Math.min(100, num(src.clarity, 60))),
        crop: clampCrop(src.crop),
        version: Math.max(0, num(src.version, 0)),
      }
    }

    async function apply(ctx) {
      const h = React.createElement
      const slots = ctx.slots
      const theme = ctx.theme

      const state = {
        tab: 'app', // 'app' | 'orb'
        enabled: false, mode: 'url', kind: 'image',
        urlDraft: '', url: '',
        dirDraft: '', dir: '', files: [], selected: '', localUrl: '',
        clarity: 60,
        crop: { fx: 0, fy: 0, fw: 1, fh: 1 },
        // 悬浮球背景（独立分区；首次进入「悬浮球」页时从 /orb/status 拉取）
        orb: { enabled: false, mode: 'local', kind: 'image', url: '', dir: '', name: '', clarity: 60, crop: { fx: 0, fy: 0, fw: 1, fh: 1 } },
        busy: false, error: '',
        tokenDispose: null, styleDispose: null,
      }
      let naturalSize = null // 当前图片原始尺寸 {w,h}，用于裁切换算
      let videoEl = null // 当前注入的背景视频元素
      let mediaPath = '/dsh-bg/api/media' // 媒体路由（旧版 Host 回退到 /img）

      // 从 Host 恢复持久化状态（$DSH_HOME/.dsh-bg-state.json）
      try {
        const res = await apiGet('/dsh-bg/api/state')
        if (res && res.ok === true && res.state && typeof res.state === 'object') {
          const s = res.state
          // 版本探测：旧版 Host 的 /state 没有 kind 字段，此时媒体路由仍是 /img
          if (typeof s.kind !== 'string') mediaPath = '/dsh-bg/api/img'
          if (typeof s.enabled === 'boolean') state.enabled = s.enabled
          if (s.mode === 'url' || s.mode === 'local') state.mode = s.mode
          if (s.kind === 'image' || s.kind === 'video') state.kind = s.kind
          if (typeof s.url === 'string') state.url = s.url
          if (typeof s.dir === 'string') { state.dir = s.dir; state.dirDraft = s.dir }
          if (typeof s.name === 'string' && s.name) {
            state.selected = s.name
            if (state.mode === 'local') state.kind = guessKind(s.name)
          }
          if (typeof s.clarity === 'number') state.clarity = Math.max(0, Math.min(100, s.clarity))
          if (s.crop !== undefined) state.crop = clampCrop(s.crop)
          if (state.mode === 'local' && state.selected) state.localUrl = mediaPath + '?v=' + Date.now()
          if (state.mode === 'url' && state.url) state.kind = guessKind(state.url)
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
        '.dshbg-badge{color:var(--dsw-alias-label-caption,#81858c);font-size:11px}' +
        // —— 顶部 Tab 与卡片 ——
        '.dshbg-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:0}' +
        '.dshbg-tab{padding:7px 16px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px}' +
        '.dshbg-tab:hover{color:var(--dsw-alias-label-primary)}' +
        '.dshbg-tab[data-active]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}' +
        '.dshbg-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}' +
        '.dshbg-cardtitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
        '.dshbg-code{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.06));border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;user-select:text}' +
        '.dshbg-link{color:var(--dsw-alias-brand-primary);font-size:12px;word-break:break-all}' +
        // —— 背景视频层：真实 <video> 元素，等比 cover 铺满（最底层，应用表面之上）——
        '.dshbg-videobg{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;object-position:center;z-index:-2;pointer-events:none;background:#000}' +
        // —— 预览与框选 ——
        '.dshbg-preview{position:relative;display:flex;flex-direction:column;gap:8px;align-items:center}' +
        '.dshbg-previewbox{position:relative;display:inline-block;max-width:100%;max-height:260px;cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:repeating-conic-gradient(#0000000f 0 25%,transparent 0 50%) 50%/14px 14px}' +
        '.dshbg-previewimg{display:block;max-width:100%;max-height:260px;pointer-events:none;border-radius:8px}' +
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
          // 原图尺寸未知时先按 cover 铺满（若用 auto 会按图片原始像素绘制 → 看起来"没铺满"）；
          // 尺寸量到之后会重新应用，届时改用精确的裁切公式。
          return { bg: q, size: 'cover', pos: 'center' }
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
        // 注意：只能给「单层」值。写成 'auto, Sx Sy' 时第一个逗号值(auto)会作用到那唯一一张图上，
        // 图片就按原始像素绘制 → 看起来没铺满（这是早期"渐变+图片"两层设计的残留）。
        return { bg: q, size: Sx + ' ' + Sy, pos: Px + ' ' + Py }
      }

      // —— 背景视频元素（真实 <video>，等比 cover 铺满，不裁剪不拉伸）——
      const removeVideo = () => {
        if (videoEl === null) return
        try {
          videoEl.pause()
          videoEl.removeAttribute('src')
          videoEl.load()
          videoEl.remove()
        } catch (err) { /* noop */ }
        videoEl = null
      }

      const ensureVideo = (src) => {
        if (videoEl !== null && videoEl.dataset.src === src) {
          if (videoEl.paused) {
            const p = videoEl.play()
            if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦截时静默 */ })
          }
          return
        }
        removeVideo()
        const v = document.createElement('video')
        v.className = 'dshbg-videobg'
        v.dataset.src = src
        v.muted = true
        v.defaultMuted = true
        v.loop = true
        v.autoplay = true
        v.playsInline = true
        v.setAttribute('playsinline', '')
        v.setAttribute('webkit-playsinline', '')
        v.setAttribute('aria-hidden', 'true')
        v.setAttribute('disablepictureinpicture', '')
        v.preload = 'auto'
        v.src = src
        document.body.appendChild(v)
        videoEl = v
        const p = v.play()
        if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦截时静默 */ })
      }

      const disposeLayers = () => {
        if (state.tokenDispose) { try { state.tokenDispose() } catch (e) { /* noop */ } }
        if (state.styleDispose) { try { state.styleDispose() } catch (e) { /* noop */ } }
        state.tokenDispose = null
        state.styleDispose = null
        removeVideo()
      }

      const applyBackground = () => {
        disposeLayers()
        if (!state.enabled) return
        const src = backgroundSrc()
        if (!src) return
        // 背景清晰度：越高表面越透明、媒体越清楚；清晰度 100% 时表面完全透明（背景不再蒙一层白）。
        // 四类面板（底色 / 层1 / 层2 / 侧栏）统一使用同一个 alpha，保证各板块透明度一致。
        const clarity = Math.max(0, Math.min(100, Number(state.clarity) || 0))
        const t = clarity / 100
        const alpha = (0.88 * (1 - t)).toFixed(3)
        state.tokenDispose = theme.overrideTokens('dsh-bg-plugin', {
          '--dsw-alias-bg-base': { light: 'rgba(255,255,255,' + alpha + ')', dark: 'rgba(21,21,23,' + alpha + ')' },
          '--dsw-alias-bg-layer-1': { light: 'rgba(255,255,255,' + alpha + ')', dark: 'rgba(35,35,36,' + alpha + ')' },
          '--dsw-alias-bg-layer-2': { light: 'rgba(255,255,255,' + alpha + ')', dark: 'rgba(44,44,46,' + alpha + ')' },
          '--dsw-specific-sidebar-fill': { light: 'rgba(249,250,251,' + alpha + ')', dark: 'rgba(27,27,28,' + alpha + ')' },
        })
        // 页面根节点的底色也要让出来，否则某些布局会在图片上再盖一层不透明底色
        const BASE_CSS = 'html,body{background:transparent !important}'
        if (state.kind === 'video') {
          // 视频：<video> 层等比 cover 铺满（不裁剪、不拉伸）
          ensureVideo(src)
          const css = 'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;}' +
            BASE_CSS + SETTINGS_RESTORE_CSS
          state.styleDispose = insertCss(css)
          return
        }
        removeVideo()
        const imgCss = buildImageCss(src, naturalSize)
        const css = 'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' +
          'background-image:' + imgCss.bg + ';' +
          'background-repeat:no-repeat;' +
          'background-size:' + imgCss.size + ';' +
          'background-position:' + imgCss.pos + ';' +
          'background-attachment:fixed;}' +
          BASE_CSS + SETTINGS_RESTORE_CSS
        state.styleDispose = insertCss(css)
      }

      const persist = () => {
        // 持久化 UI 状态到 Host（$DSH_HOME/.dsh-bg-state.json）
        apiCall('/dsh-bg/api/state', {
          enabled: state.enabled,
          mode: state.mode,
          kind: state.kind,
          url: state.url,
          dir: state.dir,
          name: state.selected,
          clarity: state.clarity,
          crop: state.crop,
        }).catch(() => { /* 保存失败不打断交互 */ })
      }

      ctx.effect(() => () => disposeLayers())
      ctx.effect(() => insertCss(UI_CSS))

      // —— 错误边界：本插件 UI 抛异常时只显示一行提示，不再拖垮整个设置页 ——
      const ReactBase = React && React.Component ? React.Component : class {}
      class BgErrorBoundary extends ReactBase {
        constructor(props) {
          super(props)
          this.state = { err: null }
        }
        static getDerivedStateFromError(err) {
          return { err }
        }
        componentDidCatch(err) {
          try { console.error('dsh-bg-plugin: 设置页渲染失败', err) } catch (e) { /* noop */ }
        }
        render() {
          if (this.state.err !== null) {
            return h('div', { className: 'dshbg-col' }, [
              h('div', { className: 'dshbg-status' }, '背景设置出错：' + String((this.state.err && this.state.err.message) || this.state.err)),
              h('div', { className: 'dshbg-hint' }, '刷新页面（Ctrl+R）即可恢复；若持续出现请把这行信息反馈给插件作者。'),
            ])
          }
          return this.props && this.props.children ? this.props.children : null
        }
      }

      // 恢复持久化状态后自动重应用背景（若上次是启用状态）
      if (state.enabled) {
        const measureSrc = state.mode === 'url' ? state.url.trim() : state.localUrl
        if (state.kind === 'image' && typeof measureSrc === 'string' && measureSrc !== '') {
          // 先用 cover 铺满（此时还没有原图尺寸），随后量出尺寸再按裁切公式重画。
          // 否则会走"原图尺寸未知"的分支，图片按原始像素绘制 → 看起来没铺满/不是全屏。
          applyBackground()
          const probe = new Image()
          probe.onload = () => {
            if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
              naturalSize = { w: probe.naturalWidth, h: probe.naturalHeight }
            }
            applyBackground()
          }
          probe.onerror = () => { applyBackground() }
          probe.src = measureSrc
        } else {
          applyBackground()
        }
      }

      function BackgroundSettings() {
          const [tick, setTick] = React.useState(0)
          const boxRef = React.useRef(null)
          const dragRef = React.useRef(null)
          const dragTimerRef = React.useRef(null)
          const refresh = () => setTick((t) => t + 1)
          const patch = (p) => { Object.assign(state, p); refresh() }
          const apply = (p) => { Object.assign(state, p); refresh(); applyBackground(); persist() }

          const previewSrc = state.mode === 'url' ? state.url.trim() : (state.mode === 'local' ? state.localUrl : '')
          const isVideo = state.kind === 'video'

          // 加载当前图片的原始尺寸（裁切换算需要；视频跳过）
          React.useEffect(() => {
            if (!previewSrc || isVideo) { naturalSize = null; return }
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
          }, [previewSrc, isVideo])

          const loadDir = async (dir) => {
            const target = String(dir || '').trim()
            if (!target) { patch({ error: '请输入或选择文件夹路径' }); return }
            patch({ busy: true, error: '', dirDraft: target, dir: target, files: [], selected: '' })
            try {
              const res = await apiCall('/dsh-bg/api/list', { dir: target })
              // 兼容层：新版返回 files（含 kind），旧版 Host 只返回 images
              const raw = res && res.ok === true
                ? (Array.isArray(res.files) ? res.files : (Array.isArray(res.images) ? res.images : null))
                : null
              const list = raw === null
                ? null
                : raw.map((f) => ({
                  name: String(f.name),
                  size: typeof f.size === 'number' ? f.size : 0,
                  kind: f.kind === 'video' ? 'video' : 'image',
                })).sort((a, b) =>
                  String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }))
              if (list !== null) {
                patch({ dir: target, files: list, selected: '', busy: false })
                if (list.length === 0) patch({ error: '该文件夹中没有支持的图片或视频（png/jpg/gif/webp/bmp/avif/svg/mp4/webm/ogv/mov）' })
              } else {
                patch({ busy: false, error: (res && res.error) || '读取文件夹失败' })
              }
            } catch (err) {
              let msg = '读取文件夹失败'
              try { if (err && typeof err.message === 'string' && err.message) msg = msg + '：' + err.message } catch (e) { /* noop */ }
              patch({ busy: false, error: msg })
            }
          }

          // 目录选择：
          //   1) 先让宿主自己弹系统对话框（桌面端 DSH 没注册目录选择能力，这条最可靠）
          //   2) 再退回 DSH 客户端服务：uiWorkspace / workspaces / remote.directoryPicker
          const dirPickers = () => {
            const svc = (name) => {
              try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch (e) { return undefined }
            }
            const out = []
            const uw = svc('uiWorkspace')
            if (uw && typeof uw.pickDirectory === 'function') out.push(() => uw.pickDirectory())
            const ws = svc('workspaces')
            if (ws && typeof ws.pickDirectory === 'function') out.push(() => ws.pickDirectory())
            const remote = svc('remote')
            const dp = remote && remote.directoryPicker
            if (dp && typeof dp.pick === 'function') out.push(() => dp.pick(new AbortController().signal))
            return out
          }

          const pickDir = async () => {
            patch({ busy: true, error: '' })
            const trace = (text) => { apiCall('/dsh-bg/api/log', { text }).catch(() => { /* noop */ }) }
            trace('clicked 选择文件夹')
            // 1) 宿主自己弹系统对话框（桌面端唯一可靠的路径）
            let hostRes = null
            let hostMissing = false
            try {
              hostRes = await apiCall('/dsh-bg/api/pick-folder', {})
              trace('host replied: ' + JSON.stringify(hostRes).slice(0, 200))
            } catch (err) {
              hostMissing = true // 多为宿主还是旧版（没有该路由）
              trace('host route missing: ' + (err && err.message ? err.message : String(err)))
            }
            if (hostRes !== null && hostRes.ok === true && typeof hostRes.dir === 'string' && hostRes.dir !== '') {
              await loadDir(hostRes.dir)
              return
            }
            if (hostRes !== null && hostRes.cancelled === true) {
              patch({ busy: false, error: '未选择文件夹' })
              return
            }

            // 2) 回退 DSH 客户端目录选择服务；带超时，避免它不返回时界面毫无反馈
            const withTimeout = (promise, ms) => Promise.race([
              promise,
              new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('等待目录选择超时')), ms)
                Promise.resolve(promise).then(
                  (v) => { clearTimeout(timer); resolve(v) },
                  (e) => { clearTimeout(timer); reject(e) },
                )
              }),
            ])
            let lastErr = null
            for (const pick of dirPickers()) {
              try {
                const dir = await withTimeout(pick(), 20000)
                if (!dir) { patch({ busy: false, error: '未选择文件夹' }); return }
                await loadDir(dir)
                return
              } catch (err) {
                lastErr = err
              }
            }
            const detail = hostMissing
              ? '宿主还没有该接口（重启 DSH 后生效）'
              : ((hostRes && hostRes.error) || (lastErr && lastErr.message) || '系统对话框不可用')
            patch({ busy: false, error: '选择文件夹失败：' + detail + '。可把文件夹路径粘贴到上方输入框' })
          }

          const pickFile = async (file) => {
            patch({ busy: true, error: '' })
            try {
              const res = await apiCall('/dsh-bg/api/set', { dir: state.dir, name: file.name })
              if (res && res.ok === true && typeof res.url === 'string') {
                patch({
                  selected: file.name,
                  localUrl: res.url,
                  kind: res.kind === 'video' ? 'video' : 'image',
                  busy: false,
                })
                applyBackground()
                persist()
              } else {
                patch({ busy: false, error: (res && res.error) || '设置背景失败' })
              }
            } catch (err) {
              let msg = '设置背景失败'
              try { if (err && typeof err.message === 'string' && err.message) msg = msg + '：' + err.message } catch (e) { /* noop */ }
              patch({ busy: false, error: msg })
            }
          }

          const applyUrl = () => {
            const target = state.urlDraft.trim()
            if (!target) { patch({ error: '请输入图片或视频 URL' }); return }
            apply({ url: target, kind: guessKind(target), error: '' })
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

          // —— 悬浮球页：补丁（写文件前弹窗确认 + 自动备份 + 可还原）+ 背景设置 + 双向同步 ——
          const [orbStatus, setOrbStatus] = React.useState(null)
          const [orbNote, setOrbNote] = React.useState('')
          const [orbTick, setOrbTick] = React.useState(0)
          const [orbUrlDraft, setOrbUrlDraft] = React.useState('')

          React.useEffect(() => {
            if (state.tab !== 'orb') return
            let cancelled = false
            setOrbStatus(null)
            apiGet('/dsh-bg/api/orb/status')
              .then((res) => {
                if (cancelled) return
                setOrbStatus(res && res.ok === true ? res : { ok: false })
                if (res && res.ok === true && res.orb && typeof res.orb === 'object') state.orb = normalizeOrbView(res.orb)
              })
              .catch(() => { if (!cancelled) setOrbStatus({ ok: false }) })
            return () => { cancelled = true }
          }, [state.tab, orbTick])

          const ORB_REPO = 'https://github.com/mini-yifan/dsh-orb-cordis'
          const ORB_TGZ = 'https://github.com/mini-yifan/dsh-orb-cordis/releases/download/plugin-v0.1.0/dsh-orb-0.1.0.tgz'
          const ORB_CMD = '& "<DSH 安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add ' + ORB_TGZ

          const copyText = (text) => {
            try {
              if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(
                  () => setOrbNote('已复制到剪贴板'),
                  () => setOrbNote('复制失败，请手动选择文本'),
                )
                return
              }
            } catch (err) { /* noop */ }
            setOrbNote('复制不可用，请手动选择文本')
          }

          const orbSaveTimerRef = React.useRef(null)
          const saveOrb = (patchObj) => {
            if (patchObj) Object.assign(state.orb, patchObj)
            refresh()
            // 拖动框选会高频触发，落盘/上报做 200ms 去抖
            if (orbSaveTimerRef.current) clearTimeout(orbSaveTimerRef.current)
            orbSaveTimerRef.current = setTimeout(() => {
              orbSaveTimerRef.current = null
              apiCall('/dsh-bg/api/orb', state.orb).catch(() => { /* noop */ })
            }, 200)
          }

          // —— 悬浮球框选：比例锁死为面板比例（320×420 一类），避免铺到面板里变形 ——
          const [orbNat, setOrbNat] = React.useState(null)
          const orbDragRef = React.useRef(null)

          const orbPanelAspect = () => {
            const a = orbStatus && orbStatus.metrics ? Number(orbStatus.metrics.aspect) : NaN
            return Number.isFinite(a) && a > 0.05 ? a : 320 / 420
          }
          // 给定宽度分数 → 保持面板比例所需的高度分数
          const orbFhFor = (fw) => {
            const nat = orbNat
            if (!nat || !nat.w || !nat.h) return fw
            return Math.min(1, (fw * nat.w) / (nat.h * orbPanelAspect()))
          }
          // 宽度上限：高度不超过图片
          const orbFwMax = () => {
            const nat = orbNat
            if (!nat || !nat.w || !nat.h) return 1
            return Math.min(1, (nat.h * orbPanelAspect()) / nat.w)
          }
          const orbFracFrom = (e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            return {
              x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
              y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
            }
          }
          const orbResetCrop = () => {
            const fw = orbFwMax()
            const fh = orbFhFor(fw)
            saveOrb({
              crop: {
                fx: Math.max(0, (1 - fw) / 2),
                fy: Math.max(0, (1 - fh) / 2),
                fw,
                fh,
              },
            })
          }
          const orbCropIsFull = () => {
            const c = state.orb.crop || { fx: 0, fy: 0, fw: 1, fh: 1 }
            return c.fx <= 0.001 && c.fy <= 0.001 && c.fw >= 0.999 && c.fh >= 0.999
          }
          /** 悬浮球当前媒体的预览地址（本地走 /media/orb，远程用原 URL）。 */
          const orbPreviewSrc = () => {
            const o = state.orb
            if (o.mode === 'local') {
              return o.name === '' ? '' : '/dsh-bg/api/media/orb?v=' + String(o.version || 0)
            }
            return (o.url || '').trim()
          }
          /** 面板尺寸标签（来自 patched 助手实测，未实测时用默认值）。 */
          const orbPanelWidthLabel = () => {
            const m = orbStatus && orbStatus.metrics ? orbStatus.metrics : null
            return m && m.panelW && m.panelH ? (m.panelW + '×' + m.panelH) : '320×420'
          }

          const reloadOrb = () => setOrbTick((t) => t + 1)

          // 待确认动作（页面内确认，不用 window.confirm——Electron 里那是窗口级原生模态，
          // 万一弹在看不见的位置会让整个窗口像卡死一样"点不动"）
          const [pending, setPending] = React.useState(null)

          const applyOrbPatch = async () => {
            setPending(null)
            setOrbNote('正在写入补丁…')
            try {
              const res = await apiCall('/dsh-bg/api/orb/patch', {})
              if (res && res.ok === true) {
                setOrbNote(res.alreadyPatched === true ? '补丁已存在' : '已写入补丁（原文件已备份）——重启 DSH 后生效')
                reloadOrb()
              } else {
                setOrbNote('写入失败：' + ((res && res.error) || '未知错误'))
              }
            } catch (err) {
              setOrbNote('写入失败：' + (err && err.message ? err.message : String(err)))
            }
          }

          const revertOrbPatch = async () => {
            setPending(null)
            setOrbNote('正在还原…')
            try {
              const res = await apiCall('/dsh-bg/api/orb/unpatch', {})
              setOrbNote(res && res.ok === true ? '已还原（重启 DSH 后生效）' : '还原失败：' + ((res && res.error) || '未知错误'))
              reloadOrb()
            } catch (err) {
              setOrbNote('还原失败：' + (err && err.message ? err.message : String(err)))
            }
          }

          const syncOrb = async (from) => {
            setOrbNote('正在同步…')
            try {
              const res = await apiCall('/dsh-bg/api/sync', { from })
              if (res && res.ok === true) {
                if (res.orb) state.orb = normalizeOrbView(res.orb)
                applyBackground()
                setOrbNote(from === 'app' ? '已把主应用背景同步到悬浮球' : '已把悬浮球背景同步到主应用')
                refresh()
              } else {
                setOrbNote('同步失败：' + ((res && res.error) || '未知错误'))
              }
            } catch (err) {
              setOrbNote('同步失败：' + (err && err.message ? err.message : String(err)))
            }
          }

          const pickOrbFile = async (file) => {
            setOrbNote('正在设置悬浮球媒体…')
            try {
              const res = await apiCall('/dsh-bg/api/orb/set', { dir: state.dir, name: file.name })
              if (res && res.ok === true) {
                saveOrb({ mode: 'local', kind: res.kind === 'video' ? 'video' : 'image', dir: state.dir, name: file.name, url: '', enabled: true })
                setOrbNote('悬浮球已使用：' + file.name)
              } else {
                setOrbNote('设置失败：' + ((res && res.error) || '未知错误'))
              }
            } catch (err) {
              setOrbNote('设置失败：' + (err && err.message ? err.message : String(err)))
            }
          }

          const orbPanel = () => {
            const installed = orbStatus !== null && orbStatus.installed === true
            const running = orbStatus !== null && orbStatus.running === true
            const patched = orbStatus !== null && orbStatus.patched === true
            const o = normalizeOrbView(state.orb)
            const oc = o.crop
            const rows = []

            // 页面内确认条（替代 window.confirm）
            if (pending !== null) {
              rows.push(h('div', { className: 'dshbg-card', key: 'confirm' }, [
                h('div', { className: 'dshbg-cardtitle' }, pending.title),
                h('div', { className: 'dshbg-hint' }, pending.detail),
                h('div', { className: 'dshbg-row' }, [
                  h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => { pending.run() } }, '确认继续'),
                  h('button', { className: 'dshbg-btn', onClick: () => { setPending(null); setOrbNote('已取消') } }, '取消'),
                ]),
              ]))
            }

            rows.push(h('div', { className: 'dshbg-card', key: 'status' }, [
              h('div', { className: 'dshbg-cardtitle' },
                orbStatus === null
                  ? '正在检测悬浮球…'
                  : (!installed
                    ? '未检测到悬浮球'
                    : (running ? (patched ? '悬浮球：已启用背景支持（运行中）' : '悬浮球：已安装并运行（尚未启用背景支持）') : '悬浮球：已安装，当前未运行'))),
              h('div', { className: 'dshbg-hint' }, !installed
                ? '悬浮球（dsh-orb-cordis）是独立的 DSH 插件，需要装进同一个 profile 并重启 DSH 才会出现。'
                : (running
                  ? '检测到它在运行：可一键写入背景支持（会先备份，可撤销）。'
                  : '已安装但端点没响应——通常是装好后还没重启 DSH。')),
              h('div', { className: 'dshbg-row' }, [
                h('button', { className: 'dshbg-btn', onClick: reloadOrb }, '重新检测'),
                h('button', { className: 'dshbg-btn', onClick: () => copyText(ORB_REPO) }, '复制仓库链接'),
                orbNote && h('span', { className: 'dshbg-hint' }, orbNote),
              ]),
            ]))

            if (!installed) {
              rows.push(h('div', { className: 'dshbg-card', key: 'install' }, [
                h('div', { className: 'dshbg-cardtitle' }, '安装悬浮球'),
                h('div', { className: 'dshbg-hint' }, '在 DSH 所在机器上执行（桌面端请用它自带的 CLI）：'),
                h('pre', { className: 'dshbg-code' }, ORB_CMD),
                h('div', { className: 'dshbg-row' }, [
                  h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => copyText(ORB_CMD) }, '复制安装命令'),
                  h('a', { className: 'dshbg-link', href: ORB_REPO, target: '_blank', rel: 'noreferrer' }, ORB_REPO),
                ]),
                h('div', { className: 'dshbg-hint' }, '安装后需要重启 DSH 才会加载（重启会中断当前会话，但会话可恢复）。'),
              ]))
            }

            if (installed && !patched) {
              rows.push(h('div', { className: 'dshbg-card', key: 'patch' }, [
                h('div', { className: 'dshbg-cardtitle' }, '启用悬浮球背景支持'),
                h('div', { className: 'dshbg-hint' }, '点击后**首次会弹窗确认**；同意即写入补丁（覆盖悬浮球 2 个文件，写入前完整备份），随后可用「撤销补丁」还原。'),
                h('div', { className: 'dshbg-row' }, [
                  h('button', {
                    className: 'dshbg-btn dshbg-primary',
                    onClick: () => setPending({
                      title: '为悬浮球添加「展开面板背景」支持？',
                      detail: '会覆盖悬浮球的 2 个文件（floating.html 放宽 CSP、main.js 注入背景控制器）；写入前自动完整备份，可随时「撤销补丁」还原。需要重启 DSH 才生效。',
                      run: applyOrbPatch,
                    }),
                  }, '启用（先确认）'),
                ]),
              ]))
            }

            const patchOutdated = patched && orbStatus.patchVersion !== null && orbStatus.patchVersion < (orbStatus.patchLatest || 0)
            if (patchOutdated) {
              rows.push(h('div', { className: 'dshbg-card', key: 'patch-update' }, [
                h('div', { className: 'dshbg-cardtitle' }, '补丁可更新（v' + orbStatus.patchVersion + ' → v' + orbStatus.patchLatest + '）'),
                h('div', { className: 'dshbg-hint' }, '新版补丁让背景层被裁在面板圆角框内（随面板缩放动画一起动），并支持按面板比例框选。更新会先从备份还原原文件再写入。'),
                h('div', { className: 'dshbg-row' }, [
                  h('button', {
                    className: 'dshbg-btn dshbg-primary',
                    onClick: () => setPending({
                      title: '把悬浮球补丁更新到 v' + orbStatus.patchLatest + '？',
                      detail: '会先从备份还原悬浮球原文件，再写入新版（写入前仍会再备份一次）。需要重启 DSH 才生效。',
                      run: applyOrbPatch,
                    }),
                  }, '更新补丁'),
                ]),
              ]))
            }

            if (installed && patched) {
              rows.push(h('div', { className: 'dshbg-card', key: 'bg' }, [
                h('div', { className: 'dshbg-cardtitle' }, '悬浮球面板背景'),
                h('div', { className: 'dshbg-row' }, [
                  h('span', { className: 'dshbg-label' }, '启用悬浮球背景'),
                  h('button', {
                    className: 'dshbg-switch' + (o.enabled ? ' dshbg-on' : ''),
                    onClick: () => saveOrb({ enabled: !o.enabled }),
                  }, o.enabled ? '已启用' : '已禁用'),
                ]),
                h('div', { className: 'dshbg-hint' }, '当前媒体：' + (o.mode === 'local'
                  ? (o.name !== '' ? o.name + '（本地文件）' : '未选择')
                  : (o.url !== '' ? o.url : '未设置')) + '　·　' + (o.kind === 'video' ? '视频' : '图片')),
                h('div', { className: 'dshbg-row' }, [
                  h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => syncOrb('app') }, '主应用 → 悬浮球'),
                  h('button', { className: 'dshbg-btn', onClick: () => syncOrb('orb') }, '悬浮球 → 主应用'),
                ]),
                // —— 框选展示范围（比例锁死为面板比例；视频不框选）——
                // 注意：框选层是 position:absolute，必须放进 .dshbg-previewbox（position:relative），
                // 否则它会去对齐更外层的祖先、铺满整个设置面板（还会带 9999px 的压暗阴影挡住点击）。
                o.kind === 'image' && orbPreviewSrc() !== '' && h('div', { className: 'dshbg-col' }, [
                  h('div', { className: 'dshbg-label' }, '框选展示范围（比例锁定为面板 ' + orbPanelWidthLabel() + '）'),
                  h('div', { className: 'dshbg-preview' }, [
                    h('div', {
                      className: 'dshbg-previewbox',
                      onPointerDown: (e) => {
                        e.preventDefault()
                        const p = orbFracFrom(e)
                        orbDragRef.current = { mode: 'draw', ax: p.x, ay: p.y }
                        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* noop */ }
                      },
                      onPointerMove: (e) => {
                        const d = orbDragRef.current
                        if (!d) return
                        const p = orbFracFrom(e)
                        if (d.mode === 'draw') {
                          const fw = Math.max(0.05, Math.min(orbFwMax(), Math.abs(p.x - d.ax)))
                          const fh = orbFhFor(fw)
                          saveOrb({
                            crop: {
                              fx: Math.min(Math.max(0, Math.min(d.ax, p.x)), Math.max(0, 1 - fw)),
                              fy: Math.min(Math.max(0, Math.min(d.ay, p.y)), Math.max(0, 1 - fh)),
                              fw,
                              fh,
                            },
                          })
                        } else if (d.mode === 'move') {
                          const c = oc
                          saveOrb({
                            crop: {
                              fx: Math.min(Math.max(0, d.fx + (p.x - d.ax)), Math.max(0, 1 - c.fw)),
                              fy: Math.min(Math.max(0, d.fy + (p.y - d.ay)), Math.max(0, 1 - c.fh)),
                              fw: c.fw,
                              fh: c.fh,
                            },
                          })
                        }
                      },
                      onPointerUp: () => { orbDragRef.current = null },
                      onPointerCancel: () => { orbDragRef.current = null },
                    }, [
                      h('img', {
                        className: 'dshbg-previewimg',
                        src: orbPreviewSrc(),
                        draggable: false,
                        alt: '',
                        onLoad: (e) => {
                          const el = e.currentTarget
                          if (el.naturalWidth > 0 && el.naturalHeight > 0) setOrbNat({ w: el.naturalWidth, h: el.naturalHeight })
                        },
                      }),
                      h('div', {
                        className: 'dshbg-crop',
                        style: {
                          left: (oc.fx * 100) + '%',
                          top: (oc.fy * 100) + '%',
                          width: (oc.fw * 100) + '%',
                          height: (oc.fh * 100) + '%',
                          cursor: 'move',
                        },
                        onPointerDown: (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          // 分数要相对 previewbox 计算（当前 target 是选框本身）
                          const box = e.currentTarget.parentElement
                          const rect = box.getBoundingClientRect()
                          const p = {
                            x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
                            y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
                          }
                          orbDragRef.current = { mode: 'move', ax: p.x, ay: p.y, fx: oc.fx, fy: oc.fy }
                        },
                      }, [
                        h('div', { className: 'dshbg-cropcorner dshbg-crop-nw' }),
                        h('div', { className: 'dshbg-cropcorner dshbg-crop-ne' }),
                        h('div', { className: 'dshbg-cropcorner dshbg-crop-sw' }),
                        h('div', { className: 'dshbg-cropcorner dshbg-crop-se' }),
                      ]),
                    ]),
                  ]),
                  h('div', { className: 'dshbg-hint' }, '在预览图上拖动即可框选（宽高比始终等于面板比例，铺进面板不会变形）；拖动选框可平移。'),
                  h('div', { className: 'dshbg-row' }, [
                    h('button', { className: 'dshbg-btn', onClick: orbResetCrop }, '按面板比例铺满（最大框）'),
                    h('button', {
                      className: 'dshbg-btn',
                      onClick: () => saveOrb({ crop: { fx: 0, fy: 0, fw: 1, fh: 1 } }),
                      disabled: orbCropIsFull() || undefined,
                    }, '清除框选（整图 cover）'),
                    orbNat && h('span', { className: 'dshbg-badge' }, '原图 ' + orbNat.w + '×' + orbNat.h),
                  ]),
                ]),
                o.kind === 'video' && h('div', { className: 'dshbg-hint' }, '视频不框选：按原比例铺满面板（cover，不拉伸）。'),
                h('div', { className: 'dshbg-row' }, [
                  h('span', { className: 'dshbg-label' }, '面板背景清晰度 ' + o.clarity + '%'),
                  h('input', {
                    type: 'range', min: '0', max: '100', step: '5', value: o.clarity, className: 'dshbg-range',
                    onChange: (e) => saveOrb({ clarity: Number(e.target.value) }),
                  }),
                ]),
                h('div', { className: 'dshbg-row' }, [
                  h('input', {
                    className: 'dshbg-input',
                    placeholder: '粘贴图片 / 视频 URL 后点「应用」',
                    value: orbUrlDraft,
                    onChange: (e) => setOrbUrlDraft(e.target.value),
                  }),
                  h('button', {
                    className: 'dshbg-btn',
                    onClick: () => {
                      const target = orbUrlDraft.trim()
                      if (target === '') { setOrbNote('请输入 URL'); return }
                      saveOrb({ mode: 'url', url: target, kind: guessKind(target), enabled: true })
                      setOrbNote('悬浮球已使用该 URL')
                    },
                  }, '应用'),
                ]),
                state.files.length > 0 && h('div', { className: 'dshbg-col' }, [
                  h('div', { className: 'dshbg-hint' }, '以下文件列表来自你在「主应用背景」页选择的文件夹（' + state.dir + '），点击即让悬浮球使用它：'),
                  h('div', { className: 'dshbg-list' }, state.files.map((f) => h('button', {
                    key: f.name,
                    className: 'dshbg-file',
                    'data-active': o.mode === 'local' && o.name === f.name || undefined,
                    onClick: () => pickOrbFile(f),
                  }, [
                    f.name + fmtSize(f.size),
                    h('span', { className: 'dshbg-badge', key: 'badge' }, f.kind === 'video' ? '  · 视频' : ''),
                  ]))),
                ]),
                h('div', { className: 'dshbg-row' }, [
                  h('button', {
                    className: 'dshbg-btn',
                    onClick: () => setPending({
                      title: '撤销悬浮球补丁？',
                      detail: '会从备份还原悬浮球的 2 个文件（恢复原样），重启 DSH 后生效。',
                      run: revertOrbPatch,
                    }),
                  }, '撤销补丁（还原原文件）'),
                ]),
              ]))
            }

            return h('div', { className: 'dshbg-col', style: { gap: 12 } }, rows)
          }

          const cropIsFull = state.crop.fx <= 0.001 && state.crop.fy <= 0.001 && state.crop.fw >= 0.999 && state.crop.fh >= 0.999
          const c = state.crop

          return h('div', { className: 'dshbg-page' }, [
            h('div', { className: 'dshbg-title' }, '自定义背景'),
            h('div', { className: 'dshbg-desc' }, '为 DSH 应用自定义图片或视频作为背景：媒体铺在应用底层，界面表面变为半透明叠加在其上；设置面板保持原本外观。图片可框选展示区域，视频按原比例铺满屏幕。所有调整会自动保存并自动恢复。'),
            h('div', { className: 'dshbg-tabs' }, [
              ['app', '主应用背景'], ['orb', '悬浮球'],
            ].map((pair) => h('button', {
              key: pair[0],
              className: 'dshbg-tab',
              'data-active': state.tab === pair[0] || undefined,
              onClick: () => { state.tab = pair[0]; refresh() },
            }, pair[1]))),
            state.tab === 'app' && h('div', { className: 'dshbg-col', style: { gap: 12 } }, [
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '启用自定义背景'),
              h('button', { className: 'dshbg-switch' + (state.enabled ? ' dshbg-on' : ''), onClick: () => apply({ enabled: !state.enabled }) },
                state.enabled ? '已启用' : '已禁用'),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '媒体来源'),
              h('div', { className: 'dshbg-seg' }, [
                ['url', '图片 / 视频 URL'], ['local', '本地文件'],
              ].map((pair) => h('button', {
                key: pair[0],
                className: 'dshbg-segbtn',
                'data-active': state.mode === pair[0] || undefined,
                onClick: () => apply({ mode: pair[0], error: '' }),
              }, pair[1]))),
            ]),
            state.mode === 'url' && h('div', { className: 'dshbg-col' }, [
              h('div', { className: 'dshbg-row' }, [
                h('input', { className: 'dshbg-input', placeholder: 'https://example.com/wallpaper.jpg 或 .mp4', value: state.urlDraft, onChange: (e) => patch({ urlDraft: e.target.value }) }),
                h('button', { className: 'dshbg-btn dshbg-primary', onClick: applyUrl }, '应用'),
              ]),
              state.url && h('div', { className: 'dshbg-hint' }, '当前' + (isVideo ? '视频' : '图片') + '：' + state.url),
            ]),
            state.mode === 'local' && h('div', { className: 'dshbg-col' }, [
              h('div', { className: 'dshbg-row' }, [
                h('input', { className: 'dshbg-input', placeholder: '例如 D:\\壁纸 或 C:\\Users\\你\\Pictures', value: state.dirDraft, onChange: (e) => patch({ dirDraft: e.target.value }) }),
              ]),
              h('div', { className: 'dshbg-row' }, [
                h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => loadDir(state.dirDraft), disabled: state.busy || undefined }, '列出文件'),
                h('button', { className: 'dshbg-btn', onClick: pickDir, disabled: state.busy || undefined }, '选择文件夹'),
              ]),
              // 错误提示紧跟按钮，避免要往下翻才看得到
              state.error && h('div', { className: 'dshbg-status' }, state.error),
              state.files.length > 0 && h('div', { className: 'dshbg-list' }, state.files.map((f) => h('button', {
                key: f.name,
                className: 'dshbg-file',
                'data-active': state.selected === f.name || undefined,
                onClick: () => pickFile(f),
              }, [
                f.name + fmtSize(f.size),
                h('span', { className: 'dshbg-badge', key: 'badge' }, f.kind === 'video' ? '  · 视频' : ''),
              ]))),
              state.selected && h('div', { className: 'dshbg-ok' }, '已应用：' + state.selected + '（' + (isVideo ? '视频' : '图片') + '），点击其他文件可切换'),
            ]),
            previewSrc && !isVideo && h('div', { className: 'dshbg-preview' }, [
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
            previewSrc && isVideo && h('div', { className: 'dshbg-preview' }, [
              h('video', {
                className: 'dshbg-previewimg',
                src: previewSrc,
                muted: true,
                loop: true,
                autoPlay: true,
                playsInline: true,
                'aria-hidden': 'true',
              }),
              h('div', { className: 'dshbg-hint' }, '视频背景按原比例铺满屏幕（自动裁掉超出部分，不拉伸、无需框选）'),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('span', { className: 'dshbg-label' }, '背景清晰度 ' + state.clarity + '%'),
              h('input', { type: 'range', min: '0', max: '100', step: '5', value: state.clarity, className: 'dshbg-range', onChange: (e) => apply({ clarity: Number(e.target.value) }) }),
            ]),
            h('div', { className: 'dshbg-row' }, [
              h('button', {
                className: 'dshbg-btn',
                onClick: () => {
                  state.urlDraft = ''
                  apply({ enabled: false, mode: 'url', kind: 'image', url: '', dirDraft: '', dir: '', files: [], selected: '', localUrl: '', clarity: 60, crop: { fx: 0, fy: 0, fw: 1, fh: 1 }, error: '' })
                },
              }, '恢复默认'),
              h('button', {
                className: 'dshbg-btn',
                onClick: () => setPending({
                  title: '用「上一份设置」覆盖当前设置？',
                  detail: '每次保存前都会自动留底一份，用于误操作后的找回；恢复成功后页面会自动重载。',
                  run: async () => {
                    setPending(null)
                    try {
                      const res = await apiCall('/dsh-bg/api/state/restore', {})
                      if (res && res.ok === true) {
                        window.location.reload()
                      } else {
                        patch({ error: '恢复失败：' + ((res && res.error) || '没有可用的上一份状态') })
                      }
                    } catch (err) {
                      patch({ error: '恢复失败：' + (err && err.message ? err.message : String(err)) })
                    }
                  },
                }),
              }, '恢复上一份设置'),
            ]),
            // 主应用页的页面内确认条（同样不用 window.confirm）
            state.tab === 'app' && pending !== null && h('div', { className: 'dshbg-card' }, [
              h('div', { className: 'dshbg-cardtitle' }, pending.title),
              h('div', { className: 'dshbg-hint' }, pending.detail),
              h('div', { className: 'dshbg-row' }, [
                h('button', { className: 'dshbg-btn dshbg-primary', onClick: () => { pending.run() } }, '确认继续'),
                h('button', { className: 'dshbg-btn', onClick: () => setPending(null) }, '取消'),
              ]),
            ]),
            ]),
            state.tab === 'orb' && orbPanel(),
          ])
      }

      // 用错误边界包一层：本插件 UI 出问题只影响这一块，不会让整个设置页点不动
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'dsh-bg', order: 5, label: '背景' },
        function BackgroundSection() {
          return h(BgErrorBoundary, null, h(BackgroundSettings))
        },
      ))
    }
    module.exports = { name, inject, apply }
    return module.exports
  },
})
