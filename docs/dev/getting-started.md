# 开发者上手

> 读者：想构建、调试、修改本插件的开发者。架构见 [architecture.md](architecture.md)，Eagle 行为见 [eagle-api-notes.md](eagle-api-notes.md)。

## 环境

- Node 20+（构建用）；插件运行时是 Eagle 内的 Node 16.17.1 / Electron 22 / Chromium 108，esbuild 目标 node16
- Eagle 4.0 Build 12+，推荐 Build 23
- 技术栈：TypeScript + esbuild（iife）；不引入第三方 WebDAV 库

## 构建与加载

```bash
npm install
npm run build
```

开发时：在 Eagle 菜单「插件 → 开发者选项… → 导入本地项目」里选 `plugin/` 目录。

- `plugin/manifest.json` 的 `devTools` 现为 `false`。调试时临时改成 `true` 可弹出开发者工具（控制台可 `location.reload()`），提交前必须改回
- 不开 DevTools 时，用 Eagle 工具栏「插件 → 开发」标签里该插件右侧「…」菜单的「重新加载」；改完 manifest 后需重新加载才生效
- 「开发」标签里的「卸载」只移除登记，不删项目源码，也不删配置目录

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 类型检查 |
| `npm test` | 单元测试（tsx + node:test，`test/unit/`，用内存假 Eagle） |
| `npm run build` | esbuild 打包到 `plugin/js/plugin.js` |
| `npm run check` | 类型检查 + 单元测试 + 构建 |
| `npm run package` | 生成 `dist/eagle-webdav-<版本>.eagleplugin` 与同内容 `.zip`（仅用于本地安装验证，**不能用来上架**，见 [发布](../release/publishing.md)） |
| `npx tsx test/dev/fake-server.ts [端口]` | 不依赖 Eagle 的假数据服务，可用 rclone 联调 |
| `npx tsx test/dev/bench.ts` | 大库压测（假数据 20 万条） |
| `node test/dev/ui-preview.mjs [端口]` | 在普通浏览器里预览插件窗口，见下 |
| `node test/dev/real-write-smoke.mjs <端口> [密码]` | 对**真实** Eagle 的写入冒烟测试（41 项），只动 `__webdav_test_` 开头的文件夹 |
| `node test/dev/seed-e2e.mjs [端口] [密码]` | 往真实库灌 e2e 预置数据，见 [testing.md](testing.md) |
| `node test/dev/seed-many-images.mjs [数量]` | 往真实库灌小图片 |

CI 见 `.github/workflows/ci.yml`。

## 预览窗口

`node test/dev/ui-preview.mjs`，浏览器打开 `http://127.0.0.1:41777/`。给 Node 模块和 Eagle 接口打桩，不碰真实 Eagle。

- `?pw=1`：模拟已设置密码
- `?lang=en` / `zh_TW`：模拟界面语言
- `?demo=1`：模拟几个客户端连接并带库名（截封面用）
- 页面里 `window.__fakeRequest(ua, ip, method)` 模拟客户端请求；写入的日志在 `window.__logfile`

## 联调

- 不依赖 Eagle：`npx tsx test/dev/fake-server.ts`，再用 rclone 对照
- 挂载 Finder 同款：`osascript -e 'mount volume "http://127.0.0.1:41600/" as user name "eagle" with password "..."'`
- 重载插件页面可在其 DevTools 控制台执行 `location.reload()`（屏幕锁定时 GUI 操作不可用）

## 目录

- `src/{config,http,dav,vfs,index,eagle,util,ui}`，详见 [architecture.md](architecture.md)
- `plugin/`：清单、`index.html`、`_locales/`、logo；`plugin/js/plugin.js` 是构建产物
- `test/unit/`：单元测试；`test/dev/`：联调与压测脚本
- `scripts/package.mjs`、`build.mjs`：打包与构建；`types/eagle.d.ts`：Eagle 类型

## 约束

- 只有 `src/eagle/realAdapter.ts` 可直接碰全局 `eagle`
- 新增界面文案必须三种语言同步（`plugin/_locales/{zh_CN,zh_TW,en}.json`），`test/unit/i18n.test.ts` 检查键与 `{{变量}}` 一致
