# Eagle WebDAV 探针（M0）

用来在你的真实 Eagle 上验证设计里的未确认假设（R1–R12），并抓取 Finder、Infuse、rclone 的真实请求序列。

## 安装

1. 解压 `eagle-webdav-probe.zip`，得到 `plugin` 文件夹。
2. 打开 Eagle，进入「偏好设置 → 插件 → 开发者选项」（具体菜单名随版本略有不同），选择「载入本地插件」，指向 `plugin` 文件夹。
3. 插件窗口会自动打开。日志写在 `~/EagleWebdavProbe/`：`probe.log`、`requests.jsonl`、`heartbeat.log`、`report-*.json`。

## 测试步骤

1. 点「采集环境信息」，记录 Node 版本、Eagle build、API 清单（R11）。
2. 抓包服务：填端口（默认 41600），建议设一个账号密码，点「启动」。
   - R1：用同一局域网的另一台设备（手机或另一台电脑）访问页面上显示的地址，看能否连上。连不上就检查 macOS 防火墙。
   - R7：在 Finder「连接服务器」里填 `http://本机IP:41600/`，挂载后拖入一个文件、新建文件夹、重命名、删除、拷贝出来。
   - R13：用 Infuse 或其他 WebDAV 应用添加同一地址，浏览并播放。
   - rclone：`rclone lsd :webdav: --webdav-url=http://IP:41600 --webdav-user=… --webdav-pass=$(rclone obscure …)`。
   - R2：关闭或隐藏插件窗口后，再用客户端访问，同时看 `heartbeat.log` 是否继续增长。最后试着退出再重开 Eagle。
3. 写入探针：勾选确认，点运行。建议用测试资源库。它只操作自己创建的对象，结束后素材进回收站，两个 `__webdav_probe_` 文件夹需要手动删除。
4. 性能探针：在你的真实大库上运行（只读）。
5. 点「导出报告」，把 `report-*.json` 和 `requests.jsonl` 发给我（或复制到剪贴板后粘贴）。

## 自测

`node test/selftest.js`：用内存模拟的 Eagle 验证代码路径，不代表真实行为。
