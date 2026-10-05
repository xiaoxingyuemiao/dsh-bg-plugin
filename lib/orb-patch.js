// dsh-bg-plugin —— 悬浮球（dsh-orb）面板背景补丁
// 只改它两个文件，且改动前完整备份，可一键还原：
//   1) dist/helper/assets/floating.html —— 放宽 CSP，允许本机 127.0.0.1 的图片/视频
//   2) dist/helper/lib/main.js          —— 助手主进程加一个背景控制器（轮询本插件接口并注入背景层）
// 其它文件（floating.css / shell.js / preload.cjs / 宿主）一律不动。
import fs from 'node:fs'
import path from 'node:path'

export const PATCH_MARKER = 'dsh-bg-plugin:panel-background'
export const PATCH_VERSION = 3

/** 已写入的补丁版本；未打补丁返回 null。 */
export function orbPatchVersion(paths) {
  try {
    const main = fs.readFileSync(paths.main, 'utf8')
    if (!main.includes(PATCH_MARKER)) return null
    const m = /DSH_BG_PATCH_VERSION = (\d+)/.exec(main)
    return m === null ? 0 : Number(m[1])
  } catch (err) {
    return null
  }
}

const CSP_OLD = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' dsh-app://app; img-src 'self' data:; frame-src dsh-app://app"
const CSP_NEW = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' dsh-app://app http://127.0.0.1:*; img-src 'self' data: http://127.0.0.1:*; media-src 'self' data: http://127.0.0.1:*; frame-src dsh-app://app"

const DID_FINISH_ANCHOR = /(win\.webContents\.on\("did-finish-load", \(\) => \{[\s\S]{0,200}?pushAppearance\(\);)/

/** 悬浮球两个待补丁文件的绝对路径。 */
export function orbFilePaths(orbDir) {
  return {
    html: path.join(orbDir, 'dist', 'helper', 'assets', 'floating.html'),
    main: path.join(orbDir, 'dist', 'helper', 'lib', 'main.js'),
  }
}

/** 当前 profile 下悬浮球的安装目录；未安装返回 null。 */
export function resolveOrbDir(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return null
  const dir = path.join(profileDir, 'node_modules', 'dsh-orb')
  try {
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
  } catch (err) {
    return null
  }
}

/** 是否已经打过本补丁（以 main.js 中的标记为准）。 */
export function isOrbPatched(paths) {
  try {
    const main = fs.readFileSync(paths.main, 'utf8')
    return main.includes(PATCH_MARKER)
  } catch (err) {
    return false
  }
}

/** 备份目录根：$DSH_HOME/.dsh-bg-orb-backup */
export function backupRootOf(dshHome) {
  return path.join(dshHome, '.dsh-bg-orb-backup')
}

function copyInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

/**
 * 应用补丁：先备份两个原文件，再写入补丁内容。
 * 幂等：同版本已打过直接返回 alreadyPatched；旧版本补丁会先从备份还原原文件再打新版。
 * @returns {{ ok: boolean, alreadyPatched?: boolean, upgradedFrom?: number, backupDir?: string, error?: string }}
 */
export function applyOrbPatch(paths, backupRoot) {
  try {
    const existingVersion = orbPatchVersion(paths)
    if (existingVersion === PATCH_VERSION) return { ok: true, alreadyPatched: true }
    // 已装的补丁比本宿主认识的新（例如磁盘上的补丁更新、宿主还没重启）：不动它，避免"降级"
    if (existingVersion !== null && existingVersion > PATCH_VERSION) {
      return { ok: true, alreadyPatched: true, newerThanHost: true }
    }

    let upgradedFrom
    if (existingVersion !== null) {
      // 旧版补丁：先用备份把悬浮球文件还原成原版，再打新版（备份里存的是打补丁前的内容）
      const reverted = revertOrbPatch(paths, backupRoot)
      if (reverted.ok !== true) {
        return { ok: false, error: '检测到旧版补丁，但没有可用备份可还原：' + (reverted.error || '未知错误') }
      }
      upgradedFrom = existingVersion
    }

    const htmlOld = fs.readFileSync(paths.html, 'utf8')
    const mainOld = fs.readFileSync(paths.main, 'utf8')
    if (mainOld.includes(PATCH_MARKER)) {
      return { ok: false, error: '还原后仍检测到补丁标记，已中止（未改动文件）' }
    }

    if (!htmlOld.includes(CSP_OLD) && !htmlOld.includes(CSP_NEW)) {
      return { ok: false, error: '未找到预期的 CSP 行（悬浮球版本可能不匹配）' }
    }
    if (!DID_FINISH_ANCHOR.test(mainOld)) {
      return { ok: false, error: '未找到预期的 did-finish-load 钩子（悬浮球版本可能不匹配）' }
    }
    if (!/\/\/#endregion\s*\nexport \{\};/.test(mainOld)) {
      return { ok: false, error: '未找到预期的文件尾锚点（悬浮球版本可能不匹配）' }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(backupRoot, stamp)
    copyInto(paths.html, path.join(backupDir, 'floating.html'))
    copyInto(paths.main, path.join(backupDir, 'main.js'))
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
      patchedAt: new Date().toISOString(),
      patchVersion: PATCH_VERSION,
      html: paths.html,
      main: paths.main,
    }, null, 2), 'utf8')

    const htmlNew = htmlOld.replace(CSP_OLD, CSP_NEW)
    const mainNew = mainOld
      .replace(DID_FINISH_ANCHOR, '$1\n\t\tdshBgAttach(win);')
      .replace(/\/\/#endregion\s*\nexport \{\};/, ORB_BACKGROUND_SOURCE + '\n//#endregion\nexport {};')

    fs.writeFileSync(paths.html, htmlNew, 'utf8')
    fs.writeFileSync(paths.main, mainNew, 'utf8')
    return { ok: true, backupDir, upgradedFrom }
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : String(err) }
  }
}

/** 还原：取最近一次备份写回两个文件。 */
export function revertOrbPatch(paths, backupRoot) {
  try {
    if (!fs.existsSync(backupRoot)) return { ok: false, error: '没有备份可还原' }
    const stamps = fs.readdirSync(backupRoot).filter((name) => fs.existsSync(path.join(backupRoot, name, 'manifest.json'))).sort()
    if (stamps.length === 0) return { ok: false, error: '没有备份可还原' }
    const latest = path.join(backupRoot, stamps[stamps.length - 1])
    copyInto(path.join(latest, 'floating.html'), paths.html)
    copyInto(path.join(latest, 'main.js'), paths.main)
    return { ok: true, from: latest }
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : String(err) }
  }
}

// —— 注入到助手主进程的源码：轮询本插件接口并在面板内渲染背景层 ——
const ORB_BACKGROUND_SOURCE = `//#region ${PATCH_MARKER}
/**
 * 悬浮球展开面板背景（由 dsh-bg-plugin 注入，v${PATCH_VERSION}）。
 * 配置来自 http://127.0.0.1:\${DSH_ORB_WEB_PORT}/dsh-bg/api/orb（轮询），
 * 并把实测面板比例回报给 /dsh-bg/api/orb/metrics（设置页据此按面板比例框选）。
 * 背景层留在面板自己的层叠上下文里（#panel{isolation:isolate} + z-index:-1），
 * 因此随面板缩放动画一起动、并被面板圆角裁住。
 * 本插件未安装/未启用时静默，无任何副作用。还原方式：dsh-bg-plugin 设置页的「撤销」。
 */
const DSH_BG_POLL_MS = 3000;
const DSH_BG_PATCH_VERSION = ${PATCH_VERSION};
let dshBgTimer;
let dshBgLastKey = "";
/** 生成在渲染进程里执行的背景层脚本（字符串拼接，避免嵌套模板字面量）。 */
function dshBgScript(cfg) {
  return "(() => {" +
    "const cfg = " + JSON.stringify(cfg) + ";" +
    "const ID = 'dsh-bg-layer';" +
    "const STYLE = 'dsh-bg-style';" +
    "const panel = document.getElementById('panel');" +
    "if (!panel) return;" +
    "const origin = 'http://127.0.0.1:' + String(cfg.port || '');" +
    // 面板比例上报（设置页按面板比例框选）：面板是 hidden 时量不到，所以用观察器在展开时补报
    "const report = () => {" +
    "  const r = panel.getBoundingClientRect();" +
    "  if (!(r.width > 0 && r.height > 0)) return;" +
    "  const aspect = Math.round((r.width / r.height) * 10000) / 10000;" +
    "  if (window.__dshBgAspect === aspect) return;" +
    "  window.__dshBgAspect = aspect;" +
    "  fetch(origin + '/dsh-bg/api/orb/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panelW: Math.round(r.width), panelH: Math.round(r.height), aspect: aspect }) }).catch(() => {});" +
    "};" +
    "if (window.__dshBgObserver === undefined) {" +
    "  window.__dshBgObserver = new MutationObserver(report);" +
    "  window.__dshBgObserver.observe(panel, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });" +
    "  window.addEventListener('resize', report);" +
    "}" +
    "report();" +
    "const existing = document.getElementById(ID);" +
    "if (!cfg || cfg.enabled !== true || !cfg.url) {" +
    "  if (existing) existing.remove();" +
    "  const st = document.getElementById(STYLE);" +
    "  if (st) st.remove();" +
    "  if (window.__dshBgPanelBg !== undefined) { panel.style.background = window.__dshBgPanelBg; window.__dshBgPanelBg = undefined; }" +
    "  panel.style.clipPath = '';" +
    "  panel.style.webkitClipPath = '';" +
    "  panel.style.overflow = '';" +
    "  return;" +
    "}" +
    // 关键：video/canvas 这类合成层经常"逃过"父级 overflow:hidden + border-radius 的圆角裁切
    // （四个角会露出来）。用 clip-path: inset(0 round R) 才能真正裁住，图片与视频都适用。
    "const panelRadius = getComputedStyle(panel).borderTopLeftRadius || '36px';" +
    "const panelClip = 'inset(0 round ' + panelRadius + ')';" +
    "panel.style.clipPath = panelClip;" +
    "panel.style.webkitClipPath = panelClip;" +
    // 背景层必须留在面板自己的层级里：isolation 建栈后 z-index:-1 只在面板内垫底，
    // 于是它随面板一起缩放/淡入，并被面板圆角裁住（不会溢出到面板外）。
    "if (!document.getElementById(STYLE)) {" +
    "  const st = document.createElement('style');" +
    "  st.id = STYLE;" +
    "  st.textContent = '#panel{isolation:isolate}' +" +
    "    '#dsh-bg-layer{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;z-index:-1}' +" +
    "    '#dsh-bg-layer>.m{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}' +" +
    "    '#dsh-bg-layer>.c{position:absolute;inset:0;background-repeat:no-repeat;background-color:transparent}' +" +
    "    '#dsh-bg-layer>.s{position:absolute;inset:0}';" +
    "  document.head.appendChild(st);" +
    "}" +
    "if (window.__dshBgPanelBg === undefined) {" +
    "  window.__dshBgPanelBg = panel.style.background || 'var(--white)';" +
    "  panel.style.background = 'transparent';" +
    "}" +
    "const src = /^https?:/i.test(cfg.url) ? cfg.url : origin + cfg.url;" +
    "const tint = Math.max(0, Math.min(0.95, Number(cfg.tint)));" +
    "const kind = cfg.kind === 'video' ? 'video' : 'image';" +
    "const crop = cfg.crop || { fx: 0, fy: 0, fw: 1, fh: 1 };" +
    "let layer = existing;" +
    "if (!layer) {" +
    "  layer = document.createElement('div');" +
    "  layer.id = ID;" +
    "  panel.insertBefore(layer, panel.firstChild);" +
    "}" +
    "const key = kind + '|' + src + '|' + crop.fx + ',' + crop.fy + ',' + crop.fw + ',' + crop.fh;" +
    "if (layer.dataset.key !== key) {" +
    "  layer.dataset.key = key;" +
    "  layer.textContent = '';" +
    "  let media;" +
    "  if (kind === 'video') {" +
    "    media = document.createElement('video');" +
    "    media.className = 'm';" +
    "    media.src = src;" +
    "    media.muted = true; media.loop = true; media.autoplay = true; media.setAttribute('playsinline', '');" +
    "  } else {" +
    "    const full = crop.fx <= 0.001 && crop.fy <= 0.001 && crop.fw >= 0.999 && crop.fh >= 0.999;" +
    "    media = document.createElement('div');" +
    "    media.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';" +
    "    if (full) {" +
    "      media.className = 'm';" +
    "      media.style.backgroundSize = 'cover';" +
    "      media.style.backgroundPosition = 'center';" +
    "    } else {" +
    // 按框选比例渲染：选区比例已被约束成面板比例，所以按百分比缩放不会变形
    "      media.className = 'c';" +
    "      media.style.backgroundSize = (100 / crop.fw) + '% ' + (100 / crop.fh) + '%';" +
    "      media.style.backgroundPosition = (crop.fw >= 0.999 ? 0 : (crop.fx / (1 - crop.fw)) * 100) + '% ' + (crop.fh >= 0.999 ? 0 : (crop.fy / (1 - crop.fh)) * 100) + '%';" +
    "    }" +
    "  }" +
    "  const scrim = document.createElement('div');" +
    "  scrim.className = 's';" +
    "  scrim.style.background = 'color-mix(in srgb, var(--white) ' + Math.round(tint * 100) + '%, transparent)';" +
    // 媒体元素自己也裁一次：合成层（video）对父级圆角裁切不可靠
    "  media.style.clipPath = panelClip;" +
    "  scrim.style.clipPath = panelClip;" +
    "  layer.appendChild(media);" +
    "  layer.appendChild(scrim);" +
    "  if (kind === 'video') { try { media.play(); } catch (err) {} }" +
    "} else {" +
    "  const scrim = layer.querySelector('.s');" +
    "  if (scrim) scrim.style.background = 'color-mix(in srgb, var(--white) ' + Math.round(tint * 100) + '%, transparent)';" +
    "}" +
  "})()";
}
/** 挂到球窗上：立即拉一次配置，之后按固定间隔轮询。 */
function dshBgAttach(win) {
  if (dshBgTimer !== undefined) { clearInterval(dshBgTimer); dshBgTimer = undefined; }
  dshBgLastKey = "";
  const port = Number(process.env.DSH_ORB_WEB_PORT ?? "");
  if (!Number.isInteger(port) || port <= 0) return;
  const url = "http://127.0.0.1:" + port + "/dsh-bg/api/orb";
  const tick = async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const cfg = await res.json();
      const key = JSON.stringify(cfg);
      if (key === dshBgLastKey) return;
      dshBgLastKey = key;
      if (!win.isDestroyed()) await win.webContents.executeJavaScript(dshBgScript(cfg)).catch(() => {});
    } catch (err) { /* dsh-bg-plugin 不在时静默 */ }
  };
  void tick();
  dshBgTimer = setInterval(() => { void tick(); }, DSH_BG_POLL_MS);
  win.on("closed", () => { if (dshBgTimer !== undefined) { clearInterval(dshBgTimer); dshBgTimer = undefined; } });
}
//#endregion ${PATCH_MARKER}
`
