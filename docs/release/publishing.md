# 打包、安装与上架

> 读者：维护者。上架文案与提交清单见 [store-listing.md](store-listing.md)，封面图在 `store/`。

## 本地打包与安装验证

- `npm run package` 生成 `dist/eagle-webdav-<版本>.eagleplugin` 与同内容的 `.zip`（Eagle「打包插件」的产物就是 `plugin/` 内容的 zip，文件名 `Eagle WebDAV.eagleplugin`，生成在项目根目录，已 gitignore）
- 安装流程（已真机验证）：`open dist/eagle-webdav-<版本>.eagleplugin`（双击同理）→ Eagle 弹出「Install eagle-webdav-<版本>?」→ 点 Install → 装到 `~/Library/Application Support/Eagle/Plugins/EAGLEWEBDAV01`；`runAfterInstall` 使服务立即自启并沿用 `eagle-webdav/config.json`
- 版本号来自 `plugin/manifest.json`，构建时注入 `__PLUGIN_VERSION__`

## 官方审核要点

读自 developer.eagle.cool/plugin-api 的 publishing 与 plugin-review：

- 必须用 Eagle「打包插件」导出（**不能**用 `npm run package` 的产物上传）
- `devTools` 不能为 true；包里不能有开发文件、`.DS_Store`、密钥
- 商店文案：名称 ≤ 30 字符且 ≤ 6 个词；简短描述英文 ≤ 200、简中 ≤ 100；每种提交的语言都要完整
- 子进程、本地监听、明文 HTTP、改动资源库都要在介绍里披露
- 要有支持联系方式（GitHub 仓库目前私有，须公开才能当支持链接）
- 开发者必须能解释提交的代码（AI 辅助开发不免责）

## 发布流程

1. `npm run check` 通过，`devTools` 为 `false`，版本号与更新日志已更新
2. 在 Eagle 里卸载开发模式加载的同 ID 插件，用 Eagle「打包插件」导出
3. 安装导出的包，确认能启动、主要功能可用，解压检查只含运行所需文件
4. 按 [store-listing.md](store-listing.md) 填写三语文案、封面与审核说明
5. 提交，并在 [decisions.md](../dev/decisions.md) / 本文记下结果

## 封面图

`store/cover-{en,zh_CN,zh_TW}.png`（1600×1000），窗口截图来自预览页面（`?lang=… &demo=1`），数据是演示用的。
