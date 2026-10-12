# 安装与首次设置

> 读者：想把 Eagle 资源库用 WebDAV 共享出来的使用者。下一步：[各设备怎么用](clients.md)。

插件运行后，开着 Eagle 的 Mac 会提供 WebDAV 服务，Finder、Infuse、rclone 等客户端可以像访问网盘一样读写 Eagle 资源库。在 Eagle 里它叫「WebDAV 共享」（英文 WebDAV Share）。

验证范围：Eagle 4.0.0 Build 23、macOS Apple 芯片。Infuse、iPad 客户端和 Finder 图形界面的拖拽尚未真机测过，已用 rclone、ffmpeg（HTTP 取流）和系统 WebDAV 挂载做了等价验证。

## 前提

- Eagle 4.0 Build 12 或更高，推荐 Build 23
- macOS（Apple 芯片）

## 安装

- **从插件中心安装**（上架后）：在 Eagle 插件中心搜索「WebDAV 共享」，点安装。
- **从安装包安装**：双击 `.eagleplugin` 文件，在 Eagle 弹出的「Install …?」里点 Install。
- **从源码安装**：见 [开发者上手](../dev/getting-started.md)。

它是后台服务插件，安装后服务立即自启，之后随 Eagle 启动。

## 首次设置

打开插件窗口，在「设置」里：

1. **谁能访问**：默认「仅这台 Mac」；要给其他设备用，选「局域网内的设备」。
2. **端口**：默认 41600，可填 1024 到 65535。
3. **账号与密码**：账号默认 `eagle`。**没设密码时不需要认证，任何访问都等同管理账号**；想要认证就设置密码。要去掉已设置的密码，把密码框清空再保存（框里的黑点表示「不修改」）。
4. 点「保存」：服务正在运行时会自动重启以应用新设置，已停止则只保存，下次启动时生效；「放弃」只还原表单，不影响服务。

macOS 防火墙若弹出提示，允许 Eagle 接受入站连接。

## 日常运行

- 只要 Eagle 开着，服务就在；Eagle 退出，服务随之停止。
- 切换资源库时服务会短暂返回 503，随后恢复。
- 配置保存在 `~/Library/Application Support/Eagle/eagle-webdav/config.json`（权限 0600，密码是 scrypt 哈希）。
