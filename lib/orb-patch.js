// dsh-bg-plugin —— 悬浮球（dsh-orb）面板背景补丁
// 只改它两个文件，且改动前完整备份，可一键还原：
//   1) dist/helper/assets/floating.html —— 放宽 CSP，允许本机 127.0.0.1 的图片/视频
//   2) dist/helper/lib/main.js          —— 助手主进程加一个背景控制器（轮询本插件接口并注入背景层）
// 其它文件（floating.css / shell.js / preload.cjs / 宿主）一律不动。
import fs from 'node:fs'
import path from 'node:path'

export const PATCH_MARKER = 'dsh-bg-plugin:panel-background'
export const PATCH_VERSION = 1

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
 * 幂等：已打过补丁时直接返回 alreadyPatched。
 * @returns {{ ok: boolean, alreadyPatched?: boolean, backupDir?: string, error?: string }}
 */
export function applyOrbPatch(paths, backupRoot) {
  try {
    const htmlOld = fs.readFileSync(paths.html, 'utf8')
    const mainOld = fs.readFileSync(paths.main, 'utf8')
    if (mainOld.includes(PATCH_MARKER)) return { ok: true, alreadyPatched: true }

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
    return { ok: true, backupDir }
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
 * 配置来自 http://127.0.0.1:\${DSH_ORB_WEB_PORT}/dsh-bg/api/orb（轮询）；
 * 本插件未安装/未启用时静默，无任何副作用。还原方式：dsh-bg-plugin 设置页的「撤销」。
 */
const DSH_BG_POLL_MS = 3000;
let dshBgTimer;
let dshBgLastKey = "";
/** 生成在渲染进程里执行的背景层脚本（字符串拼接，避免嵌套模板字面量）。 */
function dshBgScript(cfg) {
  return "(() => {" +
    "const cfg = " + JSON.stringify(cfg) + ";" +
    "const ID = 'dsh-bg-layer';" +
    "const panel = document.getElementById('panel');" +
    "const existing = document.getElementById(ID);" +
    "if (!panel || !cfg || cfg.enabled !== true || !cfg.url) {" +
    "  if (existing) existing.remove();" +
    "  if (panel && window.__dshBgPanel) { panel.style.background = window.__dshBgPanel; window.__dshBgPanel = ''; }" +
    "  return;" +
    "}" +
    "if (!window.__dshBgPanel) window.__dshBgPanel = panel.style.background || 'var(--white)';" +
    "const src = /^https?:/i.test(cfg.url) ? cfg.url : 'http://127.0.0.1:' + String(cfg.port || '') + cfg.url;" +
    "const tint = Math.max(0, Math.min(0.95, Number(cfg.tint)));" +
    "const kind = cfg.kind === 'video' ? 'video' : 'img';" +
    "let layer = existing;" +
    "if (!layer) {" +
    "  layer = document.createElement('div');" +
    "  layer.id = ID;" +
    "  layer.style.cssText = 'position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;z-index:-1';" +
    "  panel.style.background = 'transparent';" +
    "  panel.insertBefore(layer, panel.firstChild);" +
    "}" +
    "if (layer.dataset.kind !== kind || layer.dataset.src !== src) {" +
    "  layer.textContent = '';" +
    "  const media = document.createElement(kind);" +
    "  media.src = src;" +
    "  media.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block';" +
    "  if (kind === 'video') { media.muted = true; media.loop = true; media.autoplay = true; media.setAttribute('playsinline',''); }" +
    "  const scrim = document.createElement('div');" +
    "  scrim.dataset.role = 'scrim';" +
    "  scrim.style.cssText = 'position:absolute;inset:0;background:color-mix(in srgb, var(--white) ' + Math.round(tint * 100) + '%, transparent)';" +
    "  layer.appendChild(media);" +
    "  layer.appendChild(scrim);" +
    "  layer.dataset.kind = kind;" +
    "  layer.dataset.src = src;" +
    "  if (kind === 'video') { try { media.play(); } catch (err) {} }" +
    "} else {" +
    "  const scrim = layer.querySelector('[data-role=scrim]');" +
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
