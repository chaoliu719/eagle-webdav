# 各设备怎么用

> 读者：使用者。先完成[安装与首次设置](getting-started.md)，记下窗口最上方的「连接地址」（点「复制」即可），形如 `http://Mac 的 IP:41600/`。

| 设备或工具 | 推荐用法 | 注意事项 |
| --- | --- | --- |
| Mac Finder | Command + K，输入 `http://Mac 的 IP:41600/`，填账号密码挂载 | 拖入的文件会导入 Eagle，资源库里是一份副本；改名、移动、复制会同步到 Eagle |
| iPad、iPhone 看影音 | 用 Infuse：在「添加文件源」的发现列表里选「Eagle 素材库 (Mac 名)」，或手动填连接地址 | 支持 Range 拖进度条；mp4（索引在文件尾或头）、mkv 的跳转读取已用 ffmpeg 验证 |
| iPad、iPhone 管文件 | 用提供文件提供者的第三方 WebDAV App | 「文件」App 的「连接服务器」原生似乎只支持 SMB；局域网地址可用 HTTP |
| rclone 与脚本 | `rclone config` 选 webdav，vendor 选 other；`rclone ls`、`copy`、`check` | 已验证 lsd/ls/copy/check，可按文件夹结构导出备份 |
| Windows | 不建议作主力 | 默认禁用 HTTP 上的 Basic 认证，单文件默认上限约 50 MB，WebClient 服务已被官方标为弃用 |

## 自动发现（Bonjour）

仅对局域网开放时注册。Infuse 等 App 的 WebDAV 发现列表里会出现这台 Mac，不用手输地址。**Finder 的「网络」不会列出 WebDAV**，Finder 仍要按 ⌘K 输入地址。

## 阻止休眠

有文件在传输或播放时（读取、上传、复制、移动）自动阻止 Mac 休眠，传输结束约 1 分钟后放开。只是挂着 Finder 的卷或浏览目录不会阻止休眠。
