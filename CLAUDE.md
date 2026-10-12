# Eagle WebDAV

把 Eagle 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端。形态是 Eagle 后台服务插件（`serviceMode: true`），插件内用 Node `http` 手写最小 WebDAV 服务（Class 1 加假锁实现 Class 2）。

## 命名（用户明确要求，Eagle 内不带 "Eagle"）
- 清单 `name` 为 `{{manifest.app.name}}`，名字在 `plugin/_locales/{en,zh_CN,zh_TW}.json`：en「WebDAV Share」，中文「WebDAV 共享」；窗口标题与头部、Eagle 系统通知标题（`WebDAV 共享 · …`）同名。Eagle 之外要认得出：Bonjour 服务名 `Eagle 素材库 (主机名)`，Basic 认证 Realm `Eagle Library`（须英文）。仓库名、README 标题、插件 ID `EAGLEWEBDAV01` 不变

## 技术栈
- TypeScript，esbuild 打包为 iife，target node16（Eagle 插件运行时 Node 16.17.1 / Electron 22 / Chromium 108）
- 插件以经典脚本加载，可用 `require`
- 不引入第三方 WebDAV 库

## 已确认的产品决策
- 第一版全功能：OPTIONS、PROPFIND、GET/HEAD、PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK/UNLOCK
- 条目 DELETE = 把整个条目移入 Eagle 回收站（"一删全删"）；文件夹 DELETE 返回 403
- 仅局域网（来源地址白名单），Basic 认证，默认端口 41600。**管理密码留空 = 不做认证，任何访问都当管理账号，也允许监听非本机地址**（用户明确要求，不再为用户做额外的安全限制）；设了管理密码才启用认证。**只读账号功能已按用户要求整体删除**（配置、认证角色、窗口、测试都不再有）；「额外允许的来源网段」也已删除，来源只按内置的内网/回环白名单过滤
- PROPFIND Depth: infinity 返回 403 `propfind-finite-depth`

## 实测事实（Eagle 4.0.0 Build 23，macOS arm64）
### Plugin API 形态
- `eagle.item` 命名空间：addBookmark、addFromBase64、addFromPath、addFromURL、addItems、convert、count、get、getAll、getById、getByIds、getIdsWithModifiedAt、getSelected、open、query、select。**没有** `moveToTrash` / `replaceFile`
- Item 实例（属性在原型上，`Object.keys` 为空）：方法 save、replaceFile、moveToTrash、refreshThumbnail、setCustomThumbnail 等；属性 id、name、ext、size、tags、folders、filePath、fileURL、thumbnailPath、modifiedAt、importedAt、isDeleted 等
- `eagle.folder`：create、createSubfolder(parentId,{name})、get、getAll、getById 等；Folder 的 `name`、`parent` 可写后 `save()`
- `eagle.library.info()` 返回 folders、modificationTime、path、name 等；没有 `library.modificationTime` / `library.name`
### 行为
- `item.folders = [...]` + `save()` 可改所属文件夹（多文件夹，`[]` 即未分类）
- 改 `item.name` + `save()` 会真实重命名磁盘文件并改变 `filePath`，所以 `filePath` 必须每次实时读取
- `addFromPath` 返回 id 字符串，会复制文件；`name` 无扩展名时自动补原扩展名；允许同名条目；100MB 约 80ms
- **无扩展名文件导入：Promise 永不 resolve，Eagle 弹 "File format is not recognized"**，必须自己加超时
- 重复内容导入：立即返回 id，Eagle 异步弹重复提示框
- 条目移入回收站后 `getById` 返回 null，从 `get` / `getByIds` 消失
- 条目 `modifiedAt` 仅编辑后更新；`library.info().modificationTime` 随任何编辑变化，可用于轮询变更
- `replaceFile` 是实例方法，替换内容不改名（换扩展名的行为未确认）
- `addBookmark` 可用（约 4.5s，生成 49 字节 `.url`）
- 未决：NFC/NFD 磁盘文件名归一化；偶发 `getById` 返回 null（I3）

### Finder（WebDAVFS/3.0.0）行为
- 挂载探测：`/.metadata_never_index*`、`/.Spotlight-V100`、`/.hidden`、`/._.`、`/.DS_Store` 等，应快速 404
- 写入序列：`PUT` 0 字节(201) → `LOCK`(Depth 0, Second-600, 独占写) → `PUT` 带 `If: (<opaquelocktoken:...>)` 含真实内容 → `UNLOCK`。读取也会 LOCK → GET → UNLOCK
- 因此：0 字节 PUT 只进影子暂存区，带内容的 PUT 完成或锁释放时再 `addFromPath`；`.DS_Store`、`._*` 永不入库
- 需要 `DAV: 1, 2`
- **Finder 卡顿 60–90s 的根因与修复**：响应要对齐 Go net/http webdav 风格——`Content-Type: text/xml; charset=utf-8`、`creationdate` 不带毫秒、不返回伪造 quota 属性、Allow 头按资源类型给出、`keepAliveTimeout = 0`。实现见 `src/http/server.ts`、`src/dav/props.ts`、`src/http/respond.ts`

## 无扩展名 / 不识别格式的策略
PUT 先写影子暂存区，`addFromPath` 加 20s 超时；超时返回 `415` 并清理暂存。

## 里程碑
- M0 探针：已完成并已删除，结论都在上文「实测事实」
- M1 骨架：已完成并真机验证（Eagle 内启动、OPTIONS、Basic 认证、局域网访问均正常）。已有：配置与 scrypt 密码、源地址过滤、Basic 认证与封禁、OPTIONS、资源库切换 503、状态窗口、EagleAdapter 接口与 Fake
- M2 只读：已完成并真机验证（Production 库 47 个条目：rclone lsd/ls/copy/check 全部一致，Finder 同款挂载 ls/cp/cmp 正常，列目录约 0.6s，拷贝 0.05s）。**未做**：`@标签` 视图（需先确认标签列表 API）；Finder 手动操作写入留到 M3
- M3 写入：已完成并真机验证（Production 库，`node test/dev/real-write-smoke.mjs <端口> [密码]` 41 项全部通过；挂载点上 `mkdir/cp/mv/覆盖/rm -f` 均正常）。实现：PUT（新建 addFromPath、覆盖 replaceFile、0 字节占位与系统文件进影子暂存区）、MKCOL、DELETE（条目进回收站，文件夹 403）、MOVE/COPY（条目改名与归属增量修改、同名跨目录按引用、改名真复制并带 tags/star/annotation/url、文件夹改名与移动）、PROPPATCH（E 命名空间 tags/star/annotation/url、原子性、dead 属性存内存）。**未实测**：覆盖时换扩展名（现返回 403）、不识别的扩展名导入（可能弹 Eagle 对话框）、Finder 图形界面里的拖拽拷贝、Infuse/iPad
- M4：已完成（变更监听、`@标签`、大库缓存与压测）。
  - 变更监听不另开轮询：每个请求先做新鲜度检查（`library.info().modificationTime`，至少间隔 1.5s，兜底 60s 过期），变化则让文件夹树、条目、标签、目录列表缓存整体失效（`LibraryIndex.revision`）。写操作成功后主动失效。
  - `@全部`（用户要求，开关 `allView` 只在配置文件里，窗口不放）：根目录虚拟目录，`getAllItems()` = `item.get({})` 平铺全库，只读规则与 `@标签` 共用 `isReadOnlyView`（`viaView`），可从中 COPY 出来；**`item.get({})` 返回全库是按 `folders:[]` 不过滤推断的，尚未在真实 Eagle 里实测**，大库首次列目录的耗时也未测；太慢时的备选是按首字母或导入月份分子目录。
  - `@标签`：`eagle.tag.get()` 取标签名（元素为带原型 getter 的对象，取 `.name`），`item.get({tags:[名]})` 取条目；视图只读，PUT/MKCOL/DELETE/MOVE/PROPPATCH 及向其中 COPY 均 403，可从中 COPY 出来；配置 `tagsView` 可关闭。
  - 未分类改用 `item.get({isUnfiled:true})`（实测正确；`folders:[]` 等于不过滤）。
  - 缓存：目录列表建了名字/冲突键索引，条目缓存总量 LRU 上限 20 万条。压测（`npx tsx test/dev/bench.ts`，假数据 20 万条）：2 万条目录 Depth:1 约 0.1s、15MB，堆 +20MB；真实瓶颈在 Eagle 自身的 `item.get`，真实大库尚未测过（Production 库仅 48 条）

## 体验增强（已真机验证）
- 状态窗口：自动发现 / 防休眠状态、最近连接的客户端（「连接地址」小节含复制按钮与二维码，按用户要求已删除，依赖 `qrcode-generator` 同时移除；局域网 IP 仍可在「设置 → 监听地址」下拉框里看到）（按 User-Agent 识别 Finder / Infuse / rclone 等）、提示横幅（可「忽略」）。`198.18.0.0/15`（Surge 虚拟网卡）不列入监听地址下拉框
- Bonjour：Infuse 的发现列表里能看到（真机确认），**Finder 的「网络」不会列出 `_webdav._tcp`（真机确认），Finder 仍须 ⌘K 手输地址**；`dns-sd -R "Eagle 素材库 (主机名)" _webdav._tcp local <端口>`，仅对局域网开放时注册；子进程在页面 `pagehide`、停止、退出时结束，启动时 `pkill -f 'dns-sd -R Eagle '` 清理上次遗留
- 防休眠：**只有传输类请求（GET / PUT / COPY / MOVE）才计入**，浏览目录与心跳（PROPFIND / OPTIONS / LOCK / HEAD）不计，否则 Finder 挂着空闲的卷（实测 258 个请求多是心跳）会让 Mac 永远睡不着；有传输时起 `caffeinate -i -w <进程号>`，最后一次传输结束后再留 60s 才放开（给播放器请求间隙，防止播到一半睡着），`-w` 保证宿主进程退出后它也退出。窗口里的提示在这 60s 缓冲期内也会显示
- 重复添加提示：`importAt` 后按**目录列表**确认条目是否出现（`getById` 在弹提示时就已能返回条目，不能用来判断）；没出现就给横幅并用 `eagle.notification.show` 通知，后台每 5s 轮询，入库后自动撤销，10 分钟放弃。实测 Eagle 把多个重复提示合并处理时可能丢掉后面的导入

## 仍未验证
Infuse 与 iPad 实机、Finder 图形界面的拖拽、几十万条的真实大库、跨设备 LAN 访问（只在本机经局域网 IP 测过）、NFC/NFD 磁盘文件名归一化（服务端按 NFC 匹配路径，已用 NFD 请求验证）。

## 发布与维护
- 版本 1.0.0；`npm run package` 生成 `dist/eagle-webdav-<版本>.eagleplugin` 与同内容的 `.zip`（实测 Eagle「打包插件」产物就是 plugin/ 内容的 zip，文件名 `Eagle WebDAV.eagleplugin`，生成在项目根目录，已 gitignore）。**安装流程已真机验证**：`open dist/eagle-webdav-<版本>.eagleplugin`（双击同理）→ Eagle 弹出「Install eagle-webdav-<版本>?」→ 点 Install → 装到 `~/Library/Application Support/Eagle/Plugins/EAGLEWEBDAV01`，`runAfterInstall` 使服务立即自启并沿用 `eagle-webdav/config.json`；「开发」标签里的「卸载」只移除登记，不删项目源码，也不删配置目录；`npm run check` = 类型检查 + 单元测试 + 构建；CI 见 `.github/workflows/ci.yml`
- `plugin/manifest.json` 的 `devTools` 现为 `false`。开发调试时临时改成 `true` 可弹出开发者工具（控制台可 `location.reload()`）；不开 DevTools 时，用 Eagle 工具栏「插件 → 开发」标签里该插件右侧「…」菜单的「重新加载」，并改完 manifest 后需重新加载才生效

## 日志系统（用户确认的精简方案，设计稿在画布「日志系统」）
- 给开发者留证据，**窗口里只多两个按钮**（「最近请求与日志」折叠区底部：复制诊断信息、打开日志文件夹）；不做「活动」人话列表、响应指示灯、同类合并（用户认为必要性和可实现性不足，已砍）
- 文件日志默认开启：`<配置目录>/logs/webdav-YYYY-MM-DD.log`，每行一条 JSON（`ts level cat ev rid …`），批量（200ms）同步追加，单文件 5MB 滚动成 `.N.log`，保留 7 天，总量 35MB；写失败只计数不影响服务（`src/util/fileLog.ts`）。级别 `logLevel`（error/warn/info/debug，默认 info）只在配置文件里改，窗口没有开关
- 入口 `Logger.log(level, cat, ev, fields, text?)`；`info/warn/error` 保留为 `cat:"misc"`。分类：svc / req / eagle / idx / imp / cli / sys / perf / auth / proc。窗口与 eagle.log 只收 info 及以上
- 请求号：`AsyncLocalStorage`（`src/util/reqctx.ts`）每请求一个 6 位 `rid`，同一请求的所有日志（含 Eagle 调用）共用；handler 用 `noteReq({...})` 补字段（条目 id、条目数）。注意 `res.on('finish')` 这类事件回调里拿不到上下文，要用闭包里的 ctx
- Eagle 调用计时：`instrumentAdapter`（Proxy 装饰器，`src/eagle/instrumented.ts`）在 main.ts 里套在 `RealEagleAdapter` 外面，`realAdapter.ts` 不动；累计到 `ctx.eagleMs`；>500ms 记 `eagle.slow`（warn），报错记 `eagle.error`（只带参数形状如 `str,arr2`，不带内容），debug 级记每次调用；导入超时是预期内的，不记 eagle.error
- 记录规则：写操作成功（`put.create` 201 / `put.replace` / `mkcol` / `delete` / `move` / `copy`）info；普通读取（GET、PROPFIND、心跳）**不写文件**（debug 才有 `req.done`），除非慢（>1s 且不是 ≥1MB 的传输）→ `req.slow`（warn，带 eagleMs 拆分和条目数）、出错 → `req.error`（带堆栈前 3 行，同一个 500 只记一次）、中断 → `req.abort`；系统文件与 0 字节占位的 PUT（只进影子暂存区）降为 debug 级 `req.put.shadow`，不再冒充 `put.create`；插件页面关闭 / 重载记 `svc.exit`（重载时服务不会走 stop，之前日志里看不出）；设计内的 4xx（403/415…，401 握手除外）debug 级 `req.deny`；`cli.new` 新客户端首次出现；认证失败 `auth.fail`（只记来源和次数，不记尝试的账号密码）、封禁 `auth.ban`；`svc.start/listen/stop/config/library`（config 只记改了哪些字段名）；`imp.pending/done/giveup/timeout/fail`；`sys.bonjour/sleep`；`proc.uncaught`（window 的 error / unhandledrejection 与 process uncaughtException）
- 缓存与性能：`idx.invalidate`（debug，原因 library-modified / library-switched / expired / write）、`idx.rebuild`（debug，>300ms 升 info）；`LibraryIndex.stats` 累计命中/未命中（条目缓存与目录列表缓存）；`Metrics` 保留最近 5 分钟样本，每 60 秒写一条 `perf.snapshot`（这 60 秒内有请求才写：各方法请求数、p50/p95、缓存命中率增量、堆内存、在途峰值）
- 「复制诊断信息」（`src/util/diagnostics.ts`）：版本、Eagle Build、系统、库名与文件夹数、监听与开关、最近 5 分钟性能、文件日志最近 200 行（不含 debug）；资源库路径替换成 `<资源库>`、用户主目录替换成 `~`；不含密码与哈希、账号名、认证头、文件内容。设计稿里的「条目数」改成了文件夹数（`item.count` 的行为没实测）。剪贴板不可用时 toast 提示去日志文件夹取文件
- 构建时 `__PLUGIN_VERSION__` 由 esbuild 从 `plugin/manifest.json` 注入；预览脚本 `test/dev/ui-preview.mjs` 已给 `async_hooks`、更多 fs 方法打桩（写入的日志在 `window.__logfile`）
- 未实测：真实 Eagle 里的日志文件落盘与「打开日志文件夹」（`open` 命令）、真实库上的性能快照数字

## 补充笔记（实测与实现）
- 脚本加载瞬间 `eagle.app` 的 version、build、userDataPath 读不到（曾显示 Build 0），初始化要等 `onPluginCreate`，build 读不到时不拦截启动
- 真机核对结果（Eagle 4.0.0 Build 23）：`eagle.app.userDataPath` 存在（`~/Library/Application Support/Eagle`，配置放其下 `eagle-webdav/`），但要等 `onPluginCreate`；`folder.getAll()` 返回的元素带 `children`，Folder 成员有 `createdAt`、`parent`、`children`、`description`、`icon`、`iconColor`；Item 成员还有 `palettes`、`comments`、`metadataFilePath`、`noThumbnail`、`noPreview`；**`item.get` 带 `fields` 时 `importedAt` / `modifiedAt` 会变成 0**（`getById` 与不带 fields 的 `get` 才是真值，毫秒时间戳），所以列表不用 fields；`item.get({folders:[id]})` 按直属条目工作正常；未分类 = 取全库再过滤（大库慢，M4 优化）
- M3 真机实测：PUT 新建约 40ms；`replaceFile` 后 size 与 modifiedAt 更新、ETag 随之变化；改 `item.name` + `save()` 真实重命名磁盘文件；`item.folders` 增量改写生效；`moveToTrash` 后条目从所有文件夹消失。**内容与库内已有文件相同的导入（含 COPY 改名的真复制）会弹「重复添加提示」，导入要等人点确认才真正入库，`addFromPath` 却立即返回 id**——服务返回 201，但条目暂不可见，日志会警告；无法自动化绕过。`createFolder` 没有对应的删除 API，测试留下的 `__webdav_test_*` 文件夹需手动删除
- **重复添加提示可以在 Eagle 设置里关掉**（设置 → 收藏设置 →「添加重复文件，弹出通知」，默认勾选）。2026-10-12 真机实测取消勾选后：同内容的改名 COPY 返回 201 约 170ms（原来要等 3 次入库轮询 ~1s），PUT 两个同内容新文件都立即入库、各有独立 id，没有弹窗、没有 `imp.pending`、没有「等你确认」横幅。我们没法读取这项设置，所以只在文档里提示。同一页设置里还有「自动选择添加的新项目」（默认勾选）：导入后 Eagle 可能选中新条目、打断用户在 Eagle 里的选择，**未实测**
- 条目名改写（实测）：**导入**时 Eagle 会删除 `" % * : < > ? \ |`、控制/格式字符（软连字符、零宽、方向标记、BOM）、emoji 与符号（©®™★❤✨ 等）、所有辅助平面字符（含 𠮷、旗帜），并修剪首尾空白与尾部点；保留 `# & ; = , [ ] ' ~ ( )`、CJK、重音字母、不间断空格。**改名**（`item.name=` + `save()`）和**文件夹名**不做这些改写。纯 emoji 名导入后得到随机 UUID 名，所以服务对这类名字返回 400。`eagleSanitizeName` 模拟这套规则，路径解析在精确/冲突键匹配失败后用它再找一次，因此客户端按原名读回、覆盖、改名都成立
- `modifiedAt` 新导入为 0，且 `replaceFile` 不更新它：`LibraryIndex.normalize` 取 `modifiedAt || importedAt`，再与本服务替换内容的时间取较大者，ETag 才会随内容变化；Eagle 界面里同大小的外部替换仍无法察觉
- 未知扩展名（如 `.xyz`）导入正常（约 80ms，无对话框）；只有无扩展名会卡住并弹窗，所以服务直接返回 415。覆盖时"换扩展名"不会发生：同一路径的扩展名必然相同
- 吞吐（本机）：80MB PUT 约 3s，GET 约 0.1s；Range 读末尾 1MB 约 40ms；ffprobe / ffmpeg 通过 HTTP 读 mp4（moov 在尾/在头）与 mkv 并 `-ss` 跳转均正常（可代表 Infuse 的取流方式）
- 补齐项（已真机验证）：写入类方法支持 `If-Match` / `If-None-Match`（412）；LOCK 永不拒绝并对不存在的 URL 建占位（Finder 崩溃留下的旧锁不会把自己锁死）；`E:width` / `E:height`；上传 120s 空闲中止；启动时清理上次遗留的临时目录、退出时 `dispose()`
- litmus 0.17 已跑（2026-10-12，`npx tsx test/dev/fake-server.ts 41650` + `node test/dev/litmus-proxy.mjs 41651 127.0.0.1:41650`，源码从 notroj.github.io/litmus 下载后 `./configure --with-included-neon && make`，对 `http://127.0.0.1:41651/` 用账号 eagle / test，**每个套件前重启假服务**，否则上次残留的 `/litmus` 文件夹会让 MKCOL 405）。代理的作用：本服务对无扩展名文件返回 415，litmus 的资源名都没有扩展名，所以代理给末段补 `.dat` 并在响应里抹掉。结果 basic 14/16、copymove 8/13、props 33/33、locks 27/40、http 4/4。**剩下的失败都是设计决定，不是缺陷**：文件夹 DELETE / COPY / 覆盖文件夹 → 403（Eagle 无删除文件夹 API，不支持复制文件夹）；`notowner_*`、带伪造 lock-token 的条件 PUT 应 412 → 假锁永不拒绝（不校验 If 里的令牌，否则 Finder 在插件重启后拿旧令牌会被拒）；copy_shallow 的 405 是 copy_coll 失败留下的连锁。litmus 发现并已修：格式错误的 PROPFIND / PROPPATCH 体返回 400（`isWellFormed`）、`xmlns='…'` 单引号、`xmlns=""` 空命名空间 dead 属性、同一请求内 remove / set 按文档顺序、dead 属性随 MOVE / COPY 走并在 DELETE 时清掉
- e2e 预置数据：`node test/dev/seed-e2e.mjs [端口] [密码]` 经插件的 WebDAV 写进当前打开的真实资源库（2026-10-12 已在 Production 库灌入，幂等可重跑），顶层文件夹 `__e2e__`（图片 / 文档 / 嵌套 / 大文件 / 元数据 / 多归属）加 `@未分类/__e2e__-unfiled.txt`；含中文与特殊字符文件名、6MB 随机文件（sha256 `4c90a153…59c9`）、带标签 `e2e` `测试` / 星级 / 注释 / 来源链接的条目、同一条目属于甲乙两个文件夹。文件夹建了就删不掉，要清理只能在 Eagle 里手动删
- 海量图片：`node test/dev/seed-many-images.mjs [数量=5000]` 往 `__e2e__/海量图片/` 灌 32×32 小 png（`img-00001.png` 起，内容各不相同，幂等可续传）。已在 Production 库灌入 20000 张。实测：写入初期约 140 张/秒，累积到上万后降到约 13 张/秒（Eagle 自身变慢）；灌到一万多张时插件的监听端口一度断开，约一分钟后恢复（原因未查明，脚本现在会退避重试）；2 万条目录 Depth:1 的 PROPFIND 约 0.23s、15.7MB（命中缓存）
- 未做：dead 属性不落盘；真实锁语义（有意不做）；目录 `getlastmodified` 取目录创建时间而非内部最新修改
- M0 探针已停用（用户不再使用）；本插件监听 0.0.0.0:41600
- 端口范围：窗口与配置都只接受 **1024–65535**（用户明确要求；1–1023 实测在监听 127.0.0.1 时 EACCES，监听 0.0.0.0 时却可以，行为不一致所以不开放），配置里的旧值不合法会回到默认 41600；`port=0`（系统分配）只给测试用；41595 是 Eagle 自己的接口端口
- **提示系统（用户明确要求，按性质分层，不要混用）**：① 操作结果 → toast（`view.toast`，成功 / 提示 3s，错误 6s 可点关，最多 3 条）；② 持续到解决、要用户处理的问题 → 横幅 + Eagle 系统通知（`logger.notice(key, msg, {kind:'error'|'warn', title, actions})`；启动失败 `start-failed`（改端口 / 重试）、Eagle 版本过低 `build-low`、等待重复添加确认 `pending:<id>`），解决后 `clearNotice`；③ 字段填错 → 行内红字（`view.showFieldError('port'|'user', …)`，改动该字段即消失，不用 toast）；④ 持续的事实 → 状态标签（「保持唤醒」「已修改」）与自动发现的黄字（`view.setBonjourNote`）。不再有「状态行」；保存失败必须有错误 toast（捕获异常）；手动停止服务、资源库切换中等内部状态不提示，切换完成给一条 info toast。设计稿在画布「提示系统」
- 窗口界面按设计稿（Claude Design 画布「Eagle WebDAV 管理窗口重设计」）实现：状态卡（图标、资源库名、运行中开关、连接地址 + 复制）→ 设置（谁能访问：仅这台 Mac / 局域网内的设备，对应 host 127.0.0.1 / 0.0.0.0，没改动时保留原监听地址；端口；账号；密码；两个开关选项；改动的字段旁标「已修改」；保存 / 放弃）→ 最近连接的设备（图标、请求数、刚刚/N 分钟前、空状态）→ 最近请求与日志（`<details>` 默认收起）；浅色 / 深色跟随系统。用户明确删掉的说明文字（自动发现说明、阻止休眠常驻提示、「所有网卡」警告、「密码留空…」、只读账号、来源网段）没有加回。窗口可不装进 Eagle 直接预览与点测：`node test/dev/ui-preview.mjs`，再用浏览器打开 `http://127.0.0.1:41777/`（`?pw=1` 模拟已设置密码；页面里 `window.__fakeRequest(ua, ip, method)` 可模拟客户端请求，用来看设备列表）。已设置的密码在输入框里显示为 10 个黑点占位：黑点 = 不修改；清空 = 清除密码（保存后哈希置 null，即不再认证）；输入新内容 = 设置新密码；点进去自动全选，点「放弃」恢复；设置区有「保存」「放弃」，保存会校验后写配置：**运行中才重启以应用，已停止则只保存、保持停止**（保存 / 放弃都不改变运行 / 停止状态，用户明确要求），改动前两个按钮是灰的
- 联调：不依赖 Eagle 用 `npx tsx test/dev/fake-server.ts` 起假数据服务；命令行 `mount_webdav` 带 URL 凭据会返回 22，改用 `osascript -e 'mount volume "http://127.0.0.1:41600/" as user name "eagle" with password "..."'`（走 NetFS，与 Finder 一致）；重载插件页面可在其 DevTools 控制台执行 `location.reload()`（屏幕锁定时 GUI 操作不可用）
- 源码：`src/{config,http,eagle,util,ui}`；只有 `src/eagle/realAdapter.ts` 可直接碰全局 `eagle`；`eagle.app.userDataPath` 未实测，缺失时回退到 `~/.eagle-webdav`
- 与 rclone 对照：`npx tsx test/dev/fake-server.ts` 起假数据服务后用 rclone 联调

## 工作约定
- 每完成一个阶段性工作就提交一次 git（提交信息用中文，带 Co-Authored-By），并把新的结论、约定同步记入本文件
- 与用户用中文交流，中文标点用全角，中英文和数字之间加空格；不用画图讲解；需要确认时用文字直接问
- M0 探针（`probe/`）已删除，历史在 git 里（最后一次存在于提交 `a8ba0f8` 及之前）；其协议细节已并入 `src/`，协议测试已被 `test/unit/` 取代
- 在真机验证前，不要假设 Eagle API 存在某方法；先查本文件的实测事实
- 构建与测试：`npm run build`、`npm run typecheck`、`npm test`（tsx + node:test，`test/unit/`）
