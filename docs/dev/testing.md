# 测试与验证状态

> 读者：开发者、维护者。命令见 [getting-started.md](getting-started.md)。

## 自动化

- `npm run check` = 类型检查 + 单元测试（`test/unit/`，tsx + node:test，内存假 Eagle）+ 构建；CI 见 `.github/workflows/ci.yml`
- 压测 `npx tsx test/dev/bench.ts`：假数据 20 万条，2 万条目录 Depth:1 约 0.1s、15MB，堆 +20MB

## 里程碑与真机验证

| 阶段 | 状态 | 要点 |
| --- | --- | --- |
| M0 探针 | 完成并已删除 | 结论都在 [eagle-api-notes.md](eagle-api-notes.md) |
| M1 骨架 | 完成并真机验证 | Eagle 内启动、OPTIONS、Basic 认证、局域网访问；配置与 scrypt、源地址过滤、封禁、资源库切换 503、状态窗口、适配层与 Fake |
| M2 只读 | 完成并真机验证 | Production 库 47 条：rclone lsd/ls/copy/check 一致，Finder 同款挂载 ls/cp/cmp 正常，列目录约 0.6s，拷贝 0.05s |
| M3 写入 | 完成并真机验证 | `node test/dev/real-write-smoke.mjs <端口> [密码]` 41 项通过；挂载点上 `mkdir/cp/mv/覆盖/rm -f` 正常 |
| M4 | 完成 | 变更监听、`@标签`、`@全部`、大库缓存与压测 |

## litmus 0.17（2026-10-12）

`npx tsx test/dev/fake-server.ts 41650` + `node test/dev/litmus-proxy.mjs 41651 127.0.0.1:41650`，源码从 notroj.github.io/litmus 下载后 `./configure --with-included-neon && make`，对 `http://127.0.0.1:41651/` 用账号 eagle / test，**每个套件前重启假服务**（否则残留的 `/litmus` 文件夹让 MKCOL 405）。代理给无扩展名的资源名补 `.dat` 并在响应里抹掉（本服务对无扩展名返回 415）。

结果：basic 14/16、copymove 8/13、props 33/33、locks 27/40、http 4/4。**剩下的失败都是设计决定**：文件夹 DELETE / COPY / 覆盖文件夹 → 403；`notowner_*` 与伪造 lock-token 的条件 PUT 应 412 → 假锁永不拒绝；copy_shallow 的 405 是 copy_coll 失败的连锁。

## e2e 预置数据

`node test/dev/seed-e2e.mjs [端口] [密码]` 经插件的 WebDAV 写进当前真实库（2026-10-12 已灌入 Production 库，幂等）：顶层文件夹 `__e2e__`（图片 / 文档 / 嵌套 / 大文件 / 元数据 / 多归属）加 `@未分类/__e2e__-unfiled.txt`；含中文与特殊字符文件名、6MB 随机文件（sha256 `4c90a153…59c9`）、带标签 `e2e` `测试` / 星级 / 注释 / 来源链接的条目、同属甲乙两个文件夹的条目。文件夹建了删不掉，只能在 Eagle 里手动删。

`node test/dev/seed-many-images.mjs [数量=5000]` 往 `__e2e__/海量图片/` 灌 32×32 小 png，已灌 20000 张；2 万条目录 Depth:1 PROPFIND 约 0.23s、15.7MB（命中缓存）。

## 未验证

- Infuse 与 iPad 实机、Finder 图形界面的拖拽
- 几十万条的真实大库（Production 库仅 48 条）、`@全部`（`item.get({})`）在真实 Eagle 的行为与耗时
- 跨设备 LAN 访问（只在本机经局域网 IP 测过）
- 真实 Eagle 里日志文件落盘、「打开日志文件夹」、真实库上的性能快照数字
- `eagle.app.locale` 的真实取值
- 「自动选择添加的新项目」的影响

## 未做

- dead 属性不落盘
- 真实锁语义（有意不做）
- 目录 `getlastmodified` 取目录创建时间而非内部最新修改
- `@标签` 之外的更多视图
