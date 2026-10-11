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
- M2 只读：PROPFIND、GET/HEAD（含 Range），用 Finder 和 rclone 验证
- M3 写入：PUT、MKCOL、DELETE、MOVE、COPY、PROPPATCH、LOCK/UNLOCK
- M4 变更监听、性能、大库测试

## M0 遗留（可边做边验）
NFC/NFD 文件名、`replaceFile` 换扩展名、跨设备 LAN、完整 R2（关窗口/退出 Eagle）、大库性能、Infuse 与 iPad 客户端抓包。

## 工作约定
- 每完成一个阶段性工作就提交一次 git（提交信息用中文，带 Co-Authored-By），并把新的结论、约定同步记入本文件
- 与用户用中文交流，中文标点用全角，中英文和数字之间加空格；不用画图讲解；需要确认时用文字直接问
- `probe/` 是只读参考实现，其中 `davcapture.js` 的协议细节、`test/selftest.js` 的协议测试可复用
- 在真机验证前，不要假设 Eagle API 存在某方法；先查本文件的实测事实
- 构建与测试：`npm run build`、`npm run typecheck`、`npm test`（tsx + node:test，`test/unit/`）
- 脚本加载瞬间 `eagle.app` 的 version、build、userDataPath 读不到（曾显示 Build 0），初始化要等 `onPluginCreate`，build 读不到时不拦截启动
- 源码：`src/{config,http,eagle,util,ui}`；只有 `src/eagle/realAdapter.ts` 可直接碰全局 `eagle`；`eagle.app.userDataPath` 未实测，缺失时回退到 `~/.eagle-webdav`
- 探针测试：`node probe/test/selftest.js`；与 rclone 对照：`probe/test/compare.sh`
