<p align="center"><img src="plugin/logo.png" alt="Eagle WebDAV" width="128"></p>

# Eagle WebDAV

> 在 Eagle 的插件列表和插件窗口里，它叫「WebDAV 共享」（英文 WebDAV Share）。

把 [Eagle](https://eagle.cool) 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端的后台服务插件。插件内用 Node `http` 手写最小 WebDAV 服务，不依赖第三方 WebDAV 库。

- Eagle 文件夹树就是目录树；另有可写的 `@未分类`、只读的 `@标签` 和平铺全库的只读 `@全部`
- 读：PROPFIND、GET / HEAD（Range、条件请求）
- 写：PUT、MKCOL、DELETE（进回收站）、MOVE、COPY、PROPPATCH、LOCK / UNLOCK
- 仅局域网，Basic 认证，默认端口 41600
- 界面三语：简体中文、繁體中文、English

已在 Eagle 4.0.0 Build 23（macOS Apple 芯片）上验证。

## 从哪里开始

| 我是… | 看这里 |
| --- | --- |
| 使用者 | [安装与首次设置](docs/user/getting-started.md) → [各设备怎么用](docs/user/clients.md) |
| 开发者 | [开发者上手](docs/dev/getting-started.md) → [架构](docs/dev/architecture.md) |
| 维护者 / 上架 | [打包与上架](docs/release/publishing.md) |

全部文档见 [docs/README.md](docs/README.md)。

## 快速构建

需要 Node 20+ 与 Eagle 4.0 Build 12+。

```bash
npm install
npm run build
```

然后在 Eagle 菜单「插件 → 开发者选项… → 导入本地项目」里选 `plugin/` 目录。`npm run check` 依次做类型检查、单元测试与构建。

## 已知限制

- Eagle 没有删除文件夹的 API：DELETE 文件夹返回 403
- 内容与库内已有文件相同的导入默认会触发 Eagle 的「重复添加提示」；在 Eagle 设置里取消「添加重复文件，弹出通知」即可直接入库
- 没有扩展名的文件不能上传（返回 415）
- 锁是假锁：发令牌，不强制互斥
- 几十万条的大库性能未实测

完整说明见[使用者文档](docs/user/window-and-troubleshooting.md)。

## 许可证

MIT
