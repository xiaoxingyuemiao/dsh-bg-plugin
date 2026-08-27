// DSH 自定义背景插件 —— Client 半边（pkg-6）
// 职责：设置页（settings.section）+ Run 卡片开关（tool.view.cordis）；
//       应用背景 = theme.overrideTokens 半透明表面 + styles.insert 固定图片层；
//       设置面板（[role="dialog"][aria-modal="true"]）恢复原始色值，不跟随背景。
// 运行环境：DSH Cordis 动态插件 Client 沙箱（plain JS + React.createElement，无 JSX）。
return {
  async apply(ctx) {
    const h = React.createElement

    const state = {
      enabled: false, mode: 'url',
      urlDraft: '', url: '',
      dirDraft: '', dir: '', files: [], selected: '', localUrl: '',
      clarity: 60, dim: 0.2, blur: 0, busy: false, error: '',
      tokenDispose: null, styleDispose: null,
    }

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
      '.dshbg-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:4px}' +
      '.dshbg-file{text-align:left;padding:5px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.dshbg-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}' +
      '.dshbg-file[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}'

    // 设置面板原色恢复：背景启用时，面板及其内部表面保持 DSH 默认不透明色值，不跟随背景变化。
    // 色值取自设计平台基础样式（--dsw-static-neutral-bluish-*）。
    const SETTINGS_RESTORE_CSS = '[role="dialog"][aria-modal="true"]{' +
      '--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#ffffff;--dsw-specific-sidebar-fill:#f9fafb}' +
      'body[data-ds-dark-theme] [role="dialog"][aria-modal="true"]{' +
      '--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-specific-sidebar-fill:#1b1b1c}'

    const escapeCssString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const backgroundValue = () => {
      if (state.mode === 'url' && state.url.trim()) return 'url("' + escapeCssString(state.url.trim()) + '") center / cover no-repeat'
      if (state.mode === 'local' && state.localUrl) return 'url("' + escapeCssString(state.localUrl) + '") center / cover no-repeat'
      return null
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
      const bg = backgroundValue()
      if (!bg) return
      // 背景清晰度：越高表面越透明、图片越清楚；内容卡片表面略不透明保证可读
      const clarity = Math.max(0, Math.min(100, Number(state.clarity) || 0))
      const base = 0.88 - (clarity / 100) * 0.73
      const alphaBase = base.toFixed(2)
      const alphaLayer1 = Math.min(0.92, base + 0.28).toFixed(2)
      const alphaLayer2 = Math.min(0.95, base + 0.33).toFixed(2)
      const theme = ctx.get('theme')
      if (theme !== undefined) {
        state.tokenDispose = theme.overrideTokens('dsh-bg', {
          '--dsw-alias-bg-base': { light: 'rgba(255,255,255,' + alphaBase + ')', dark: 'rgba(21,21,23,' + alphaBase + ')' },
          '--dsw-alias-bg-layer-1': { light: 'rgba(255,255,255,' + alphaLayer1 + ')', dark: 'rgba(35,35,36,' + alphaLayer1 + ')' },
          '--dsw-alias-bg-layer-2': { light: 'rgba(255,255,255,' + alphaLayer2 + ')', dark: 'rgba(44,44,46,' + alphaLayer2 + ')' },
          '--dsw-specific-sidebar-fill': { light: 'rgba(249,250,251,' + alphaBase + ')', dark: 'rgba(27,27,28,' + alphaBase + ')' },
        })
      }
      const dim = Math.max(0, Math.min(0.8, Number(state.dim) || 0))
      const blur = Math.max(0, Math.min(20, Number(state.blur) || 0))
      const extras = blur > 0 ? 'filter:blur(' + blur + 'px);transform:scale(1.08);' : ''
      const css = 'body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' + extras +
        'background:linear-gradient(rgba(0,0,0,' + dim.toFixed(2) + '),rgba(0,0,0,' + dim.toFixed(2) + ')),' + bg + ';background-attachment:fixed}' +
        SETTINGS_RESTORE_CSS
      state.styleDispose = styles.insert(css)
    }

    ctx.effect(() => () => disposeLayers())
    ctx.effect(() => styles.insert(UI_CSS))

    const slots = ctx.get('slots')
    if (slots === undefined) return

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'dsh-bg', order: 5, label: '背景' },
      function BackgroundSettings() {
        const [tick, setTick] = React.useState(0)
        const refresh = () => setTick((t) => t + 1)
        const patch = (p) => { Object.assign(state, p); refresh() }
        const apply = (p) => { Object.assign(state, p); refresh(); applyBackground() }

        const loadDir = async (dir) => {
          const target = String(dir || '').trim()
          if (!target) { patch({ error: '请输入或选择文件夹路径' }); return }
          patch({ busy: true, error: '', dirDraft: target, dir: target, files: [], selected: '' })
          try {
            const res = await host.call('list-images', { dir: target })
            if (res && res.ok === true && Array.isArray(res.images)) {
              patch({ dir: target, files: res.images, selected: '', busy: false })
              if (res.images.length === 0) patch({ error: '该文件夹中没有支持的图片（png/jpg/gif/webp/bmp/avif/svg）' })
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

        const pickFile = async (name) => {
          patch({ busy: true, error: '' })
          try {
            const res = await host.call('set-image', { dir: state.dir, name })
            if (res && res.ok === true && typeof res.url === 'string') {
              patch({ selected: name, localUrl: res.url, busy: false })
              applyBackground()
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

        return h('div', { className: 'dshbg-page' }, [
          h('div', { className: 'dshbg-title' }, '自定义背景'),
          h('div', { className: 'dshbg-desc' }, '为 DSH 应用自定义图片作为背景：图片铺在应用底层，界面表面变为半透明叠加在其上；设置面板保持原本外观。设置仅对当前页面会话生效，刷新页面或停用插件后恢复。'),
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
                apply({ enabled: false, mode: 'url', url: '', dirDraft: '', dir: '', files: [], selected: '', localUrl: '', clarity: 60, dim: 0.2, blur: 0, error: '' })
              },
            }, '恢复默认'),
          ]),
          state.error && h('div', { className: 'dshbg-status' }, state.error),
        ])
      },
    ))

    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      function BackgroundToggle() {
        const [tick, setTick] = React.useState(0)
        const refresh = () => setTick((t) => t + 1)
        const toggle = () => { state.enabled = !state.enabled; refresh(); applyBackground() }
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0' } }, [
          h('span', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-state-business-primary)' } }, '自定义背景'),
          h('button', {
            onClick: toggle,
            style: {
              padding: '4px 12px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)',
              background: state.enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-1)',
              color: state.enabled ? '#fff' : 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer', fontSize: 12,
            },
          }, state.enabled ? '已启用 · 点击关闭' : '已禁用 · 点击启用'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-caption)' } }, '详细设置见 设置 → 背景'),
        ])
      },
    ))
  },
}
