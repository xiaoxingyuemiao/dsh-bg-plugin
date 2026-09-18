# DSH 自定义背景插件（dsh-bg-plugin）

为 DSH Web GUI 添加可自定义的背景图片：支持**远程图片 URL** 和**本地图片**（文件夹浏览），带清晰度 / 压暗 / 模糊调节；**设置面板保持默认外观**，不跟随背景变化。

**两种安装形态：**

| 形态 | 文件 | 特点 |
| --- | --- | --- |
| **静态安装版**（推荐） | `package.json` + `cordis.patch.yml` + `lib/` | 作为 DSH 插件包装入 Web profile，重启后常驻，不依赖会话 |
| **动态插件版** | `host.js` + `client.js` + `define.json` | 通过 `cordis_define` 在会话中动态加载，重启后消失 |

## 文件说明

| 文件 | 内容 |
| --- | --- |
| `package.json` | 插件包清单（`dsh.client` 声明 + `dsh.bundle.patch`） |
| `cordis.patch.yml` | 挂载声明：把插件行插入 Web profile 组合树 |
| `lib/index.js` | Host 半边（静态版）：webServer 提供 `/dsh-bg/api/list`、`/dsh-bg/api/set`、`/dsh-bg/api/img` 路由 |
| `lib/client.js` | Client 半边（静态版）：设置页 UI，fetch 直连 API 路由 |
| `host.js` | 动态版 Host 源码（`cordis_define` 的 `code.host`） |
| `client.js` | 动态版 Client 源码（`cordis_define` 的 `code.client`） |
| `define.json` | 动态版完整重新安装载荷 |
| `README.md` | 本文档 |

## 安装（静态安装到 DSH）

```powershell
# 在 DSH 所在机器上，把本目录作为本地开发插件装入 web profile：
dsh plugin --profile web add link:<本目录绝对路径>
# 例：dsh plugin --profile web add link:D:\DSH插件\dsh-bg-plugin
```

然后**重启 DSH**（`dsh web`）。启动后：
- 设置 → 背景：出现「自定义背景」设置页；
- 浏览器加载 `/plugins/dsh-bg-plugin/client.js`，Host 注册 `/dsh-bg/api/*` 路由。

卸载：

```powershell
dsh plugin --profile web remove dsh-bg-plugin
```

## 动态版安装（会话级，重启失效）

读取 `define.json` 作为 `cordis_define` 参数（`plugin.kind: 'existing'`、`pluginId: 'dshbg-1'`；若不存在则 `kind: 'new'` + `idPrefix: 'dshbg'`），再用返回的 `packageId` 执行 `cordis_run` 并在 GUI 批准。

## 功能

- **设置页入口**：侧边栏「设置」→ 新增一页「背景」（`settings.section`，id `dsh-bg`）
  - 启用 / 禁用开关
  - 媒体来源：图片 / 视频 URL（粘贴链接）/ 本地文件（输入文件夹路径或「浏览文件夹…」→ 列出文件 → 点击应用）
    - 图片格式：png/jpg/jpeg/gif/webp/bmp/avif/svg
    - 视频格式：mp4/m4v/webm/ogv/ogg/mov/mkv（浏览器可播放的容器；单文件 ≤ 64MB）
  - **图片**：预览图上框选展示区域（拖动框选 / 拖动选框移动 / 拖四角缩放）
  - **视频**：真实 `<video>` 元素渲染，`object-fit: cover` 等比铺满屏幕（自动裁掉超出部分，不拉伸、不裁剪、无需框选），静音循环自动播放
  - 背景清晰度（0–100%）、压暗（0–80%）、模糊（0–20px）、恢复默认
- **持久化（静态版）**：所有调整自动保存到 `$DSH_HOME/.dsh-bg-state.json`（默认 `C:\Users\<你>\.dsh\.dsh-bg-state.json`）；刷新页面、重启 DSH 后自动恢复状态并重应用背景（含上次的本地媒体与裁切区域）。
- **框选展示区域（静态版，仅图片）**：选择图片后，设置页显示预览图——拖动框选展示区域、拖动选框移动、拖四角调整大小；区域以图片分数 `{fx,fy,fw,fh}` 存储并持久化。背景渲染用纯 CSS（`calc/max + vw/vh`）把裁切区域等比放大铺满视口、区域中心对准屏幕中心，窗口缩放自动跟随。视频不使用该机制。
- 动态版额外提供 Run 卡片快捷开关（`tool.view.cordis`，动态专属座位，静态版不含）；动态版为会话级，不持久化。

## 工作原理

1. **背景层**：注入 `body::before` 固定层（`position:fixed; z-index:-1`），承载图片 + 压暗渐变遮罩 + 可选模糊（静态版用 `<style>` 元素注入，动态版用 `styles.insert`）。
2. **半透明表面**：`theme.overrideTokens` 把 4 个背景 token（`--dsw-alias-bg-base` / `-layer-1` / `-layer-2` / `--dsw-specific-sidebar-fill`）覆盖为半透明色（浅色/深色各一套），让图片从应用底层透出；清晰度越高表面越透明。
3. **设置面板豁免**：设置面板（`[role="dialog"][aria-modal="true"]`）内部重新声明这 4 个 token 的 DSH 原始色值（取自设计平台基础样式），因此面板始终 100% 不透明、保持默认外观。
4. **本地图片传输**：Host 注册 `/dsh-bg/api/*` 路由（`ctx.effect` 内注册，随插件生命周期清理），用 `fs` 服务读取图片字节（`fs.contains` 防路径穿越），客户端以相对 URL 作为 CSS 背景。
5. **路径读取不受沙箱限制**：`fs` 沙箱只拦截写入，读取任意目录均可；若「浏览文件夹」的系统选择器不可用，可直接粘贴文件夹路径。

## 注意事项 / 历史踩坑

- `webServer.register` 返回的注销函数**不会**自动随插件 fiber 清理，必须包在 `ctx.effect(() => webServer.register(...))` 里，否则停止/更新后路由泄漏，下次注册同路径会报 `duplicate exact route`。
- 动态版路由路径每次运行随机生成（`/dsh-bg/img-<random>`），避免与旧版本残留路由冲突；静态版使用固定路径（进程重启即全新）。
- 客户端 `slots.register`、`theme.overrideTokens` 由 client runner 自动挂到 fiber（动态版），静态版同样依赖 cordis 服务自身的生命周期。
- Host 沙箱的 `btoa` 是 UTF-8 编码，不能用于二进制图片转 base64；本地图片走 HTTP 路由而非 RPC 传字节。
- `dsh plugin --profile web add link:<路径>` 用 pnpm 建立 junction 链接（NTFS），改动源码目录即可热更新，重启 DSH 生效。
