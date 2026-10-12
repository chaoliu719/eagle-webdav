# 产品决策与约定

> 读者：开发者、维护者、AI 协作者。这里的条目多数是**用户明确要求**的，改动前先问用户。

## 定位

把 Eagle 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端。第一版全功能：OPTIONS、PROPFIND、GET/HEAD、PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK/UNLOCK。

## 命名（Eagle 内不带 "Eagle"）

- 清单 `name` 为 `{{manifest.app.name}}`，名字在 `plugin/_locales/{en,zh_CN,zh_TW}.json`：en「WebDAV Share」，中文「WebDAV 共享」；窗口标题与头部、Eagle 系统通知标题（`WebDAV 共享 · …`）同名
- Eagle 之外要认得出：Bonjour 服务名 `Eagle 素材库 (主机名)`（随语言：`Eagle 素材库` / `Eagle Library` / `Eagle 素材庫`），Basic 认证 Realm 固定 `Eagle Library`
- 仓库名、README 标题、插件 ID `EAGLEWEBDAV01` 不变

## 多语言

- 界面三语：简中 / 繁中 / 英文，**字典就是 `plugin/_locales/{zh_CN,zh_TW,en}.json`**（`manifest.app.name` + `ui.*`），同时被 Eagle 读（清单名称）和被 esbuild 打进 `plugin.js`（`src/i18n.ts`）
- 语言取自 `eagle.app.locale`（要等 `onPluginCreate`，**真机未实测格式**）：`zh_TW/HK` → 繁中、其他 `zh*` → 简中、其余一律英文（与 `fallbackLanguage: en` 一致）
- HTML 静态文字用 `data-i18n` / `data-i18n-aria`，初始化时 `applyStaticI18n()` 替换；动态文字用 `t(key, vars)`
- 新增文案必须三种语言同步，`test/unit/i18n.test.ts` 检查
- 日志文件、窗口日志行、诊断信息仍是中文（面向开发者）

## 安全与认证

- 仅局域网（来源地址白名单），Basic 认证，默认端口 41600，监听 0.0.0.0
- **管理密码留空 = 不做认证，任何访问都当管理账号，也允许监听非本机地址**（用户明确要求，不再为用户做额外的安全限制）；设了管理密码才启用认证
- **只读账号功能已按用户要求整体删除**；「额外允许的来源网段」也已删除
- 端口范围 1024–65535（用户明确要求）

## 行为

- 条目 DELETE **与 Eagle 一致**（2026-10-12 按用户要求改，原为「一删全删」）：在文件夹里且条目还属于别的文件夹 = 只从该文件夹移除（Eagle 弹窗默认项）；只属于这一个文件夹、或在 `@未分类` / `@全部` 里 = 整个进回收站；文件夹 DELETE 返回 403
- **`@标签` 视图已按用户要求整体删除**（代码、配置 `tagsView`、测试、文档都不再有，不要加回）
- `@全部`（用户确认；行为尽量照搬 Eagle 界面，不发明 Eagle 没有的手势）：平铺全库，和 `@未分类` 一样可以覆盖、改名、改属性、删除（整个进回收站）；新增文件落在未分类；COPY 进来：同名同一条目 204、换名真复制落未分类、撞上别的条目 403；MOVE：移出到文件夹 = 只加归属（Eagle 在「全部」视图拖拽的行为）、移进来 = 去掉原文件夹归属、移到 `@未分类` 403（Eagle 没有这个手势）；只有 MKCOL 不支持；开关 `allView` 只在配置文件里。三个位置 × 四类操作的完整对照表见 `docs/user/library-behavior.md`（以它为准）
- 文件夹 MOVE 只支持**改名**，换父级（含移到根）返回 403：Eagle 的 `folder.parent` 对嵌套文件夹会让树里出现重复条目，详见 `eagle-api-notes.md`；解除前需要重新实测
- 无扩展名文件返回 415

## 窗口

- 删除过的内容不要加回：连接地址的二维码与 `qrcode-generator` 依赖、自动发现说明、阻止休眠常驻提示、「所有网卡」警告、「密码留空…」说明、只读账号、来源网段
- 日志精简方案：窗口里只多「复制诊断信息」「打开日志文件夹」两个按钮；不做「活动」人话列表、响应指示灯、同类合并（已砍）。设计稿在画布「日志系统」「提示系统」

## 清单与平台

- `platform: mac`、`arch: arm`（只在 macOS Apple 芯片上验证过；官方允许值 platform `all|mac|win`、arch `all|arm|x64`）
- `devTools` 必须为 `false`
- 版本 1.0.0；插件中心上架已确认，见 [发布](../release/publishing.md)

## 工作约定

- 每完成一个阶段性工作就提交一次 git（提交信息用中文，带 Co-Authored-By）
- 新的结论、约定记入对应文档：Eagle 行为 → [eagle-api-notes.md](eagle-api-notes.md)；设计与实现 → [architecture.md](architecture.md)；决策 → 本文；验证状态 → [testing.md](testing.md)
- 与用户用中文交流，中文标点用全角，中英文和数字之间加空格；不用画图讲解；需要确认时用文字直接问
- 历史：M0 探针（`probe/`）已删除，历史在 git 里（最后存在于提交 `a8ba0f8` 及之前）；M0–M4 里程碑见 [testing.md](testing.md)
