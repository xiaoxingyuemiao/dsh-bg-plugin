// dsh-bg-plugin —— 自动更新
// 从 GitHub 仓库 main 分支拉取本插件自己的文件（走 api.github.com，
// raw.githubusercontent.com 在本机 DNS 不通，API 的 raw 接口是通的）。
import fs from 'node:fs'
import path from 'node:path'

export const REPO = { owner: 'xiaoxingyuemiao', name: 'dsh-bg-plugin', branch: 'main' }

/** 会被更新覆盖的文件（相对插件根目录）。 */
export const UPDATE_FILES = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/orb-patch.js',
  'README.md',
  'LICENSE',
]

const API_BASE = 'https://api.github.com/repos/' + REPO.owner + '/' + REPO.name + '/contents/'

/** 本地插件版本（读自己的 package.json）。 */
export function localVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch (err) {
    return ''
  }
}

/** 版本比较：a > b 返回 1，相等 0，a < b 返回 -1。 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0)
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** 取仓库里某个文件的原文。 */
export async function fetchRepoFile(relPath, options = {}) {
  const branch = options.branch || REPO.branch
  const timeoutMs = options.timeoutMs || 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(API_BASE + relPath + '?ref=' + branch, {
      headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'dsh-bg-plugin' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 检查是否有新版本。 */
export async function checkUpdate(pluginRoot, options = {}) {
  const current = localVersion(pluginRoot)
  try {
    const remotePkg = await fetchRepoFile('package.json', options)
    let latest = ''
    try {
      const parsed = JSON.parse(remotePkg)
      latest = typeof parsed.version === 'string' ? parsed.version : ''
    } catch (err) {
      latest = ''
    }
    if (latest === '') return { ok: false, current, error: '远端 package.json 无法解析' }
    return { ok: true, current, latest, hasUpdate: compareVersions(latest, current) > 0 }
  } catch (err) {
    return { ok: false, current, error: (err && err.message) ? String(err.message) : String(err) }
  }
}

/**
 * 应用更新：先把现有文件备份到 backupRoot/<时间戳>/，再写入远端内容。
 * 写入失败会明确报错；调用方需要提示用户重启 DSH（运行中的宿主仍是旧代码）。
 */
export async function applyUpdate(pluginRoot, backupRoot, options = {}) {
  const files = {}
  for (const rel of UPDATE_FILES) {
    try {
      files[rel] = await fetchRepoFile(rel, options)
    } catch (err) {
      if (rel === 'LICENSE') continue // LICENSE 不是必需的
      const detail = (err && err.message) ? String(err.message) : String(err)
      return { ok: false, error: '下载 ' + rel + ' 失败：' + detail }
    }
  }

  let version = ''
  try {
    const parsed = JSON.parse(files['package.json'])
    version = typeof parsed.version === 'string' ? parsed.version : ''
  } catch (err) {
    return { ok: false, error: '远端 package.json 无法解析' }
  }

  const local = localVersion(pluginRoot)
  if (compareVersions(version, local) <= 0) {
    return { ok: true, upToDate: true, version: local }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(backupRoot, stamp)
  const written = []
  for (const rel of Object.keys(files)) {
    const target = path.join(pluginRoot, rel)
    try {
      if (fs.existsSync(target)) {
        const backupTarget = path.join(backupDir, rel)
        fs.mkdirSync(path.dirname(backupTarget), { recursive: true })
        fs.copyFileSync(target, backupTarget)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, files[rel], 'utf8')
      written.push(rel)
    } catch (err) {
      const detail = (err && err.message) ? String(err.message) : String(err)
      return { ok: false, error: '写入 ' + rel + ' 失败：' + detail, version, files: written, backupDir }
    }
  }
  return { ok: true, version, from: local, files: written, backupDir }
}
