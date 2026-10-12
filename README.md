<p align="center"><img src="plugin/logo.png" alt="Eagle WebDAV" width="128"></p>

# Eagle WebDAV

> 在 Eagle 的插件列表和插件窗口里，它叫「WebDAV 共享」（英文 WebDAV Share）。

把 [Eagle](https://eagle.cool) 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端的后台服务插件。插件内用 Node `http` 手写最小 WebDAV 服务，不依赖第三方 WebDAV 库。

- Eagle 文件夹树就是目录树；另有可写的 `@未分类`、只读的 `@标签` 和平铺列出全库的只读 `@全部` 虚拟目录
- 读：PROPFIND、GET / HEAD（Range、条件请求）
- 写：PUT、MKCOL、DELETE（进回收站）、MOVE、COPY、PROPPATCH、LOCK / UNLOCK
- 仅局域网，Basic 认证，默认端口 41600

已在 Eagle 4.0.0 Build 23（macOS arm64）上验证。使用说明见 [docs/usage-guide.md](docs/usage-guide.md)。

## 安装

需要 Eagle 4.0 Build 12 或更高，Node 20+ 用于构建。

```bash
npm install
npm run build
```

开发时：在 Eagle 菜单「插件 → 开发者选项… → 导入本地项目」里选 `plugin/` 目录。

正式安装：`npm run package` 生成 `dist/eagle-webdav-<版本>.eagleplugin`（与 Eagle「打包插件」的产物一样，是 plugin/ 内容的 zip），双击它，在 Eagle 弹出的「Install …?」里点 Install；服务会立即自启。同内容的 `.zip` 也一并生成。

首次安装后服务自动启动，默认只监听本机，**没有密码时不要求任何认证**（任何访问都等同管理账号）。要对局域网开放，在窗口的「设置」里选监听地址；想要认证，设置管理账号的密码，再点「保存」。配置保存在 `~/Library/Application Support/Eagle/eagle-webdav/config.json`。

## 开发

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 类型检查 |
| `npm test` | 单元测试（tsx + node:test，用内存假 Eagle） |
| `npm run build` | esbuild 打包到 `plugin/js/plugin.js`（iife，target node16） |
| `npm run check` | 以上三项依次执行 |
| `npx tsx test/dev/fake-server.ts` | 不依赖 Eagle 的假数据服务，可用 rclone 联调 |
| `npx tsx test/dev/bench.ts` | 大库压测（假数据） |
| `node test/dev/ui-preview.mjs [端口]` | 在普通浏览器里预览插件窗口（给 Node 模块和 Eagle 接口打桩，不碰真实 Eagle；`?pw=1` 模拟已设置密码） |
| `node test/dev/real-write-smoke.mjs <端口> <密码> [已有测试文件夹]` | 对**真实** Eagle 的写入冒烟测试，只动 `__webdav_test_` 开头的文件夹 |

目录：`src/config`（配置与 scrypt）、`src/http`（服务、认证、来源过滤）、`src/dav`（路由与各方法）、`src/vfs`（命名、路径解析、影子暂存区）、`src/index`（缓存）、`src/eagle`（适配层，只有 `realAdapter.ts` 碰全局 `eagle`）。

Eagle Plugin API 的实测行为和踩过的坑记录在 [CLAUDE.md](CLAUDE.md)，设计文档见 [docs/design.md](docs/design.md)（以 CLAUDE.md 的实测为准）。

## 已知限制

- Eagle 没有删除文件夹的 API：DELETE 文件夹返回 403
- 内容与库内已有文件相同的导入（含改名复制）会触发 Eagle 的「重复添加提示」，要在 Eagle 里点确认
- 没有扩展名的文件不能上传（Eagle 不识别，返回 415）
- 锁是假锁：发令牌，不强制互斥
- 几十万条的大库性能未实测

## 许可证

MIT
