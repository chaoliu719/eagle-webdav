# 插件中心上架材料

提交时按下面的内容填写。字数限制来自官方《Store Listing Copy》：名称 ≤ 30 个字符且 ≤ 6 个词；简短描述英文 ≤ 200、简体中文 ≤ 100。封面图在 `docs/release/store/`（1600×1000，三种语言各一张，内容来自真实窗口的预览页面）。

提交前必须做的事（官方清单）：
1. 用 Eagle 自己的「打包插件」导出 `.eagleplugin`（插件面板里右键该插件 → 打包插件），不要上传 `npm run package` 的产物。
2. 卸载开发模式加载的同 ID 插件，安装刚打好的包，确认能启动、主要功能可用，并解压检查里面只有运行需要的文件。
3. 填写支持联系方式：GitHub 仓库已公开，用下面的仓库链接。
4. 2026-10-12 已用 Eagle「打包插件」导出（`WebDAV 共享.eagleplugin`，64KB），解压核对：与仓库 `plugin/` 完全一致，只有 `manifest.json`、`index.html`、`logo.png`、`js/plugin.js` 和 `_locales/` 下三个文件，没有隐藏文件和开发文件，`devTools` 为 false。

## 名称

| 语言 | 名称 |
| --- | --- |
| English | WebDAV Share |
| 简体中文 | WebDAV 共享 |
| 繁體中文 | WebDAV 共享 |

## 简短描述

- **English**（≤ 200）：Share your Eagle library over WebDAV so Finder, Infuse, rclone and other apps on your local network can browse, play and manage your assets.
- **简体中文**（≤ 100）：把 Eagle 资源库通过 WebDAV 共享，让 Finder、Infuse、rclone 等在局域网内浏览、播放和管理素材。
- **繁體中文**（≤ 100）：把 Eagle 資源庫透過 WebDAV 分享，讓 Finder、Infuse、rclone 等在區域網路內瀏覽、播放和管理素材。

## 介绍

### English

WebDAV Share turns the Eagle library you have open into a WebDAV server. Other apps on your Mac or local network can then browse it like a network drive: mount it in Finder, play videos in Infuse, back it up with rclone.

**How to use**
1. Install the plugin. The service starts automatically and listens on this Mac only (http://127.0.0.1:41600/).
2. To use it from other devices, open the plugin window and choose "Devices on the local network". Optionally set a password.
3. Copy the address from the window. In Finder choose Go > Connect to Server (⌘K) and paste it; other apps ask for a WebDAV address.

**What you see**
Eagle folders appear as folders. Items not in any folder are under `@未分类` (Unfiled), and all items are listed flat under `@全部` (All). New files added in `@全部` are imported as unfiled items.

**What it can change in your library**
Uploading a file imports it into Eagle. Renaming or moving a file, and renaming a folder, is applied to the item or folder in Eagle (moving a folder to another parent is not supported). Deleting a file inside a folder removes it from that folder only when it also belongs to other folders (like Eagle's default choice), otherwise the item moves to the Eagle trash; deleting in `@未分类` or `@全部` always moves the item to the trash; folders cannot be deleted. Copying to another folder makes the item belong to both folders; copying under a new name duplicates the item. Tags, star rating, annotation and URL can be read and written by clients that support WebDAV properties.

**Things to know**
- macOS on Apple Silicon only. Requires Eagle 4.0 Build 12 or later. Tested on Eagle 4.0.0 Build 23.
- Data is served over plain HTTP on your own network. Nothing is sent to any external server. By default only this Mac can connect. If you open it to the local network and leave the password empty, anyone on that network can read and change your library, so setting a password is strongly recommended.
- The plugin starts small helper processes of macOS: `dns-sd` (so apps like Infuse can discover this Mac), `caffeinate` (keeps the Mac awake while files are being transferred), and `open` (opens the log folder when you click the button). Both options can be switched off in the window.
- Files without an extension cannot be uploaded. Eagle shows a "duplicate file" prompt when the same content is added twice; to avoid it, turn off "Notify when adding duplicate files" in Eagle's settings.
- The plugin writes a small log (kept for 7 days) in the Eagle user-data folder, `eagle-webdav/logs`. Log lines are in Chinese. "Copy diagnostics" copies version info and recent log lines; it never includes passwords or file contents.
- The window is available in English, Simplified Chinese and Traditional Chinese.

### 简体中文

WebDAV 共享把你当前打开的 Eagle 资源库变成一个 WebDAV 服务。本机或局域网里的其他应用可以像访问网盘一样访问它：在 Finder 里挂载、在 Infuse 里播放视频、用 rclone 备份。

**怎么用**
1. 安装插件，服务会自动启动，默认只监听本机（http://127.0.0.1:41600/）。
2. 想让其他设备访问：打开插件窗口，把「谁能访问」选成「局域网内的设备」，可以按需设置密码。
3. 复制窗口里的连接地址。Finder 里按 ⌘K（前往 → 连接服务器）粘贴即可；其他应用会要求填 WebDAV 地址。

**你会看到什么**
Eagle 的文件夹就是目录。不属于任何文件夹的素材在 `@未分类`，所有素材平铺在 `@全部`；在 `@全部` 里新增的文件会导入为未分类素材。

**它会改动你的资源库**
上传文件会导入到 Eagle；改名、移动文件，以及文件夹改名，会同步到 Eagle（暂不支持把文件夹移到别的父级）；在文件夹里删除文件时，如果素材还属于别的文件夹，只是从这个文件夹移除（和 Eagle 默认选项一致），否则整个素材移入 Eagle 回收站；在 `@未分类` 或 `@全部` 里删除，一律整个移入回收站；文件夹不能删除；复制到另一个文件夹是让素材同时属于两个文件夹，改名复制则会复制出一份新素材。支持 WebDAV 属性的客户端还能读写标签、星级、注释和链接。

**需要知道**
- 仅支持 macOS（Apple 芯片）。需要 Eagle 4.0 Build 12 或更高，在 Eagle 4.0.0 Build 23 上验证过。
- 数据在你自己的网络里通过明文 HTTP 传输，不会发送到任何外部服务器。默认只有本机能连。如果开放给局域网又不设密码，同网络里的任何人都能读写你的资源库，强烈建议设置密码。
- 插件会启动 macOS 自带的几个小程序：`dns-sd`（让 Infuse 这类应用能自动发现这台 Mac）、`caffeinate`（传输文件时防止 Mac 休眠）、`open`（点按钮时打开日志文件夹）。前两项都可以在窗口里关闭。
- 没有扩展名的文件不能上传。同一内容重复添加时 Eagle 会弹出「重复添加提示」，想避免可以在 Eagle 设置里取消「添加重复文件，弹出通知」。
- 插件在 Eagle 用户数据目录的 `eagle-webdav/logs` 里写一份小日志（保留 7 天），日志内容是中文。「复制诊断信息」会复制版本信息和最近的日志，不含密码和文件内容。
- 窗口支持英文、简体中文和繁体中文。

### 繁體中文

WebDAV 共享把你目前開啟的 Eagle 資源庫變成一個 WebDAV 服務。本機或區域網路裡的其他應用程式可以像存取網路硬碟一樣存取它：在 Finder 裡掛載、在 Infuse 裡播放影片、用 rclone 備份。

**怎麼用**
1. 安裝外掛，服務會自動啟動，預設只監聽本機（http://127.0.0.1:41600/）。
2. 想讓其他裝置存取：開啟外掛視窗，把「誰能存取」選成「區域網路內的裝置」，可以視需要設定密碼。
3. 複製視窗裡的連線位址。在 Finder 按 ⌘K（前往 → 連接伺服器）貼上即可；其他應用程式會要求填 WebDAV 位址。

**你會看到什麼**
Eagle 的資料夾就是目錄。不屬於任何資料夾的素材在 `@未分类`，所有素材平鋪在 `@全部`；在 `@全部` 裡新增的檔案會匯入為未分類素材。

**它會改動你的資源庫**
上傳檔案會匯入到 Eagle；改名、移動檔案，以及資料夾改名，會同步到 Eagle（暫不支援把資料夾移到別的父層）；在資料夾裡刪除檔案時，如果素材還屬於別的資料夾，只是從這個資料夾移除（和 Eagle 預設選項一致），否則整個素材移到 Eagle 資源回收桶；在 `@未分类` 或 `@全部` 裡刪除，一律整個移到資源回收桶；資料夾不能刪除；複製到另一個資料夾是讓素材同時屬於兩個資料夾，改名複製則會複製出一份新素材。支援 WebDAV 屬性的用戶端還能讀寫標籤、星級、註解和連結。

**需要知道**
- 僅支援 macOS（Apple 晶片）。需要 Eagle 4.0 Build 12 或更高，在 Eagle 4.0.0 Build 23 上驗證過。
- 資料在你自己的網路裡以明文 HTTP 傳輸，不會傳送到任何外部伺服器。預設只有本機能連。如果開放給區域網路又不設密碼，同網路裡的任何人都能讀寫你的資源庫，強烈建議設定密碼。
- 外掛會啟動 macOS 內建的幾個小程式：`dns-sd`（讓 Infuse 這類應用程式能自動探索這台 Mac）、`caffeinate`（傳輸檔案時防止 Mac 睡眠）、`open`（點按鈕時開啟記錄資料夾）。前兩項都可以在視窗裡關閉。
- 沒有副檔名的檔案不能上傳。同一內容重複新增時 Eagle 會彈出「重複新增提示」，想避免可以在 Eagle 設定裡取消「新增重複檔案，彈出通知」。
- 外掛在 Eagle 使用者資料夾的 `eagle-webdav/logs` 裡寫一份小記錄（保留 7 天），記錄內容是中文。「複製診斷資訊」會複製版本資訊和最近的記錄，不含密碼和檔案內容。
- 視窗支援英文、簡體中文和繁體中文。

## 更新日誌

- English: Initial release.
- 简体中文：首次发布。
- 繁體中文：首次發布。

## 审核说明（Review notes）

不需要账号或特殊环境，只需要 Eagle 4.0 Build 12+ 和 macOS（Apple 芯片）。复现主要流程：

1. 安装插件，窗口显示「运行中」和地址 `http://127.0.0.1:41600/`（默认无密码、仅本机）。
2. 终端里列出资源库根目录：`curl -s -X PROPFIND -H 'Depth: 1' http://127.0.0.1:41600/`，返回 207 和文件夹列表。
3. 上传一个文件到「未分类」：`curl -T photo.png "http://127.0.0.1:41600/%40%E6%9C%AA%E5%88%86%E7%B1%BB/photo.png"`，返回 201，Eagle 里出现该素材。
4. 删除它：`curl -X DELETE "http://127.0.0.1:41600/%40%E6%9C%AA%E5%88%86%E7%B1%BB/photo.png"`，返回 204，素材进入 Eagle 回收站。
5. 图形界面方式：Finder 按 ⌘K，输入 `http://127.0.0.1:41600/` 连接，可以浏览、拷出文件。
6. 窗口里点「复制诊断信息」会弹出已复制的提示；点「打开日志文件夹」会在 Finder 里打开 `eagle-webdav/logs`。

插件使用的子进程：`dns-sd`（Bonjour 注册，仅在对局域网开放时）、`caffeinate -i -w <pid>`（仅在有文件传输时，随宿主进程退出）、`open <日志目录>`（点按钮时）。卸载或停止服务时这些进程都会结束。

## 支持联系方式

https://github.com/chaoliu719/eagle-webdav （公开仓库，Issues 里提问；使用说明在仓库 `docs/user/`）

## 图标与封面

- 图标：`plugin/logo.png`（256×256，透明圆角）。
- 封面：`docs/release/store/cover-en.png`、`cover-zh_CN.png`、`cover-zh_TW.png`（1600×1000）。封面里的窗口截图来自真实界面页面，数据是演示用的（库名 Photo Library、三个示例客户端）。
