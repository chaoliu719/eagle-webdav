# Eagle Plugin API 实测笔记

> 读者：开发者、维护者、AI 协作者。**这是本仓库对 Eagle 行为的唯一事实来源**（`docs/archive/design.md` 写于验证之前，已归档）。
> 环境：Eagle 4.0.0 Build 23，macOS arm64。**在真机验证前，不要假设 Eagle API 存在某方法；先查本文件。** 新的实测结论追加到这里并标注日期。

## 1. API 形态

- `eagle.item` 命名空间：addBookmark、addFromBase64、addFromPath、addFromURL、addItems、convert、count、get、getAll、getById、getByIds、getIdsWithModifiedAt、getSelected、open、query、select。**没有** `moveToTrash` / `replaceFile`
- Item 实例（属性在原型上，`Object.keys` 为空）：方法 save、replaceFile、moveToTrash、refreshThumbnail、setCustomThumbnail 等；属性 id、name、ext、size、tags、folders、filePath、fileURL、thumbnailPath、modifiedAt、importedAt、isDeleted 等；还有 `palettes`、`comments`、`metadataFilePath`、`noThumbnail`、`noPreview`
- `eagle.folder`：create、createSubfolder(parentId,{name})、get、getAll、getById 等；Folder 的 `name`、`parent` 可写后 `save()`；`folder.getAll()` 返回的元素带 `children`；Folder 成员有 `createdAt`、`parent`、`children`、`description`、`icon`、`iconColor`。**没有删除文件夹的 API**，测试留下的 `__webdav_test_*` 文件夹要手动删
- `eagle.library.info()` 返回 folders、modificationTime、path、name 等；没有 `library.modificationTime` / `library.name`
- `eagle.tag.get()` 取标签名（元素为带原型 getter 的对象，取 `.name`）。`@标签` 视图删除后插件不再用它，留作记录
- `eagle.app.userDataPath` 存在（`~/Library/Application Support/Eagle`，配置放其下 `eagle-webdav/`）；缺失时回退到 `~/.eagle-webdav`
- 脚本加载瞬间 `eagle.app` 的 version、build、userDataPath 读不到（曾显示 Build 0），初始化要等 `onPluginCreate`；build 读不到时不拦截启动
- `eagle.app.locale`（官方 i18n 文档里的写法，要等 `onPluginCreate`）：**真机未实测该值的格式**

## 2. 查询与条目行为

- `item.get({folders:[id]})` 按直属条目工作正常
- `item.get({isUnfiled:true})` 正确取未分类；`folders:[]` 等于不过滤
- `item.get({tags:[名]})` 按标签取条目
- `item.get({})` 返回全库是按 `folders:[]` 不过滤推断的，**尚未在真实 Eagle 里实测**，大库首次列目录耗时也未测；太慢时备选是按首字母或导入月份分子目录
- **`item.get` 带 `fields` 时 `importedAt` / `modifiedAt` 会变成 0**（`getById` 与不带 fields 的 `get` 才是真值，毫秒时间戳），所以列表不用 fields
- 条目移入回收站后 `getById` 返回 null，从 `get` / `getByIds` 消失
- 偶发 `getById` 返回 null（I3，未决）
- `modifiedAt`：仅编辑后更新，新导入为 0，`replaceFile` 不更新；本服务取 `modifiedAt || importedAt`，再与本服务替换内容的时间取较大者，ETag 才会随内容变化；Eagle 界面里同大小的外部替换仍无法察觉
- `library.info().modificationTime` 随任何编辑变化，可用于轮询变更

## 3. 写入行为

- `item.folders = [...]` + `save()` 可改所属文件夹（多文件夹，`[]` 即未分类）；增量改写生效；`moveToTrash` 后条目从所有文件夹消失
- 改 `item.name` + `save()` 会真实重命名磁盘文件并改变 `filePath`，所以 **`filePath` 必须每次实时读取**
- `replaceFile` 是实例方法，替换内容不改名；替换后 size 与 modifiedAt 更新（modifiedAt 的例外见上）、ETag 随之变化
- `addFromPath` 返回 id 字符串，会复制文件；`name` 无扩展名时自动补原扩展名；允许同名条目；100MB 约 80ms；PUT 新建约 40ms
- **无扩展名文件导入：Promise 永不 resolve，Eagle 弹 "File format is not recognized"**，必须自己加超时（本服务 20s，超时返回 415 并清理暂存）；未知扩展名（如 `.xyz`）导入正常（约 80ms，无对话框）
- `addBookmark` 可用（约 4.5s，生成 49 字节 `.url`）
- 吞吐（本机）：80MB PUT 约 3s，GET 约 0.1s；Range 读末尾 1MB 约 40ms；ffprobe / ffmpeg 通过 HTTP 读 mp4（moov 在尾 / 在头）与 mkv 并 `-ss` 跳转均正常（可代表 Infuse 的取流方式）

### 条目名改写

**导入**时 Eagle 会删除 `" % * : < > ? \ |`、控制 / 格式字符（软连字符、零宽、方向标记、BOM）、emoji 与符号（©®™★❤✨ 等）、所有辅助平面字符（含 𠮷、旗帜），并修剪首尾空白与尾部点；保留 `# & ; = , [ ] ' ~ ( )`、CJK、重音字母、不间断空格。**改名**（`item.name=` + `save()`）和**文件夹名**不做这些改写。纯 emoji 名导入后得到随机 UUID 名，所以服务对这类名字返回 400。`eagleSanitizeName` 模拟这套规则，路径解析在精确 / 冲突键匹配失败后用它再找一次，因此客户端按原名读回、覆盖、改名都成立。

### 重复添加提示

- 内容与库内已有文件相同的导入（含 COPY 改名的真复制）默认会弹「重复添加提示」，导入要等人点确认才真正入库，**`addFromPath` 却立即返回 id**——服务返回 201，但条目暂不可见，日志会警告；无法自动化绕过。重复内容导入立即返回 id，Eagle 异步弹提示；多个重复提示合并处理时可能丢掉后面的导入
- 判断条目是否真的入库要按**目录列表**确认（`getById` 在弹提示时就已能返回条目，不能用来判断）
- **该提示可以在 Eagle 设置里关掉**（设置 → 收藏设置 →「添加重复文件，弹出通知」，默认勾选）。2026-10-12 实测取消勾选后：同内容的改名 COPY 返回 201 约 170ms，PUT 两个同内容新文件都立即入库、各有独立 id，没有弹窗。我们无法读取这项设置，只在文档里提示
- 同一页设置里的「自动选择添加的新项目」（默认勾选）：导入后 Eagle 可能选中新条目、打断用户在 Eagle 里的选择，**未实测**

## 4. Finder（WebDAVFS/3.0.0）行为

- 挂载探测：`/.metadata_never_index*`、`/.Spotlight-V100`、`/.hidden`、`/._.`、`/.DS_Store` 等，应快速 404
- 写入序列：`PUT` 0 字节（201）→ `LOCK`（Depth 0, Second-600, 独占写）→ `PUT` 带 `If: (<opaquelocktoken:...>)` 含真实内容 → `UNLOCK`。读取也会 LOCK → GET → UNLOCK
- 因此：0 字节 PUT 只进影子暂存区，带内容的 PUT 完成或锁释放时再 `addFromPath`；`.DS_Store`、`._*` 永不入库
- 需要 `DAV: 1, 2`
- **卡顿 60–90s 的根因与修复**：响应要对齐 Go net/http webdav 风格——`Content-Type: text/xml; charset=utf-8`、`creationdate` 不带毫秒、不返回伪造 quota 属性、Allow 头按资源类型给出、`keepAliveTimeout = 0`。实现见 `src/http/server.ts`、`src/dav/props.ts`、`src/http/respond.ts`
- 命令行 `mount_webdav` 带 URL 凭据会返回 22，联调改用 `osascript -e 'mount volume "http://127.0.0.1:41600/" as user name "eagle" with password "..."'`（走 NetFS，与 Finder 一致）
- Finder 的「网络」不会列出 `_webdav._tcp`（真机确认）；Infuse 的发现列表里能看到

## 5. 其他实测

- 端口：1–1023 在监听 127.0.0.1 时 EACCES，监听 0.0.0.0 时却可以，行为不一致所以不开放；41595 是 Eagle 自己的接口端口
- 灌入海量数据：写入初期约 140 张/秒，累积到上万后降到约 13 张/秒（Eagle 自身变慢）；灌到一万多张时插件的监听端口一度断开，约一分钟后恢复（原因未查明）
- NFC / NFD 磁盘文件名归一化：未决。服务端按 NFC 匹配路径，已用 NFD 请求验证

## 6. 仍未验证

Infuse 与 iPad 实机、Finder 图形界面的拖拽、几十万条的真实大库、跨设备 LAN 访问（只在本机经局域网 IP 测过）、`eagle.app.locale` 的真实取值、覆盖时换扩展名（不会发生：同一路径扩展名必然相同）。验证状态总表见 [testing.md](testing.md)。

## Eagle 界面里「全部」「未分类」与文件夹的行为（2026-10-12 真机在 Eagle 界面里实测，用测试条目）
- 一个条目可以同时属于多个文件夹（`item.folders` 是数组；检查器里「文件夹」一栏显示多个标签，侧边栏计数两边各算一次）
- **在文件夹视图里把条目拖到另一个文件夹 = 移动**：从原文件夹去掉、加入目标，提示「已移动至」
- **在「全部」视图里把条目拖到文件夹**：提示也是「已移动至」，但**实际是追加归属**，原有的文件夹保留（实测条目原在 B，拖到 A 后同时在 A 和 B）。因为「全部」没有来源文件夹
- 侧边栏的「未分类」**不是拖放目标**（拖上去没有任何反应）。让条目变成未分类的界面操作是：在检查器的「文件夹」标签上点 ×，去掉最后一个文件夹后条目自动成为未分类（提示「已从 X 移除」）
- **同步延迟**：界面里的这类归属变化，我们的列表缓存有时要等约 30 秒才看到（一次实测从拖拽到列表更新约 30 秒；另外两次 1 到 3 秒内就更新了）。说明 `library.info().modificationTime` 并不总是随归属变化立刻更新，最坏情况靠 60 秒兜底过期。文档里「最多约 1.5 秒」的说法不准确
- **删除（⌘⌫）在不同视图里的行为（2026-10-12 真机实测）**：
  - 文件夹视图里删**单归属**条目：不弹窗，整个进回收站（提示「1 个项目已删除」，回收站计数 +1）
  - 文件夹视图里删**多归属**条目：弹窗「部分项目同时保存在多个文件夹中，你想要如何处理这些项目？」，默认选项「仅从当前文件夹移除，不丢到回收站」，另一个选项「丢到回收站」。按默认确认后：只从当前文件夹去掉，其他文件夹里还在，回收站不变（提示文字仍是「已删除」，别被误导）
  - 「全部」视图里删多归属条目：**不弹窗**，整个进回收站（所有文件夹里都消失）
  - 在没有选中条目时按 Backspace（⌫）是「后退」，不是删除；删除要用 ⌘⌫

