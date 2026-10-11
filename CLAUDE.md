# Eagle WebDAV

把 Eagle 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端。形态是 Eagle 后台服务插件（`serviceMode: true`），插件内用 Node `http` 手写最小 WebDAV 服务（Class 1 加假锁实现 Class 2）。

## 技术栈
- TypeScript，esbuild 打包为 iife，target node16（Eagle 插件运行时 Node 16.17.1 / Electron 22 / Chromium 108）
- 插件以经典脚本加载，可用 `require`
- 不引入第三方 WebDAV 库

## 已确认的产品决策
- 第一版全功能：OPTIONS、PROPFIND、GET/HEAD、PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK/UNLOCK
- 条目 DELETE = 把整个条目移入 Eagle 回收站（"一删全删"）；文件夹 DELETE 返回 403
- 仅局域网，Basic 认证，默认端口 41600
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
- **Finder 卡顿 60–90s 的根因与修复**：响应要对齐 Go net/http webdav 风格——`Content-Type: text/xml; charset=utf-8`、`creationdate` 不带毫秒、不返回伪造 quota 属性、Allow 头按资源类型给出、`keepAliveTimeout = 0`。见 `probe/plugin/js/davcapture.js`

## 无扩展名 / 不识别格式的策略
PUT 先写影子暂存区，`addFromPath` 加 20s 超时；超时返回 `415` 并清理暂存。

## 里程碑
- M0 探针：已完成（`probe/`），遗留项见下
- M1 骨架：已完成并真机验证（Eagle 内启动、OPTIONS、Basic 认证、局域网访问均正常）。已有：配置与 scrypt 密码、源地址过滤、Basic 认证与封禁、OPTIONS、资源库切换 503、状态窗口、EagleAdapter 接口与 Fake
- M2 只读：已完成并真机验证（Production 库 47 个条目：rclone lsd/ls/copy/check 全部一致，Finder 同款挂载 ls/cp/cmp 正常，列目录约 0.6s，拷贝 0.05s）。**未做**：`@标签` 视图（需先确认标签列表 API）；Finder 手动操作写入留到 M3
- M3 写入：已完成并真机验证（Production 库，`node test/dev/real-write-smoke.mjs <端口> [密码]` 41 项全部通过；挂载点上 `mkdir/cp/mv/覆盖/rm -f` 均正常）。实现：PUT（新建 addFromPath、覆盖 replaceFile、0 字节占位与系统文件进影子暂存区）、MKCOL、DELETE（条目进回收站，文件夹 403）、MOVE/COPY（条目改名与归属增量修改、同名跨目录按引用、改名真复制并带 tags/star/annotation/url、文件夹改名与移动）、PROPPATCH（E 命名空间 tags/star/annotation/url、原子性、dead 属性存内存）。**未实测**：覆盖时换扩展名（现返回 403）、不识别的扩展名导入（可能弹 Eagle 对话框）、Finder 图形界面里的拖拽拷贝、Infuse/iPad
- M4：已完成（变更监听、`@标签`、大库缓存与压测）。
  - 变更监听不另开轮询：每个请求先做新鲜度检查（`library.info().modificationTime`，至少间隔 1.5s，兜底 60s 过期），变化则让文件夹树、条目、标签、目录列表缓存整体失效（`LibraryIndex.revision`）。写操作成功后主动失效。
  - `@标签`：`eagle.tag.get()` 取标签名（元素为带原型 getter 的对象，取 `.name`），`item.get({tags:[名]})` 取条目；视图只读，PUT/MKCOL/DELETE/MOVE/PROPPATCH 及向其中 COPY 均 403，可从中 COPY 出来；配置 `tagsView` 可关闭。
  - 未分类改用 `item.get({isUnfiled:true})`（实测正确；`folders:[]` 等于不过滤）。
  - 缓存：目录列表建了名字/冲突键索引，条目缓存总量 LRU 上限 20 万条。压测（`npx tsx test/dev/bench.ts`，假数据 20 万条）：2 万条目录 Depth:1 约 0.1s、15MB，堆 +20MB；真实瓶颈在 Eagle 自身的 `item.get`，真实大库尚未测过（Production 库仅 48 条）

## M0 遗留（可边做边验）
NFC/NFD 文件名、`replaceFile` 换扩展名、跨设备 LAN、完整 R2（关窗口/退出 Eagle）、大库性能、Infuse 与 iPad 客户端抓包。

## 工作约定
- 每完成一个阶段性工作就提交一次 git（提交信息用中文，带 Co-Authored-By），并把新的结论、约定同步记入本文件
- 与用户用中文交流，中文标点用全角，中英文和数字之间加空格；不用画图讲解；需要确认时用文字直接问
- `probe/` 是只读参考实现，其中 `davcapture.js` 的协议细节、`test/selftest.js` 的协议测试可复用
- 在真机验证前，不要假设 Eagle API 存在某方法；先查本文件的实测事实
- 构建与测试：`npm run build`、`npm run typecheck`、`npm test`（tsx + node:test，`test/unit/`）
- 脚本加载瞬间 `eagle.app` 的 version、build、userDataPath 读不到（曾显示 Build 0），初始化要等 `onPluginCreate`，build 读不到时不拦截启动
- 真机核对结果（Eagle 4.0.0 Build 23）：`eagle.app.userDataPath` 存在（`~/Library/Application Support/Eagle`，配置放其下 `eagle-webdav/`），但要等 `onPluginCreate`；`folder.getAll()` 返回的元素带 `children`，Folder 成员有 `createdAt`、`parent`、`children`、`description`、`icon`、`iconColor`；Item 成员还有 `palettes`、`comments`、`metadataFilePath`、`noThumbnail`、`noPreview`；**`item.get` 带 `fields` 时 `importedAt` / `modifiedAt` 会变成 0**（`getById` 与不带 fields 的 `get` 才是真值，毫秒时间戳），所以列表不用 fields；`item.get({folders:[id]})` 按直属条目工作正常；未分类 = 取全库再过滤（大库慢，M4 优化）
- M3 真机实测：PUT 新建约 40ms；`replaceFile` 后 size 与 modifiedAt 更新、ETag 随之变化；改 `item.name` + `save()` 真实重命名磁盘文件；`item.folders` 增量改写生效；`moveToTrash` 后条目从所有文件夹消失。**内容与库内已有文件相同的导入（含 COPY 改名的真复制）会弹「重复添加提示」，导入要等人点确认才真正入库，`addFromPath` 却立即返回 id**——服务返回 201，但条目暂不可见，日志会警告；无法自动化绕过。`createFolder` 没有对应的删除 API，测试留下的 `__webdav_test_*` 文件夹需手动删除
- 条目名改写（实测）：**导入**时 Eagle 会删除 `" % * : < > ? \ |`、控制/格式字符（软连字符、零宽、方向标记、BOM）、emoji 与符号（©®™★❤✨ 等）、所有辅助平面字符（含 𠮷、旗帜），并修剪首尾空白与尾部点；保留 `# & ; = , [ ] ' ~ ( )`、CJK、重音字母、不间断空格。**改名**（`item.name=` + `save()`）和**文件夹名**不做这些改写。纯 emoji 名导入后得到随机 UUID 名，所以服务对这类名字返回 400。`eagleSanitizeName` 模拟这套规则，路径解析在精确/冲突键匹配失败后用它再找一次，因此客户端按原名读回、覆盖、改名都成立
- `modifiedAt` 新导入为 0，且 `replaceFile` 不更新它：`LibraryIndex.normalize` 取 `modifiedAt || importedAt`，再与本服务替换内容的时间取较大者，ETag 才会随内容变化；Eagle 界面里同大小的外部替换仍无法察觉
- 未知扩展名（如 `.xyz`）导入正常（约 80ms，无对话框）；只有无扩展名会卡住并弹窗，所以服务直接返回 415。覆盖时"换扩展名"不会发生：同一路径的扩展名必然相同
- 吞吐（本机）：80MB PUT 约 3s，GET 约 0.1s；Range 读末尾 1MB 约 40ms；ffprobe / ffmpeg 通过 HTTP 读 mp4（moov 在尾/在头）与 mkv 并 `-ss` 跳转均正常（可代表 Infuse 的取流方式）
- M0 探针已停用（用户不再使用）；本插件监听 0.0.0.0:41600。探针的 `probe/` 代码仍保留作只读参考
- 联调：不依赖 Eagle 用 `npx tsx test/dev/fake-server.ts` 起假数据服务；命令行 `mount_webdav` 带 URL 凭据会返回 22，改用 `osascript -e 'mount volume "http://127.0.0.1:41600/" as user name "eagle" with password "..."'`（走 NetFS，与 Finder 一致）；重载插件页面可在其 DevTools 控制台执行 `location.reload()`（屏幕锁定时 GUI 操作不可用）
- 源码：`src/{config,http,eagle,util,ui}`；只有 `src/eagle/realAdapter.ts` 可直接碰全局 `eagle`；`eagle.app.userDataPath` 未实测，缺失时回退到 `~/.eagle-webdav`
- 探针测试：`node probe/test/selftest.js`；与 rclone 对照：`probe/test/compare.sh`
