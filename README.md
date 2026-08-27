# DSH 自定义背景插件（dshbg-1）

为 DSH Web GUI 添加可自定义的背景图片：支持**远程图片 URL** 和**本地图片**（文件夹浏览），带清晰度 / 压暗 / 模糊调节；**设置面板保持默认外观**，不跟随背景变化。

- 插件类型：DSH 动态 Cordis 插件（Host + Client 双端）
- 当前版本：`dshbg-1 / pkg-6`（本目录保存的就是 pkg-6 源码）
- 生效范围：会话级。刷新页面或停用插件后自动恢复默认外观，无持久化。

## 文件说明

| 文件 | 内容 |
| --- | --- |
| `host.js` | Host 半边源码（作为 `cordis_define` 的 `code.host` 传入） |
| `client.js` | Client 半边源码（作为 `cordis_define` 的 `code.client` 传入） |
| `define.json` | 完整的重新安装载荷（`plugin` / `name` / `purpose` / `code`） |
| `README.md` | 本文档 |

## 功能

- **设置页入口**：侧边栏「设置」→ 新增一页「背景」（`settings.section`，id `dsh-bg`）
  - 启用 / 禁用开关
  - 图片来源：图片 URL（粘贴远程图片链接）/ 本地图片（输入文件夹路径或「浏览文件夹…」→ 列出图片 → 点击应用；支持 png/jpg/jpeg/gif/webp/bmp/avif/svg，单张 ≤ 12MB）
  - 背景清晰度（0–100%）、压暗（0–80%）、模糊（0–20px）、恢复默认
- **Run 卡片快捷开关**：`tool.view.cordis`（key `self`）上的一键启用/禁用按钮

## 工作原理

1. **背景层**：`styles.insert` 注入 `body::before` 固定层（`position:fixed; z-index:-1`），承载图片 + 压暗渐变遮罩 + 可选模糊。
2. **半透明表面**：`theme.overrideTokens` 把 4 个背景 token（`--dsw-alias-bg-base` / `-layer-1` / `-layer-2` / `--dsw-specific-sidebar-fill`）覆盖为半透明色（浅色/深色各一套），让图片从应用底层透出；清晰度越高表面越透明。
3. **设置面板豁免**：设置面板（`[role="dialog"][aria-modal="true"]`）内部重新声明这 4 个 token 的 DSH 原始色值（取自设计平台基础样式），因此面板始终 100% 不透明、保持默认外观。
4. **本地图片传输**：Host 注册唯一 HTTP 路由（`/dsh-bg/img-<random>`，注册在 `ctx.effect` 内随插件生命周期清理），用 `fs` 服务读取图片字节（`fs.contains` 防路径穿越），客户端以相对 URL 作为 CSS 背景。
5. **路径读取不受沙箱限制**：`fs` 沙箱只拦截写入，读取任意目录均可；若「浏览文件夹」的系统选择器不可用，可直接粘贴文件夹路径。

## 重新安装步骤（在 DSH 会话中）

1. 读取本目录的 `define.json`，将其内容作为 `cordis_define` 的参数（`plugin.kind: 'existing'`，`pluginId: 'dshbg-1'`；若插件已不存在则改用 `kind: 'new'` + `idPrefix: 'dshbg'`，并以返回的 pluginId 为准）。
2. 用返回的 `packageId` 执行 `cordis_run`（首次 `mode: 'run'`；已有当前版本则 `mode: 'update'`），在 GUI 中批准。
3. 到 设置 → 背景 使用。

## 注意事项 / 历史踩坑

- `webServer.register` 返回的注销函数**不会**自动随插件 fiber 清理，必须包在 `ctx.effect(() => webServer.register(...))` 里，否则停止/更新后路由泄漏，下次注册同路径会报 `duplicate exact route`。
- 路由路径每次运行随机生成（`/dsh-bg/img-<random>`），避免与旧版本残留路由冲突。
- 客户端 `slots.register`、`theme.overrideTokens` 由 client runner 自动挂到 fiber（无需手动 effect），Host 端服务注册没有这个待遇。
- Host 沙箱的 `btoa` 是 UTF-8 编码，不能用于二进制图片转 base64；本地图片走 HTTP 路由而非 RPC 传字节。
