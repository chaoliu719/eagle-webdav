> **实测修正（Eagle 4.0.0 Build 23）**：本文写于真机验证之前，下列几处已被实测推翻或改变，以仓库根目录 [CLAUDE.md](../CLAUDE.md) 为准。
>
> | 本文说法 | 实测结论 |
> | --- | --- |
> | `item.get` 带 `fields` 可减小开销（6.1 节） | 带 `fields` 时 `importedAt` / `modifiedAt` 会变成 0，列表查询不用 `fields` |
> | 未分类用 `item.get({isUnfiled: true, fields})` | `{isUnfiled: true}` 正确；`{folders: []}` 等于不过滤 |
> | 新导入条目有可用的 `modifiedAt`，ETag 取 id-modifiedAt-size | 新导入为 0 且 `replaceFile` 不更新；取 `modifiedAt \|\| importedAt` 再叠加本服务的替换时间 |
> | 导入后条目名与请求名一致 | 导入时 Eagle 会删掉 `: ? * " < > \ \| %`、emoji 等；服务按同规则匹配（见 CLAUDE.md） |
> | 重名消歧后即可 | 内容相同的导入会触发 Eagle「重复添加提示」，需人工确认 |
> | 5.11：永不拒绝加锁 | 已按此实现（旧版实现曾返回 423，已改） |
> | 4.1：根目录 PUT | 根目录不能放条目，PUT 返回 403 |
> | 8.2：`keepAliveTimeout` 65 秒 | 与 Go net/http webdav 对齐，`keepAliveTimeout = 0`，否则 Finder 卡顿 60–90 秒 |
> | 6.2：后台轮询变更 | 改为按请求惰性检查 `library.info().modificationTime`，无独立轮询 |
> | 8.1：`src/dav/handlers/*.ts` 等 | 实际目录见 README |
> | 8.3：manifest `name` 为 "Eagle WebDAV" | 现为 `{{manifest.app.name}}`，名字在 `plugin/_locales/`（「WebDAV 共享」）；见 CLAUDE.md「命名」 |
> | 只读账号、额外允许的来源网段 | 已按产品决策整体删除；管理密码留空 = 不认证 |

# Eagle WebDAV 后台服务插件：调研结论与详细设计文档

结论先行：按既定路线，在 Eagle 4.0「后台服务」插件里用 Node 的 http 模块手写一个精简的 WebDAV 服务端（Class 1 加假锁 Class 2），技术上可行，而且有官方先例：Eagle 官方的 MCP Server 插件就在插件内监听本地端口，其更新日志里出现过“端口被占用时无法重启”和“阻止局域网其他设备访问”的修复。但调研发现一个必须立即纠正的前提：iOS 与 iPadOS「文件」App 的「连接服务器」在现有资料中只支持 SMB，原生不支持 WebDAV，因此 iPad、iPhone 端需要借助 Infuse 或第三方 WebDAV 文件提供者 App。

## TL;DR

- **可以做，建议手写协议层**：后台服务插件随 Eagle 启动，可以使用 Node 原生模块。Plugin API 已有全部关键写能力：item.name、item.folders、item.moveToTrash、item.replaceFile，以及自 4.0 Build12 起可写的 folder.parent。建议用户升级到当前最新的 4.0 Build23；插件硬性要求不低于 Build12，推荐不低于 Build22。官方文档写明插件运行时是 Chromium 107 加 Node 16，所以不建议引入 nephele 等框架，手写精简实现更稳妥。
- **客户端前提需要修正**：
  - Finder 只有在服务端声明 Class 2 并支持 LOCK 时才读写挂载，否则只读。
  - Windows 默认禁止在 HTTP 上使用 Basic 认证；单文件上限默认 50,000,000 字节（Microsoft 存档博客原文为“FileSizeLimitInBytes Default is 50000000 bytes.”）。
  - iOS「文件」App 原生只支持 SMB，iPad、iPhone 应使用 Infuse（官方列明支持 WebDAV）或第三方 WebDAV App。
- **最大风险是 4 个待实测点**：
  - 后台服务监听局域网地址时，macOS 防火墙会不会拦截。
  - 给 item.folders 赋值后，save() 是否完整生效。
  - 通过 API 改名是否同步重命名磁盘文件（社区 issue 显示在界面里改名会重命名）。
  - Finder 复制文件时“0 字节 PUT、LOCK、再次 PUT”的写入顺序，与 Eagle 的导入语义冲突。

  第一版必须内置“影子暂存区”，用来吸收 Finder 的临时文件和 0 字节占位写入。

## 一、目标与非目标

### 1.1 目标

- 在 Eagle 所在的 Mac 上以后台服务插件形式提供 WebDAV 服务，随 Eagle 启动、随 Eagle 退出。
- 第一版覆盖全部方法：OPTIONS、PROPFIND、GET、HEAD、PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK、UNLOCK。
- 主视图为 Eagle 文件夹树，另设「未分类」虚拟目录和只读的「按标签」视图。
- 主要客户端：Finder（读写挂载）、Infuse、iPad 与 iPhone 上的第三方 WebDAV App、Cyberduck、rclone。
- 所有数据读写都通过 Plugin API；所有文件读取路径都必须来自 Plugin API 返回的 filePath。

### 1.2 非目标

- 不做永久删除和回收站恢复，不删除普通文件夹（DELETE 文件夹返回 403）。
- Eagle 未运行时不提供服务，不做解析 metadata.json 的降级方案。
- 不内置 HTTPS，不实现真实锁语义，不暴露智能文件夹（Build22 起有 eagle.smartFolder，可留待后续版本）。

## 二、调研结论汇总

置信度说明：「高」表示官方文档或 RFC 原文明确；「中」表示官方产品行为或可靠社区实践间接证明；「低」表示推测，并标记「未验证」。

### 2.1 Eagle 插件运行环境

| 编号 | 结论 | 来源类型 | 置信度 |
| --- | --- | --- | --- |
| E1 | 在 manifest.json 的 main 中加入 "serviceMode": true 即为后台服务插件，随软件启动自动执行；后台服务也可以弹出窗口显示进度与状态 | 官方文档「Background Service」 | 高 |
| E2 | Plugin API 基于 Chromium 107 和 Node 16，支持 Node 原生 API 与第三方模块，第三方模块用 require() 引入 | 官方文档「Introduction」「Using Third-Party Modules」 | 高（版本号可能已过时，需打印 process.versions 实测） |
| E3 | 插件内可以监听端口：官方 MCP Server 插件页写明要求“Eagle 4.0 Build 12 (2025-09-14) or later”，更新日志里有“Security update to prevent other devices on the local network from accessing the MCP server”和“Fixed MCP server unable to restart when port is occupied”两条修复（版本号 v0.0.3、v0.0.6 来自早前抓取的页面） | Eagle 社区插件页 community-en.eagle.cool/plugin/mcp-server（开发者为 Eagle App） | 中 |
| E4 | 可用事件只有 onPluginCreate、onPluginRun、onPluginBeforeExit、onPluginShow、onPluginHide、onLibraryChanged（参数为新资源库路径）、onThemeChanged；没有素材或文件夹增删改事件，也没有选中变化事件 | 官方文档「event」 | 高 |
| E5 | Build22 新增插件启用与停用；服务类插件（AI Search、MCP Server 等）在偏好设置里有独立开关，停用后不再消耗系统资源 | 官方博客 Build 22 | 高 |
| E6 | 插件窗口隐藏或关闭后服务是否继续运行，文档未说明 | 无 | 低，未验证 |
| E7 | 调试：manifest 的 devTools 字段开启调试窗口，窗口插件按 F12 打开 DevTools；可用 eagle.log 写入 Eagle 日志 | 官方文档「Debug Plugin」「manifest.json Configuration」 | 高 |
| E8 | 本地开发：工具栏「插件」、「开发者选项」、「创建插件」即可运行；审核只针对上架插件中心（2026 年 7 月 21 日起执行新审核要求） | 官方文档「Your First Plugin」与 Changelog | 高（本地使用无需审核属合理推断） |
| E9 | 当前最新版本为 4.0.0 Build23 | 官方下载页 | 高 |

### 2.2 Plugin API 能力与 build 要求

| 编号 | 结论 | 来源类型 | 置信度 |
| --- | --- | --- | --- |
| P1 | item.get 支持 fields 参数；getIdsWithModifiedAt() 专为增量同步优化，返回 id 与 modifiedAt；count、countAll 已提供（2025 年 8 月 5 日加入） | 官方 Changelog 与 item 文档 | 高 |
| P2 | 官方提示：资源库文件很多（如 20 万以上）时，避免不加限制地调用 getAll() | 官方 item 文档 | 高 |
| P3 | folder.parent 自 4.0 build12 起可写，设为 null 即移到根目录；iconColor 同样自 build12 起可写 | 官方 folder 文档与 Changelog | 高 |
| P4 | importedAt 自 build18 起可写；评论 API、智能文件夹 API、followCursor 需要 build22 | 官方 Changelog | 高 |
| P5 | item.moveToTrash() 于 2024 年 11 月 28 日加入 | 官方 Changelog | 高 |
| P6 | Item 还有只读属性 noThumbnail（无缩略图时用原文件预览）、noPreview、comments（build22+） | 官方 item 文档 | 高 |
| P7 | replaceFile(filePath) 替换原文件并自动刷新缩略图；官方建议先把新版本存到别处、验证后再替换 | 官方 item 文档 | 高 |
| P8 | addFromPath(path, options) 的 options 含 name、website、tags、folders（文件夹 ID 数组）、annotation，返回新素材 itemId | 官方 item 文档 | 高 |
| P9 | 文档示例 item.name = 'New Name' 不含扩展名；ext 只读 | 官方 item 文档 | 高 |
| P10 | 在 Eagle 中改名后，images/ID.info/ 里的原文件会同步改名（社区报告：Eagle 4.0.0、macOS 26.6.2，改名后 file:// 链接失效） | GitHub cmds-eagle issue #4 | 中（界面改名已证实；API 的 save() 改名是否相同，未验证） |
| P11 | item.folders 赋值后 save() 能否实现移动与多文件夹归属，文档只说 folders 是“所属文件夹 ID” | 官方 item 文档 | 中低，未验证 |
| P12 | addFromPath 是否复制文件、同名如何处理、name 是否应带扩展名，文档未说明 | 无 | 低，未验证 |
| P13 | 回收站素材是否出现在 item.get 结果中，文档只给出只读属性 isDeleted | 官方 item 文档 | 低，未验证（设计上一律过滤 isDeleted 为 true 的素材） |

### 2.3 资源库磁盘结构

| 编号 | 结论 | 来源类型 | 置信度 |
| --- | --- | --- | --- |
| D1 | 结构为 xxx.library/images/ID.info/，目录内是以素材名命名的原文件、可选的“文件名_thumbnail.png”缩略图、metadata.json；部分素材没有缩略图文件 | 社区博客 PRIN BLOG 的目录示例；cmds-eagle issue 代码排除 _thumbnail.png | 中 |
| D2 | 文件夹层级只记录在元数据中，没有对应的磁盘目录 | 社区博客 | 中 |
| D3 | Eagle 4.x 最新版是否改变该结构，未找到变更说明 | 无 | 低，未验证 |

### 2.4 对用户已核实事实的修正与补充

- **HTTP API 已有 V2**：
  - 版本与范围：需要 Eagle 4.0 Build 21 或更高，路径前缀为 /api/v2/，可以创建、移动和整理文件夹。
  - 分页：列表端点默认分页，limit 默认 50、最大 1000。
  - 认证：局域网内其他设备访问时，需要偏好设置「开发者」里的 API Token。
  - 与已核实事实的差异：用户说的“约 25 个端点、不能移动文件夹”描述的是 V1。
  - 本设计的取舍：坚持 Plugin API 路线，V2 只用作调试工具和 R3 的备选方案。
- 官方文档写明运行时为 Node 16。若实测属实，不能使用全局 fetch 及部分较新的 stream、fs API，打包目标必须设为 node16。

### 2.5 WebDAV 协议要点（RFC 4918）

| 编号 | 结论 | 置信度 |
| --- | --- | --- |
| W1 | MOVE 状态码：201（新建映射）、204（覆盖已有目标）、207（多资源部分失败）、403（推荐用于源与目标相同）、409（目标父集合不存在，服务端不得自动创建中间集合）、412（Overwrite 为 F 且目标已存在）、423（被锁）、502（目标在别的服务器或命名空间的另一部分） | 高（201、204、409、423、412 有原文片段；207、403、502 的措辞为依据记忆整理，需核对原文） |
| W2 | 集合 MOVE 必须按 Depth infinity 处理；Overwrite 为 T 且目标存在时，必须先对目标执行 DELETE；因 Overwrite 未执行时必须返回 412；所有 DAV 资源必须支持 Overwrite 头，缺省视为 T | 高 |
| W3 | getlastmodified 的值必须是 rfc1123-date，例如 Mon, 12 Jan 1998 09:25:56 GMT，且应只反映内容体变化 | 高 |
| W4 | creationdate 为 RFC 3339 date-time，例如 1997-12-01T17:42:21-08:00；无法持久记录创建时间的服务端应不返回该属性 | 高 |
| W5 | 被写锁锁定的资源 MOVE 成功后，锁不随资源移动 | 高 |
| W6 | Finder 只有在服务端声明 Class 2 时才读写挂载，否则只读；写打开文件时请求 10 分钟超时的锁，每 5 分钟刷新，关闭时释放；只读打开不加锁 | 中高（Apple 工程师 Jim Luther 在 W3C 邮件列表 2002、2004 年的说明，现代项目仍在复现） |
| W7 | Finder 请求 getlastmodified、getcontentlength、resourcetype 等属性，会遗留 .DS_Store 与 ._ 开头的文件，请求量很大，资源分叉请求最常见 | 中（sabre/dav 客户端说明） |

### 2.6 客户端兼容性

| 客户端 | 结论 | 置信度 |
| --- | --- | --- |
| iOS、iPadOS 文件 App | Apple 文档只写“输入本地主机名或网络地址”，没有点名协议。二手来源说 iOS 13 起支持 SMB；需要 SMB2 以上这一点出自 OSXDaily 文章《How to Connect to SMB Shares from iPhone & iPad with Files App》（2019-11-04）的读者评论，原话是“the server must be running SMB2 – the Files app will not let you connect to a server running SMB1”，不是 Apple 官方说法。Apple 开发者论坛显示它的文件提供者是 com.apple.smbclient.fileprovider | 中（结论：原生不支持 WebDAV） |
| iOS 第三方 App | 受 App Transport Security 限制，访问非本地 WebDAV 服务器需 HTTPS，局域网地址可用 HTTP | 中 |
| Infuse | 官方支持文档列出 SMB、NFS、FTP、SFTP、FTPS、FTPES、UPnP、DLNA 与 WebDAV。Firecore 官方发布说明里，8.5 版写的是“Improved compatibility with WebDAV servers that do not support range requests”，8.5.2 版（2026-08-26）又加了“Improved compatibility with non-compliant WebDAV servers” | 高 |
| Windows 资源管理器 | BasicAuthLevel 为 0 禁用 Basic，为 1 仅 SSL 可用，为 2 时非 SSL 也可用。FileSizeLimitInBytes 默认 50,000,000 字节（Microsoft 存档博客原文为“FileSizeLimitInBytes Default is 50000000 bytes.”），最大可设为 0xFFFFFFFF，Microsoft Q&A 称其“corresponds to a 4GB limit”。Microsoft Learn「Deprecated features in the Windows client」在 2023 年 11 月写明：“The Webclient (WebDAV) service is deprecated. The Webclient service isn't started by default in Windows.” | 高 |

### 2.7 现有 Node WebDAV 库评估

| 库 | 在本项目中的问题 | 结论 |
| --- | --- | --- |
| nephele（sciactive） | 可插拔适配器，目标是完整实现 RFC 4918；但以 Express 中间件形式提供，nephele-serve 仍为 1.0.0-alpha.67，示例为 ESM，对 Node 16 的兼容性未知；适配器假设“一个路径一个资源”，难以表达“同一素材出现在多个目录、COPY 即追加归属” | 不采用 |
| webdav-server（OpenMarshal v2） | 有自定义 FileSystem 基类、LocalLockManager、Basic 与 Digest 认证；但回调风格、多年未见活跃维护，默认 COPY 等行为与 Eagle 语义冲突，覆盖的方法几乎等于重写 | 不采用，可参考其锁与 XML 输出 |
| jsDAV | 长期无维护 | 不采用 |
| 手写精简实现 | 完全掌控 Eagle 语义、流式输出与 Finder 兼容细节，只依赖 Node 原生模块和一个可关闭实体解析的 XML 解析器，可打包为单文件；代价是需用 litmus 与 rclone 保证协议正确性 | **采用** |

## 三、架构概览

服务运行在 Eagle 进程内，由后台服务插件的页面脚本启动。启动顺序：

1. Eagle 加载插件，onPluginCreate 触发。
2. 从 eagle.app.userDataPath 下的插件配置文件读取监听地址、端口、账号与密码哈希。
3. 检查 eagle.app.build，低于 12 拒绝启动并在状态窗口提示升级。
4. 加载文件夹树，建立按目录懒加载的素材缓存，启动变更轮询。
5. createServer 并 listen；端口被占用时在状态窗口报错。
6. 注册 onLibraryChanged：暂停服务（返回 503），清空索引，重建后恢复。
7. 注册 onPluginBeforeExit：停止接受新连接，中止进行中的上传，关闭服务器，清理临时目录。

每个请求依次经过以下环节：

1. 建立连接。
2. 源地址白名单检查。
3. Basic 认证。
4. 路径解码与 NFC 规范化。
5. 系统文件过滤，命中的进入影子暂存区。
6. 虚拟路径解析，结果为文件夹、素材、虚拟目录、影子文件或不存在之一。
7. 方法处理器。
8. Eagle 适配层（唯一调用 eagle.* 的模块）。
9. 生成响应：XML 流式输出或文件流。

## 四、虚拟路径模型

### 4.1 根目录结构

- 根目录「/」列出所有顶层 Eagle 文件夹，以及两个虚拟目录「/@未分类/」和「/@标签/」；主视图路径形如「/文件夹/子文件夹/素材文件」，与 Eagle 文件夹树一一对应。
- 虚拟目录名以 @ 开头以减少重名；若真实顶层文件夹恰好同名，真实文件夹按 4.3 节追加 ID 后缀。
- 「@未分类」可写：PUT 进来的文件不归入任何文件夹；把素材 MOVE 进来等于从源文件夹移除。
- 「@标签」只读，路径为「/@标签/标签名/素材文件」，可在配置中关闭：其下的 PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH 一律返回 403，标签列表按需懒加载。
- 素材属于多个文件夹时，在每个文件夹下各出现一次，文件名与 ETag 完全一致。

### 4.2 素材文件名生成规则

显示名 = 规范化(name) +（ext 非空时）"." + ext。规范化步骤顺序固定：

1. Unicode 规范化为 NFC；请求路径同样先做 NFC 再匹配，兼容发送 NFD 的 macOS 客户端。
2. “/”替换为全角“／”，NUL 与 U+0001 到 U+001F 控制字符替换为“_”。
3. 去掉尾部空格与点；结果为空时用素材 ID 代替。
4. 按 UTF-8 字节截断，使完整文件名（含后缀与扩展名）不超过 255 字节，且不切断多字节字符。
5. 冲突检测键 = 小写化(NFC(显示名))，按大小写不敏感判断冲突，以适配 macOS 默认文件系统。

重名消歧（仅在冲突时生效）：

- 同一目录内冲突键相同的素材，按 importedAt、再按 id 升序排列；第一个保留原名，其余在扩展名前追加“ ~”加 ID 末 6 位，例如「海报 ~XTXR7I.jpg」。
- 取末 6 位的依据：样本 ID（如 KEZAL1JG0RN32、KEZAL1JG2YXNI）前缀高度相同，疑似按时间生成（推测，未验证）；同目录末 6 位仍冲突时使用完整 ID。
- 可逆解析：正则“ ~([A-Z0-9]{6,13})(\.[^.]+)?$”命中时，先按 ID 后缀在该目录成员中查找，命中即返回。因此冲突消失后，客户端手里带后缀的旧路径仍能解析（PROPFIND 只列出规范名）。
- 稳定性：新导入素材的 importedAt 更晚，不会改变已有素材的名字；只有排在前面的素材被删除或移走时，后一个才会“失去后缀”，需写进用户说明。

### 4.3 文件夹命名与重名

同一父文件夹下子文件夹重名时，按 createdAt 升序，第一个保留原名，其余追加“ ~”加文件夹 ID 末 6 位；文件夹与素材重名时，文件夹优先保留原名；文件夹名使用同一套规范化规则。

### 4.4 路径解析与反向映射

- 解析：按“/”切分，逐段百分号解码（拒绝解码后含“/”或 NUL 的段），逐段 NFC，从根逐层查找；先精确匹配，再按冲突键匹配，最后尝试 ID 后缀匹配。
- 反向映射：素材 href = 当前目录路径 + 规范名；集合 href 一律以“/”结尾；所有 href 统一为“以 / 开头的绝对路径、逐段 UTF-8 百分号编码”，满足 207 响应内 href 格式一致的要求。
- 不带末尾斜杠请求集合时直接按集合处理，不发 301（部分客户端处理不好对 PROPFIND 的重定向）。

## 五、方法到 Plugin API 的完整映射

### 5.1 总表

| 方法 | 目标 | Plugin API 映射 | 成功状态码 | 主要错误 |
| --- | --- | --- | --- | --- |
| OPTIONS | 任意 | 无 | 200，带 DAV: 1, 2 与 Allow | 无 |
| PROPFIND | 集合或素材 | 索引；必要时 folder.getAll、item.get(folders, fields) | 207 | 403 propfind-finite-depth、404、400 |
| GET、HEAD | 素材 | getById 取 filePath，fs.createReadStream | 200、206、304 | 404、412、416 |
| GET | 集合 | 返回简单 HTML 列表，便于浏览器调试 | 200 | 无 |
| PUT | 新文件 | 写临时文件，再 addFromPath(tmp, {name, folders}) | 201 | 409、403、405、413、507 |
| PUT | 已有素材 | 写临时文件，再 item.replaceFile(tmp) | 204 | 同上 |
| MKCOL | 新集合 | folder.create({name, parent}) | 201 | 405、409、415、403 |
| DELETE | 素材 | item.moveToTrash() | 204 | 404、403 |
| DELETE | 文件夹 | 不调用 | 403，附说明 | 无 |
| MOVE | 素材 | 改 name 和或 folders，再 save() | 201、204 | 412、409、403、502 |
| MOVE | 文件夹 | 改 name 和或 parent，再 save() | 201 | 412、409、403 |
| COPY | 素材 | 同名跨目录：folders 追加；改名或同目录：addFromPath 真复制 | 201、204 | 412、409、403 |
| COPY | 文件夹 | 不支持 | 403，附说明 | 无 |
| PROPPATCH | 素材、文件夹 | 修改 tags、star、annotation、url 或 description，再 save() | 207 | 403、424 |
| LOCK、UNLOCK | 任意 | 内存假锁 | 200、201、204 | 400、409 |

### 5.2 OPTIONS

```http
HTTP/1.1 200 OK
DAV: 1, 2
MS-Author-Via: DAV
Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK
Accept-Ranges: bytes
Content-Length: 0
```

OPTIONS 同样要求认证，未带凭据时返回 401 进入认证流程；必须声明 DAV: 1, 2，否则 Finder 只读挂载。

### 5.3 PROPFIND

- Depth 缺省按 infinity 处理（RFC 规定），本服务拒绝 infinity，因此缺省或 infinity 都返回 403 并带 propfind-finite-depth 元素。Finder、rclone 实践中都会显式发送 0 或 1。
- 支持 allprop、propname、prop；请求体为空等同 allprop。

| 属性 | 集合 | 素材 | 格式 |
| --- | --- | --- | --- |
| displayname | 规范名 | 规范名 | 与 href 最后一段解码后一致 |
| resourcetype | collection 元素 | 空 | 无 |
| getcontentlength | 不返回 | item.size | 十进制字节数 |
| getcontenttype | 不返回 | 由 ext 映射 | 未知扩展名用 application/octet-stream |
| getlastmodified | 目录内最新 modifiedAt 或 createdAt | item.modifiedAt | rfc1123-date，例如 Sun, 11 Oct 2026 08:00:00 GMT |
| creationdate | folder.createdAt | item.importedAt | RFC 3339，统一 UTC，例如 2026-10-11T08:00:00Z |
| getetag | 不返回 | 强 ETag，形如 "KBKE04XSTXR7I-1730000000000-204800" | id-modifiedAt-size |
| supportedlock | exclusive 与 shared 的 write 锁 | 同左 | 固定内容 |
| lockdiscovery | 当前假锁 | 当前假锁 | 来自锁管理器 |

- 自定义属性命名空间 urn:eagle-webdav:ns（前缀 E）：E:id、E:folders、E:width、E:height 只读；E:tags（JSON 字符串数组）、E:star（0 到 5）、E:annotation、E:url 可写。它们只在被显式请求时返回，避免 allprop 响应过大。
- Eagle 的 modifiedAt 在修改标签时是否变化未知（未验证）。若会变化，客户端只会多下载一次，不违反“同一 URL 不同内容不能复用同一 ETag”的硬性要求，可以接受。
- 大目录：流式写出，每 500 个条目让出一次事件循环，不在内存中拼接整串 XML。WebDAV 没有标准分页，“分页”只体现为分批写出；单目录超过 20000 条时只在日志与状态窗口警告，仍完整返回。

### 5.4 GET 与 HEAD

- 每次 GET 都调用 item.getById 获取最新 filePath，不缓存路径（改名会改变磁盘文件名）。
- 安全校验：fs.realpath(filePath) 必须以 realpath(资源库路径 + "/images/") 开头，且父目录以 .info 结尾，否则返回 404 并记录日志。
- 支持单区间 Range（bytes=a-b、bytes=a-、bytes=-n），返回 206 与 Content-Range；多区间退化为 200 返回整个文件；越界返回 416 并带 Content-Range: bytes */size。
- 条件请求：If-None-Match 命中返回 304；If-Match 不命中返回 412；If-Modified-Since 与 If-Unmodified-Since 按 getlastmodified 处理；If-Range 不匹配时返回完整 200。
- 响应头：Content-Type、Content-Length、ETag、Last-Modified、Accept-Ranges: bytes。HEAD 与 GET 同逻辑但不打开文件流。
- Content-Length 以 fs.stat 实时大小为准；与 item.size 不一致时以 stat 为准并触发该素材的索引刷新。
- 没有可读原文件的素材（例如书签，未验证）不在 PROPFIND 中列出。

### 5.5 PUT

1. 父目录不存在返回 409；父目录在「@标签」下返回 403；目标是集合返回 405。
2. 系统文件（.DS_Store、._*、.localized 等）写入影子暂存区，返回 201 或 204，不导入 Eagle。
3. 请求体写入 os.tmpdir()/eagle-webdav/<uuid>/<原文件名>，保留原文件名以便 Eagle 按扩展名识别类型。同时支持 Content-Length 与 chunked 上传；对 Expect: 100-continue，在 checkContinue 事件中先完成认证，失败直接回 401 而不读取请求体。
4. 默认上限 4 GiB（可配置），超限返回 413；磁盘空间不足返回 507。
5. 写入完成后：
   - 0 字节且目标不存在：视为 Finder 占位写入，只记入影子暂存区并返回 201（见 5.13）。
   - 目标不存在：调用 addFromPath(tmp, {name, folders})，其中 name 取去掉扩展名的文件名；folders 在父目录为真实文件夹时取 [id]，为「@未分类」时取 []。拿到 itemId 后立即 getById 写入索引，返回 201。
   - 目标为已有素材且扩展名相同：replaceFile(tmp)，返回 204。
   - 目标为已有素材但扩展名不同：仍调用 replaceFile（ext 是否更新未验证）；若实测不更新，改为“新建素材、复制标签与注释、旧素材进回收站”。
6. finally 中删除临时文件。导入失败返回 500，不留半成品；addFromPath 成功但后续步骤失败时不回滚已导入素材，只记录日志。

### 5.6 MKCOL

带请求体返回 415；目标已存在返回 405；父目录不存在返回 409；在「@未分类」或「@标签」内创建返回 403。根目录下调用 folder.create({name})，文件夹内调用 folder.create({name, parent})；返回的新文件夹立即写入索引，返回 201。

### 5.7 DELETE

- 素材：moveToTrash()，返回 204，并从索引中删除它在所有目录的出现。“一删全删”意味着在某个文件夹里删除多归属素材，会使其从所有文件夹消失，必须写入用户说明。
- 文件夹：返回 403，纯文本说明“Eagle 的 Plugin API 不提供删除文件夹的方法，请在 Eagle 中删除”，也不删除其内部素材，避免误删。
- 影子文件：从影子暂存区删除，返回 204。带锁令牌的 If 头只做语法容忍。

### 5.8 MOVE

公共校验：

- 缺少 Destination：返回 400。
- Destination 的主机与本服务不一致：返回 502。
- 源与目标相同：返回 403。
- 目标父目录不存在：返回 409。
- 目标在「@标签」内：返回 403。
- 目标已存在且 Overwrite 为 F：返回 412。
- 目标已存在、Overwrite 为 T、目标是素材：先对目标 moveToTrash 再继续，最终返回 204。
- 目标已存在且是文件夹：返回 403。

| 素材场景 | 动作 |
| --- | --- |
| 同目录改名 | item.name = 新名去扩展名，save() |
| 改名同时改扩展名 | 返回 403，说明扩展名只读 |
| 跨目录同名 | 源为真实文件夹则 folders 去掉源 ID；目标为真实文件夹则加入目标 ID（去重）；save() |
| 源为「@未分类」 | folders = [目标 ID] |
| 目标为「@未分类」 | folders 去掉源 ID；若仍属于其他文件夹，它会继续出现在那些文件夹中 |
| 跨目录且改名 | 同时修改 name 与 folders，一次 save() |

文件夹场景：

- 同父目录改名：设置 folder.name，然后 save()。
- 跨父目录：设置 folder.parent（移到根目录时为 null），必要时同时改名，然后 save()。
- 目标父目录是自身或其后代：返回 409。
- 目标在虚拟目录下：返回 403。

所有 MOVE 完成后，重新读取受影响对象，更新索引，并重算受影响目录的消歧名。

### 5.9 COPY

- 素材、目标名与源名相同且目标目录不同：在 folders 中追加目标文件夹 ID 并 save()，不复制文件，返回 201。这是与 Eagle 多归属语义一致的“按引用复制”。
- 素材、目标名不同或同目录（例如 Finder 生成「xxx 副本.jpg」）：真复制。把源文件复制到临时目录并按新名命名，addFromPath 导入目标文件夹，再写入源素材的 tags、annotation、url、star，返回 201。
- 目标为「@未分类」时按真复制处理；文件夹 COPY 返回 403；Overwrite 规则与 MOVE 相同。

### 5.10 PROPPATCH

- 只接受 E 命名空间的可写属性：tags、star、annotation、url；文件夹接受 E:description。
- 原子性：先校验所有 set 与 remove 指令，任一失败则失败项返回 403 或 409，其余返回 424；全部通过后一次 save()。
- remove 语义：tags 设为空数组、star 设为 0、annotation 与 url 设为空串。
- DAV: 命名空间的 live 属性返回 403（cannot-modify-protected-property）。
- 其他命名空间的 dead 属性（Finder、Windows 写入的）存入影子属性表（内存加 JSON 持久化），返回 200，不写入 Eagle。

### 5.11 LOCK 与 UNLOCK（假锁）

- 新锁：
  - 生成 opaquelocktoken:<uuid>，记录 href、owner、scope、depth 与超时。
  - 超时按客户端请求的 Second-n，上限 3600 秒，默认 600 秒。
  - 返回 200、Lock-Token 头和 lockdiscovery 体；lockdiscovery 中的 activelock 包含 locktype、lockscope、depth、timeout、locktoken、lockroot。
- 刷新：无请求体并带 If 头时延长超时，返回 200。
- 对不存在的 URL 加锁：在影子暂存区创建空占位资源并返回 201（RFC 4918 用“锁定空资源”取代了旧的 lock-null 资源）。
- 永不拒绝加锁，同一路径已有排他锁时也发新令牌，避免客户端卡死；这是有意的非强制实现。
- UNLOCK：
  - 令牌存在则删除并返回 204，不存在返回 409。
  - 若该路径是已收到非空内容的占位文件，在此时完成最终导入。
  - 锁不持久化，重启后全部失效。

### 5.12 系统文件与探测请求

- ._*（AppleDouble）与 .DS_Store：读写走影子暂存区，PROPFIND 列目录时不列出。
- .metadata_never_index、.Spotlight-V100、.Trashes、.fseventsd、.TemporaryItems：PROPFIND 与 GET 直接返回 404，不访问 Eagle；PUT 与 MKCOL 写入影子暂存区。
- desktop.ini、Thumbs.db、~$*（Office 锁文件）：影子暂存区。
- 影子暂存区：内存索引加 userData 下的磁盘目录，条目 TTL 为 24 小时，总量上限 512 MiB，按最近最少使用淘汰。

### 5.13 Finder 写入序列的兼容策略

据经验，Finder 拷贝新文件通常是：PUT 0 字节创建、LOCK、PUT 完整内容、UNLOCK，并伴随 ._ 文件写入（经验结论，未验证，需抓包确认）。若第一个 0 字节 PUT 就导入 Eagle，会产生空素材，后续 PUT 又变成 replaceFile。策略：

- 0 字节 PUT 且目标不存在：只在影子暂存区登记“待定占位”，PROPFIND 中照常列出（大小 0），以免 Finder 认为文件消失。
- 随后对同一路径的非空 PUT：按新建流程导入，然后删除占位。
- 占位超过 10 分钟仍没有内容：默认丢弃并记录日志（Eagle 对空文件的导入行为未验证）。

## 六、缓存与一致性设计

### 6.1 索引结构

- **文件夹树**：启动时用 folder.getAll() 全量加载，建立“id 到节点”和“父节点到（子名到节点）”两张映射。文件夹通常只有几百到几千个，开销可以忽略。
- **素材**：按目录懒加载，加上全局变更检测；不在启动时全量拉取 20 万条完整元数据（遵守官方关于 getAll 的提示）。
  - 首次访问某个文件夹时调用 item.get({folders: [id], fields: ["id", "name", "ext", "size", "folders", "modifiedAt", "importedAt", "isDeleted", "tags", "star"]})。
  - 「@未分类」使用 item.get({isUnfiled: true, fields})。
  - 全局维护一张“id 到 modifiedAt”的表，数据来自 getIdsWithModifiedAt。
- **内存估算**（推测，未验证）：
  - 20 万条 id 加 modifiedAt，约 20 到 30 MB。
  - 若所有目录都缓存完整字段，每条约 400 到 600 字节，共约 80 到 120 MB。
  - 目录缓存设 LRU 上限，默认 20 万条素材记录。
  - 耗时必须在 1 万、5 万、20 万规模的库上实测。

### 6.2 变更检测与轮询

- 第一级：每 3 秒读取 eagle.library.modificationTime，未变化则跳过本轮（该值是否随素材元数据变化未验证，若不变化则取消这一级）。
- 第二级：调用 getIdsWithModifiedAt()，与上一轮比较得出新增、删除、修改的 ID，对变化项用 getByIds 拉取并更新受影响目录。
- 自适应间隔：max(5 秒, 20 × 上次耗时)，上限 60 秒；有 WebDAV 请求时缩短到下限，空闲 10 分钟后放宽到上限。
- 每次第二级检测同时调用 folder.getAll()，只比较 id、name、parent，有变化就重建树与受影响目录的消歧名。

### 6.3 写后即时更新与并发

- **写后即时更新**：写操作成功后，立即重新读取受影响对象并更新索引，同时把新的 modifiedAt 写入变更表，避免下一轮轮询误判为外部修改。
- **串行化**：同一素材或文件夹 ID 的写操作进入按 ID 的互斥队列串行执行，不同对象之间并行。
- **与 Eagle 界面的并发**：采用“读时校验”的乐观策略。
  - MOVE、COPY、PROPPATCH 执行前重新 getById，基于最新的 folders 与 tags 做增量修改（只移除源 ID、只加入目标 ID），不整体覆盖旧值。
  - 客户端带 If-Match 时用最新 ETag 校验，不匹配返回 412。
  - Plugin API 没有事务或版本号，剩下的竞态接受“最后写入者获胜”。

### 6.4 资源库切换

onLibraryChanged 触发后，服务进入“切换中”状态，所有请求返回 503 并带 Retry-After: 5；清空缓存、锁与旧库相关的影子条目；文件夹树重新加载后恢复服务。客户端缓存的路径在新库中失效属于预期行为。

## 七、安全设计

- **监听地址**：默认只绑定用户在状态窗口中选择的局域网网卡 IP；另提供“仅本机（127.0.0.1）”和“所有网卡（0.0.0.0）”选项，选后者时给出警告。默认端口 41600（避开 Eagle API 的 41595），可配置。
- **源地址过滤**：默认只接受 RFC 1918 私有地址、169.254.0.0/16 与回环地址，其余直接断开；可配置白名单网段。
- **Basic 认证**：用 crypto.timingSafeEqual 比较；密码以带随机盐的 scrypt 哈希保存；同一源 IP 连续失败 10 次封禁 10 分钟。
- **凭据存储**：eagle.app.userDataPath 下的 eagle-webdav/config.json，权限 0600；不放在插件目录，以免插件更新时被覆盖。
- **防火墙**：macOS 应用防火墙按应用（Eagle）而非插件判断入站连接，首次监听可能弹出允许提示（未验证）；用户说明中指导在防火墙选项里允许 Eagle。
- **路径穿越与符号链接**：
  - WebDAV 路径只用于在虚拟树中查找节点，绝不拼接成磁盘路径。
  - 读取文件只用 Plugin API 返回的 filePath，并做 realpath 前缀校验。
  - 临时目录与影子目录名一律用 uuid；原文件名只作为最内层文件名，并去除路径分隔符。
- **请求限制**：XML 请求体上限 1 MiB；PUT 默认上限 4 GiB；请求头超时 30 秒；keep-alive 空闲超时 65 秒；上传 120 秒无数据即中止。
- **XML 安全**：包含 DOCTYPE 的请求体直接返回 400，从根本上杜绝 XXE 与实体膨胀；解析器选用可关闭实体处理的库（如 fast-xml-parser 关闭 processEntities，选项名以选型时文档为准）。
- **日志**：通过 eagle.log 写入 Eagle 日志，内存保留最近 500 条请求摘要供状态窗口显示；不记录 Authorization 头与密码；错误响应体不含堆栈。
- **外网**：前置 Caddy 或 Nginx 做 HTTPS 与访问控制，本服务仍只监听内网地址。

## 八、工程与目录结构

### 8.1 目录与模块

| 路径 | 职责 |
| --- | --- |
| package.json、tsconfig.json、build.mjs | 依赖、类型检查配置、esbuild 打包脚本 |
| src/main.ts | 入口：onPluginCreate、onLibraryChanged、onPluginBeforeExit |
| src/config/config.ts | 读写配置、scrypt 哈希 |
| src/http/server.ts、auth.ts、access.ts | createServer、超时、checkContinue；Basic 认证与封禁；源地址过滤 |
| src/dav/router.ts、handlers/*.ts | 方法分发；每个方法一个文件 |
| src/dav/xml.ts、props.ts、locks.ts、conditional.ts | 流式 XML 生成与安全解析；属性；假锁；If、If-Match、Range |
| src/vfs/naming.ts、resolver.ts、shadow.ts | 命名规范化与消歧；路径与节点互转；影子暂存区 |
| src/index/folderTree.ts、itemCache.ts、watcher.ts | 文件夹树；按目录懒加载与 LRU；变更轮询 |
| src/eagle/adapter.ts、realAdapter.ts | EagleAdapter 接口；唯一调用 eagle.* 的实现 |
| src/util/、src/ui/status.ts | MIME、日志、互斥锁；状态窗口 |
| test/unit/、test/integration/ | FakeEagleAdapter 单元测试；litmus 与 rclone 脚本 |
| plugin/ | 打包输出，即 Eagle 插件目录：manifest.json、index.html、logo.png、js/plugin.js |

### 8.2 构建与打包

- **打包**：用 esbuild 把全部 TypeScript 和第三方依赖打成单个 js/plugin.js。
  - 选项：platform 为 node、target 为 node16、format 为 iife、bundle 为 true，external 包含 electron；Node 内置模块保持 require。
  - 好处：插件目录不需要 node_modules，也绕开“插件环境是否支持 ES Module”的不确定性（官方示例使用 require，ESM 支持情况未验证）。
- **加载**：index.html 用普通 script 标签加载 js/plugin.js，与官方示例一致。
- **类型**：
  - tsconfig 使用 strict、module 为 commonjs、noEmit。
  - @types/node 固定为 16.x，防止误用 Node 16 没有的 API。
  - eagle 全局对象的类型建议写在 types/eagle.d.ts 里，按官方文档只声明用到的部分；社区包 eagle-plugin-dts 成熟度较低，仅作参考。
- **开发**：通过「开发者选项」把 plugin/ 目录作为本地插件加载。后台服务插件是否需要重启 Eagle 才能重载，未验证。

### 8.3 manifest.json 示例

```json
{
  "id": "EAGLEWEBDAV01",
  "version": "1.0.0",
  "platform": "mac",
  "arch": "all",
  "name": "Eagle WebDAV",
  "logo": "/logo.png",
  "keywords": ["webdav", "finder", "infuse"],
  "devTools": true,
  "main": {
    "serviceMode": true,
    "url": "index.html",
    "width": 640,
    "height": 520,
    "resizable": true,
    "multiple": false,
    "runAfterInstall": true
  }
}
```

id 应使用「创建插件」向导生成的唯一 ID；正式使用时把 devTools 设为 false。

### 8.4 关键类型草案

```ts
export interface EItem {
  id: string; name: string; ext: string; size: number;
  folders: string[]; tags: string[]; star: number;
  annotation: string; url: string;
  modifiedAt: number; importedAt: number; isDeleted: boolean;
}
export interface EFolder {
  id: string; name: string; description: string;
  parent: string | null; createdAt: number; childIds: string[];
}
export interface EagleAdapter {
  build(): number;
  libraryModificationTime(): Promise<number>;
  getAllFolders(): Promise<EFolder[]>;
  getItemsInFolder(folderId: string): Promise<EItem[]>;
  getUnfiledItems(): Promise<EItem[]>;
  getItem(id: string): Promise<EItem | null>;
  getItems(ids: string[]): Promise<EItem[]>;
  getFilePath(id: string): Promise<string | null>;
  idsWithModifiedAt(): Promise<Array<{ id: string; modifiedAt: number }>>;
  addFromPath(path: string, opts: { name: string; folders: string[] }): Promise<string>;
  patchItem(id: string, patch: Partial<Pick<EItem, 'name' | 'folders' | 'tags' | 'star' | 'annotation' | 'url'>>): Promise<EItem>;
  replaceFile(id: string, path: string): Promise<void>;
  trashItem(id: string): Promise<void>;
  createFolder(name: string, parent: string | null): Promise<EFolder>;
  patchFolder(id: string, patch: { name?: string; parent?: string | null; description?: string }): Promise<EFolder>;
  onLibraryChanged(cb: (path: string) => void): void;
}
```

### 8.5 核心流程伪代码

PROPFIND：

```ts
async function propfind(req, res) {
  const depth = req.headers['depth'];
  if (depth !== '0' && depth !== '1') return sendFiniteDepthError(res); // 403
  const want = parsePropfind(await readXmlBody(req, 1 << 20));          // 拒绝 DOCTYPE
  const node = await resolver.resolve(req.davPath);
  if (node.kind === 'missing') return send(res, 404);
  res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
  const w = xml.multistatusWriter(res);
  w.response(resolver.href(node), await props.of(node, want));
  if (depth === '1' && isCollection(node)) {
    let n = 0;
    for await (const child of resolver.children(node)) {                 // 已完成消歧
      w.response(resolver.href(child), await props.of(child, want));
      if (++n % 500 === 0) await yieldToEventLoop();
    }
  }
  w.end();
}
```

GET 与 Range：

```ts
async function get(req, res, head: boolean) {
  const node = await resolver.resolve(req.davPath);
  if (node.kind === 'shadow') return shadow.serve(node, req, res, head);
  if (node.kind !== 'item') return isCollection(node) ? sendHtmlListing(res, node) : send(res, 404);
  const fp = await eagle.getFilePath(node.itemId);
  if (!fp || !(await isInsideLibrary(fp))) return send(res, 404);
  const st = await fs.promises.stat(fp);
  const mtime = cache.modifiedAt(node.itemId);
  const etag = makeEtag(node.itemId, mtime, st.size);
  const cond = evaluateConditionals(req, etag, mtime);                    // 304 或 412
  if (cond) return send(res, cond);
  const range = parseSingleRange(req.headers.range, st.size, req.headers['if-range'], etag);
  if (range === 'unsatisfiable') return send(res, 416, { 'Content-Range': `bytes */${st.size}` });
  const [start, end] = range ?? [0, st.size - 1];
  res.writeHead(range ? 206 : 200, {
    'Content-Type': mime(node), 'Content-Length': st.size === 0 ? 0 : end - start + 1,
    'ETag': etag, 'Last-Modified': rfc1123(mtime), 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
  });
  if (head || st.size === 0) return res.end();
  await pipeline(fs.createReadStream(fp, { start, end }), res);
}
```

PUT：

```ts
async function put(req, res) {
  const { parent, name } = resolver.splitParent(req.davPath);
  const p = await resolver.resolve(parent);
  if (p.kind === 'missing') return send(res, 409);
  if (p.kind === 'tag' || p.kind === 'tagRoot') return send(res, 403);
  if (naming.isSystemFile(name)) return shadow.put(req, res, parent, name);
  const target = await resolver.resolve(req.davPath);
  if (isCollection(target)) return send(res, 405);
  const tmp = await tempfile.create(name);
  try {
    const size = await streamToFile(req, tmp, cfg.maxUploadBytes);        // 超限抛 413
    if (target.kind === 'item') {
      await lockById(target.itemId, () => eagle.replaceFile(target.itemId, tmp));
      await index.refreshItem(target.itemId);
      return send(res, 204);
    }
    if (size === 0) { shadow.placeholder(parent, name); return send(res, 201); }
    const folders = p.kind === 'folder' ? [p.folderId] : [];
    const id = await eagle.addFromPath(tmp, { name: naming.stripExt(name), folders });
    await index.refreshItem(id);
    shadow.clearPlaceholder(parent, name);
    return send(res, 201);
  } finally {
    await tempfile.remove(tmp);
  }
}
```

MOVE（COPY 共用前半段校验，后半段按 5.9 节分为“追加 folders”与“真复制”两支）：

```ts
async function move(req, res) {
  const src = await resolver.resolve(req.davPath);
  if (src.kind === 'missing') return send(res, 404);
  const dstPath = parseDestination(req);                                  // 400 或 502
  if (samePath(req.davPath, dstPath)) return send(res, 403);
  const { parent, name } = resolver.splitParent(dstPath);
  const dp = await resolver.resolve(parent);
  if (dp.kind === 'missing') return send(res, 409);
  if (dp.kind === 'tag' || dp.kind === 'tagRoot') return send(res, 403);
  const existing = await resolver.resolve(dstPath);
  let status = 201;
  if (existing.kind !== 'missing') {
    if (req.headers['overwrite'] === 'F') return send(res, 412);
    if (existing.kind !== 'item') return send(res, 403);
    await eagle.trashItem(existing.itemId); status = 204;
  }
  if (src.kind === 'item') {
    if (naming.ext(name) !== naming.ext(src.displayName)) return send(res, 403);
    await lockById(src.itemId, async () => {
      const cur = await eagle.getItem(src.itemId);                        // 读时校验
      let folders = cur.folders.slice();
      if (!sameParent(src.parent, dp)) {
        if (src.parent.kind === 'folder') folders = folders.filter(f => f !== src.parent.folderId);
        if (src.parent.kind === 'unfiled') folders = [];
        if (dp.kind === 'folder' && !folders.includes(dp.folderId)) folders.push(dp.folderId);
      }
      await eagle.patchItem(src.itemId, { name: naming.toEagleName(name), folders });
    });
  } else if (src.kind === 'folder') {
    if (dp.kind !== 'root' && dp.kind !== 'folder') return send(res, 403);
    if (dp.kind === 'folder' && tree.isSelfOrDescendant(dp.folderId, src.folderId)) return send(res, 409);
    await eagle.patchFolder(src.folderId, { name: naming.toFolderName(name), parent: dp.kind === 'root' ? null : dp.folderId });
  } else return send(res, 403);
  await index.refreshAfterWrite(src, dp);
  return send(res, status);
}
```

## 九、测试与验收方案

### 9.1 单元测试

- **框架**：vitest 或 mocha，需确认所选版本支持 Node 16。
- **Fake 实现**：FakeEagleAdapter 用内存实现 EagleAdapter，可以模拟 addFromPath 延迟、save 失败和外部修改。
- **覆盖范围**：
  - 命名规范化与消歧：NFC 与 NFD 混合、大小写冲突、255 字节截断、尾部点与空格、全角斜杠。
  - 后缀的可逆解析。
  - Range 与条件请求。
  - 拒绝含 DOCTYPE 的请求体。
  - PROPPATCH 的原子性。
  - MOVE 与 COPY 的全部分支。
  - 假锁的超时与刷新。
  - 影子暂存区的 TTL。

### 9.2 协议一致性测试

- **litmus**：在专用测试资源库上运行 basic、copymove、props、locks、http 各组，事先列出“设计使然”的已知不通过项：集合 COPY 与集合 DELETE（403）、测试结束时清理集合失败、锁冲突测试、dead 属性跨 MOVE 保留。
- **rclone**：配置 webdav 远端（vendor 为 other），依次执行 lsd、ls、copy（中文、emoji、空格、大小写不同的同名、1 GiB 视频）、check、moveto、move、delete；再用 rclone mount 做读写回归。
- **cadaver 与 curl**：手工验证 OPTIONS、PROPFIND、LOCK、UNLOCK 报文；脚本覆盖 Range（首段、尾段、越界、多区间）、If-None-Match、Expect: 100-continue、chunked 上传、Depth infinity 拒绝。

### 9.3 客户端验收

| 客户端 | 验收项 |
| --- | --- |
| Finder | 读写挂载、拖入文件、Finder 内复制生成「副本」、改名、跨文件夹拖动、删除进 Eagle 回收站、._ 文件不出现在 Eagle 中、2 GiB 视频拷贝 |
| Infuse（iPad、Apple TV） | 浏览中文目录、播放 4K 视频、拖动进度条、续播 |
| iPad 第三方 WebDAV App | 浏览、下载、上传照片，以及在文件 App 中通过该 App 的文件提供者访问 |

### 9.4 性能验收

在 1 万、5 万、20 万素材的库上测量以下指标：

- 冷启动到可以提供服务的时间。
- 5000 素材目录 PROPFIND Depth 1 的首字节时间与总时间。
- 单次轮询耗时与插件内存。

建议目标：首字节小于 500 毫秒；20 万库常驻内存小于 300 MB；Eagle 界面没有明显卡顿。

## 十、实施计划

第一版覆盖全部方法，分阶段只代表开发顺序，不是功能裁剪。

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| M0 实测探针（2 天） | 最小后台服务插件：打印 process.versions 与 eagle.app.build，监听局域网地址；完成 R1 到 R12 实测 | 每项都有结论与日志 |
| M1 骨架（3 天） | 打包、配置与认证、源地址过滤、状态窗口、生命周期与资源库切换、适配层与 Fake 实现 | 启停与切换资源库不崩溃 |
| M2 只读（4 天） | 命名与消歧、文件夹树、懒加载、OPTIONS、PROPFIND、GET 与 HEAD | Infuse 可播放，rclone ls 与 check 通过 |
| M3 写入（5 天） | PUT（含影子暂存区与占位）、MKCOL、DELETE、MOVE、COPY、PROPPATCH、假锁 | Finder 读写挂载全流程通过 |
| M4 一致性（3 天） | 变更轮询、写后更新、按 ID 互斥、并发修改测试 | 界面改名或移动后 10 秒内客户端可见 |
| M5 验收（3 天） | litmus、rclone、各客户端与性能测试，编写用户说明 | 验收项全部通过或记录为已知差异 |

## 十一、风险与待实测清单

| 编号 | 待验证点 | 实测步骤 | 失败时的备选方案 |
| --- | --- | --- | --- |
| R1 | 后台服务能否长期监听局域网地址；macOS 防火墙是否拦截 | M0 探针监听后用 iPad 访问；防火墙开、关各测一次；连续运行 24 小时 | 只绑定局域网 IP 并指导用户允许 Eagle；若插件内无法监听，只能另起独立 Node 进程（需重新评估路线的最后手段） |
| R2 | 窗口隐藏或关闭后服务是否继续；Build22 停用开关与 Eagle 更新时是否触发 onPluginBeforeExit | 关闭状态窗口后持续请求；停用再启用；经历一次版本更新 | 用 window.onbeforeunload 拦截关闭改为隐藏；在 onPluginShow 中自愈重启监听 |
| R3 | item.folders 赋值后 save() 是否生效、能否多归属、空数组是否变为未分类 | 依次设为 [A]、[A,B]、[]，每次 save 后用 getById 与界面核对 | 改用 Web API V2 的对应端点（同机 localhost 免 Token）；仍不行则跨目录 MOVE 与 COPY 返回 403 |
| R4 | API 改名后磁盘文件是否重命名、filePath 是否变化 | 改名前后读取 filePath 并列出 .info 目录 | 设计已在每次 GET 实时获取 filePath，不依赖文件名 |
| R5 | addFromPath 是否复制文件、原文件是否保留、name 带扩展名的表现、同名处理、大视频导入耗时 | 导入 10 MB 图片、2 GB 视频、无扩展名文件、带扩展名的 name，记录耗时与原文件状态 | 临时文件本就是副本，被移动也无影响；name 需带扩展名时在适配层统一拼接 |
| R6 | 回收站素材是否出现在 get、getById、getIdsWithModifiedAt 结果中 | moveToTrash 后分别查询 | 已过滤 isDeleted；若直接消失，把“消失的 ID”视为删除 |
| R7 | Finder 读写挂载与写入序列（0 字节 PUT、LOCK、PUT、UNLOCK、._ 文件、PROPPATCH 写 dead 属性） | 在 Finder 中拷贝、复制、改名、删除，同时记录完整请求日志 | 按抓包结果调整 5.13 的占位策略；必要时在影子属性表中实现 dead 属性迁移 |
| R8 | 书签、字体、PDF、无扩展名文件的 filePath、size、ext、noThumbnail 行为 | 各导入一个样本并打印属性 | 书签无可读文件时从视图隐藏；无扩展名文件直接以 name 为文件名 |
| R9 | library.modificationTime 是否随素材元数据修改变化 | 界面修改标签前后读取 | 取消第一级检测 |
| R10 | 20 万素材库下 getIdsWithModifiedAt 与按目录 get 的耗时与内存 | 见 9.4 | 拉长轮询间隔，只对最近访问的目录做精细比较 |
| R11 | 插件运行时是否真是 Node 16，打包产物能否用 require 加载 | 在 M0 探针中打印 process.versions，并 require 一个 esbuild 产物 | 运行时较新则放宽 target，仍不引入框架；require 失败则把逻辑直接内联进 index.html 加载的脚本 |
| R12 | replaceFile 用不同扩展名的文件替换时 ext 是否更新 | 用 png 内容替换 jpg 素材 | 改为“新建素材、复制元数据、旧素材进回收站” |
| R13 | iPad 访问方式：文件 App 原生不支持 WebDAV | 安装 Infuse 与一款提供 File Provider 的 WebDAV App 分别连接 | Infuse 用于影音，第三方 App 用于文件操作；必须用文件 App 原生连接时只能另行提供 SMB（不在本项目范围） |

## 十二、建议用户升级到的最低 build

- **硬性最低：4.0 Build12**。folder.parent 可写（移动文件夹）、iconColor 可写、select() 与 open 的 window 参数都需要 build12；官方 MCP Server 服务插件同样要求 Build 12（2025-09-14）或更高。插件启动时检查 eagle.app.build，低于 12 直接拒绝启动。
- **推荐：4.0 Build22 或更高**。Build18 提供可写的 importedAt（真复制时可保留导入时间）；Build22 提供插件启用与停用，便于用户随时关闭服务。
- **实际建议：升级到当前最新的 4.0 Build23**，并以此完成第十一节的全部实测；此后每次 Eagle 更新都重跑 M0 探针与 rclone 回归脚本。

## 来源

- Eagle Plugin API 简介：https://developer.eagle.cool/plugin-api
- Background Service：https://developer.eagle.cool/plugin-api/get-started/plugin-types/service
- event：https://developer.eagle.cool/plugin-api/api/event
- item：https://developer.eagle.cool/plugin-api/api/item
- folder：https://developer.eagle.cool/plugin-api/api/folder
- Changelog：https://developer.eagle.cool/plugin-api/changelog
- manifest.json Configuration：https://developer.eagle.cool/plugin-api/tutorial/manifest
- Using Third-Party Modules：https://developer.eagle.cool/plugin-api/tutorial/3rd-modules
- Debug Plugin：https://developer.eagle.cool/plugin-api/get-started/debugging
- Your First Plugin：https://developer.eagle.cool/plugin-api/get-started/creating-your-first-plugin
- Web API V2：https://developer.eagle.cool/web-api
- Eagle 4.0 Build 22 博客：https://en.eagle.cool/blog/post/eagle4-build22
- Eagle 下载页：https://en.eagle.cool/download
- MCP Server 插件页：https://community-en.eagle.cool/plugin/mcp-server
- 官方示例仓库 Service：https://github.com/eagle-app/eagle-plugin-examples/tree/main/Service
- cmds-eagle issue #4：https://github.com/johnfkoo951/cmds-eagle/issues/4
- PRIN BLOG 资源库结构：https://prinsss.github.io/organize-images-with-eagle/
- RFC 4918：https://datatracker.ietf.org/doc/html/rfc4918
- Jim Luther 关于 Finder 与 LOCK：https://lists.w3.org/Archives/Public/w3c-dist-auth/2002JanMar/0334.html
- sabre/dav Finder 说明：https://sabre.io/dav/clients/finder/
- sabre/dav Windows 说明：https://sabre.io/dav/clients/windows/
- WebClient 注册表设置：https://lokna.no/?p=1071
- Microsoft Q&A 文件大小限制：https://learn.microsoft.com/en-us/answers/questions/2260796/does-inbuilt-webdav-client-support-file-upload-upt
- Infuse 支持文档：https://support.firecore.com/hc/en-us/articles/215090977-Streaming-From-a-Mac-PC-or-NAS
- Infuse 发布说明：https://firecore.com/releases
- Apple iPhone 使用手册（连接服务器）：https://support.apple.com/guide/iphone/connect-external-devices-or-servers-iph8d8f0f1a0/ios
- Apple 开发者论坛：https://developer.apple.com/forums/thread/705923
- nephele：https://github.com/sciactive/nephele/blob/master/README.md
- webdav-server：https://github.com/OpenMarshal/npm-WebDAV-Server
- Zotero 论坛关于 iOS HTTPS 要求：https://forums.zotero.org/discussion/105482/ios-cant-connect-to-webdav-server