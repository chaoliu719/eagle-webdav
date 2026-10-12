# 架构

> 读者：开发者、维护者。实现细节以源码为准；Eagle 行为见 [eagle-api-notes.md](eagle-api-notes.md)。

## 形态

Eagle 后台服务插件（`serviceMode: true`），插件内用 Node `http` 手写最小 WebDAV 服务（Class 1 加假锁实现 Class 2，`DAV: 1, 2`）。插件以经典脚本加载，可用 `require`。

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/config` | 配置与 scrypt 密码 |
| `src/http` | 服务、认证（Basic、失败封禁）、来源地址过滤、响应封装 |
| `src/dav` | 路由与各方法（OPTIONS、PROPFIND、GET/HEAD、PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK/UNLOCK）、属性 |
| `src/vfs` | 命名、路径解析、影子暂存区 |
| `src/index` | `LibraryIndex` 缓存 |
| `src/eagle` | 适配层：`EagleAdapter` 接口、`RealEagleAdapter`（唯一碰全局 `eagle`）、Fake、`instrumentAdapter` |
| `src/util` | 日志（`fileLog`）、请求上下文（`reqctx`）、诊断（`diagnostics`）、`Metrics` 等 |
| `src/ui` | 状态窗口 |
| `src/i18n.ts` | 三语字典加载与 `t(key, vars)`，不依赖 Eagle 的 i18next |

## 虚拟路径模型

- Eagle 文件夹树即目录树；根目录另有虚拟目录 `@未分类`（可写）、`@标签`（只读，配置 `tagsView` 可关）、`@全部`（只读，配置 `allView`，仅配置文件）。根目录不能放条目，PUT 返回 403
- 只读视图共用 `isReadOnlyView`（`viaView`）：PUT / MKCOL / DELETE / MOVE / PROPPATCH 及向其中 COPY 均 403，可从中 COPY 出来
- 条目 DELETE = 整个条目移入回收站；文件夹 DELETE 返回 403
- 同名消歧：后来的加「 ~ID末6位」后缀；旧路径仍可访问（冲突键索引）
- 目录名 `@未分类` `@标签` `@全部` 不翻译
- PROPFIND `Depth: infinity` 返回 403 `propfind-finite-depth`
- 路径按 NFC 匹配；精确 / 冲突键失败后用 `eagleSanitizeName` 再找一次

## 写入策略

- PUT：新建 `addFromPath`、覆盖 `replaceFile`；0 字节占位与系统文件（`.DS_Store`、`._*`、`.Spotlight-V100` 等）进影子暂存区，永不入库，重启或切换资源库后丢弃
- 无扩展名：`addFromPath` 加 20s 超时，超时返回 415 并清理暂存
- 上传 120s 空闲中止；写入类方法支持 `If-Match` / `If-None-Match`（412）
- MOVE / COPY：条目改名与归属增量修改；同名跨目录按引用；改名真复制并带 tags / star / annotation / url；文件夹改名与移动；文件夹 COPY 与覆盖文件夹 403
- PROPPATCH：E 命名空间 tags / star / annotation / url，原子性；dead 属性存内存，随 MOVE / COPY 走，DELETE 时清掉；格式错误的 PROPFIND / PROPPATCH 体返回 400
- LOCK 永不拒绝，对不存在的 URL 建占位，不校验 If 里的令牌（Finder 在插件重启后拿旧令牌不能被拒）；这是有意的假锁
- 重复添加：`importAt` 后按目录列表确认条目是否出现；没出现就给横幅并用 `eagle.notification.show` 通知，后台每 5s 轮询，入库后自动撤销，10 分钟放弃

## 缓存与一致性

- 不另开轮询：每个请求先做新鲜度检查（`library.info().modificationTime`，至少间隔 1.5s，兜底 60s 过期），变化则让文件夹树、条目、标签、目录列表缓存整体失效（`LibraryIndex.revision`）；写操作成功后主动失效
- 目录列表建了名字 / 冲突键索引，条目缓存总量 LRU 上限 20 万条
- `LibraryIndex.normalize`：`modifiedAt || importedAt`，再与本服务替换时间取较大者，用于 ETag
- 资源库切换：服务返回 503，完成后恢复并给一条 info toast
- 压测（假数据 20 万条）：2 万条目录 Depth:1 约 0.1s、15MB，堆 +20MB

## 来源与认证

- 仅局域网：来源地址白名单（回环、10/8、172.16/12、192.168/16、169.254/16、IPv6 内网），无额外网段配置
- Basic 认证，Realm 固定 `Eagle Library`（须英文）；同一来源连续失败 10 次封禁 10 分钟
- 管理密码留空 = 不认证，任何访问都当管理账号，也允许监听非本机地址；设了密码才启用认证

## 服务体验

- **防休眠**：只有传输类请求（GET / PUT / COPY / MOVE）才计入，PROPFIND / OPTIONS / LOCK / HEAD 不计；有传输时起 `caffeinate -i -w <进程号>`，最后一次传输结束再留 60s 才放开；`-w` 保证宿主退出后它也退出
- **Bonjour**：`dns-sd -R "<名称>" _webdav._tcp local <端口>`，仅对局域网开放时注册；子进程在页面 `pagehide`、停止、退出时结束，启动时 `pkill -f 'dns-sd -R Eagle '` 清理遗留
  - **卸载插件会留下孤儿 `dns-sd`（2026-10-12 真机实测）**：卸载直接结束宿主进程，`pagehide` / `onPluginBeforeExit` 都来不及跑，而 `dns-sd` 没有 `caffeinate -w` 那样的选项，会继续广播一个已不存在的服务（`caffeinate` 则正常随宿主退出）。现在每次注册都会起一个小看门狗（`sh` 循环，每 2 秒检查宿主进程与 `dns-sd`，任一消失就结束 `dns-sd`；`defaultWatchdog`，`src/util/bonjour.ts`），`stop()` 时一并结束；有单元测试。启动时的 `pkill` 清理仍保留，处理历史遗留
- 连接设备按 User-Agent 识别；`198.18.0.0/15`（Surge 虚拟网卡）不列入监听地址下拉框

## 日志系统

给开发者留证据，窗口里只多两个按钮（复制诊断信息、打开日志文件夹）。

- 文件日志默认开启：`<配置目录>/logs/webdav-YYYY-MM-DD.log`，每行一条 JSON（`ts level cat ev rid …`），200ms 批量同步追加，单文件 5MB 滚动成 `.N.log`，保留 7 天，总量 35MB；写失败只计数（`src/util/fileLog.ts`）。级别 `logLevel`（error / warn / info / debug，默认 info）只在配置文件里改
- 入口 `Logger.log(level, cat, ev, fields, text?)`；分类 svc / req / eagle / idx / imp / cli / sys / perf / auth / proc；窗口与 eagle.log 只收 info 及以上
- 请求号：`AsyncLocalStorage`（`src/util/reqctx.ts`）每请求一个 6 位 `rid`；handler 用 `noteReq({...})` 补字段。`res.on('finish')` 这类事件回调拿不到上下文，要用闭包里的 ctx
- Eagle 调用计时：`instrumentAdapter`（Proxy 装饰器）在 `main.ts` 套在 `RealEagleAdapter` 外面；累计到 `ctx.eagleMs`；>500ms 记 `eagle.slow`，报错记 `eagle.error`（只带参数形状，不带内容）
- 记录规则：写操作成功（`put.create` / `put.replace` / `mkcol` / `delete` / `move` / `copy`）info；普通读取不写文件（debug 才有 `req.done`），除非慢（>1s 且不是 ≥1MB 的传输）→ `req.slow`、出错 → `req.error`（同一个 500 只记一次）、中断 → `req.abort`；系统文件与 0 字节占位的 PUT 降为 debug 级 `req.put.shadow`；设计内的 4xx debug 级 `req.deny`（401 握手除外）；`cli.new`、`auth.fail`（只记来源和次数）、`auth.ban`；`svc.start/listen/stop/config/library/exit`；`imp.pending/done/giveup/timeout/fail`；`sys.bonjour/sleep`；`proc.uncaught`
- 性能：`idx.invalidate`、`idx.rebuild`（>300ms 升 info）；`Metrics` 保留最近 5 分钟样本，每 60 秒（有请求时）写一条 `perf.snapshot`
- 「复制诊断信息」（`src/util/diagnostics.ts`）：版本、Eagle Build、系统、库名与文件夹数、监听与开关、最近 5 分钟性能、日志最近 200 行（不含 debug）；资源库路径替换成 `<资源库>`、用户主目录替换成 `~`；不含密码、哈希、账号名、认证头、文件内容
- 构建时 `__PLUGIN_VERSION__` 由 esbuild 从 `plugin/manifest.json` 注入

## 界面与提示

- 窗口布局：状态卡 → 设置 → 最近连接的设备 → 最近请求与日志（`<details>` 默认收起）；浅色 / 深色跟随系统。设计稿在 Claude Design 画布「Eagle WebDAV 管理窗口重设计」
- 密码框：10 个黑点占位 = 不修改；清空 = 清除密码（哈希置 null）；输入新内容 = 设置新密码；点进去自动全选
- 保存：校验后写配置；**运行中才重启以应用，已停止则只保存、保持停止**；保存 / 放弃都不改变运行 / 停止状态；改动前两个按钮是灰的
- **提示分层，不要混用**：① 操作结果 → toast（`view.toast`，成功 3s，错误 6s 可点关，最多 3 条）；② 持续到解决的问题 → 横幅 + Eagle 系统通知（`logger.notice(key, msg, {kind, title, actions})`：`start-failed`、`build-low`、`pending:<id>`），解决后 `clearNotice`；③ 字段填错 → 行内红字（`view.showFieldError`）；④ 持续的事实 → 状态标签与自动发现黄字（`view.setBonjourNote`）。保存失败必须有错误 toast；手动停止、库切换中不提示
- 端口只接受 1024–65535，旧配置里不合法的值回到默认 41600；`port=0` 只给测试用

## 多语言

见 [decisions.md](decisions.md)「多语言」。
