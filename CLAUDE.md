# Eagle WebDAV

把 Eagle 资源库以 WebDAV 暴露给 Finder、Infuse、rclone 等客户端。形态是 Eagle 后台服务插件（`serviceMode: true`），插件内用 Node `http` 手写最小 WebDAV 服务（Class 1 加假锁实现 Class 2）。TypeScript + esbuild（iife，target node16），不引入第三方 WebDAV 库。

详细内容都在 `docs/`，入口见 [docs/README.md](docs/README.md)。本文件只放协作时必须先知道的硬约束和文档地图。

## 文档地图（事实只写一处）

| 要查或要记什么 | 文件 |
| --- | --- |
| Eagle API 的实测行为、踩过的坑 | [docs/dev/eagle-api-notes.md](docs/dev/eagle-api-notes.md) |
| 模块、协议与写入策略、缓存、日志系统、界面与提示约定 | [docs/dev/architecture.md](docs/dev/architecture.md) |
| 用户明确要求的产品决策、命名、多语言 | [docs/dev/decisions.md](docs/dev/decisions.md) |
| 命令、预览、联调 | [docs/dev/getting-started.md](docs/dev/getting-started.md) |
| 里程碑、litmus、预置数据、未验证项 | [docs/dev/testing.md](docs/dev/testing.md) |
| 打包、审核要点、上架材料 | [docs/release/](docs/release/publishing.md) |
| 面向使用者的说明 | [docs/user/](docs/user/getting-started.md) |
| 验证前的旧设计（仅历史） | [docs/archive/design.md](docs/archive/design.md) |

新的结论、约定按上表记到对应文件，不要再堆回本文件。

## 硬约束

- **在真机验证前，不要假设 Eagle 存在某方法**；先查 `eagle-api-notes.md`。只有 `src/eagle/realAdapter.ts` 可直接碰全局 `eagle`
- **命名**：Eagle 内不带 "Eagle"，清单名 `{{manifest.app.name}}`（「WebDAV 共享」/ WebDAV Share）；Eagle 之外要认得出（Bonjour `Eagle 素材库 (主机名)`，认证 Realm 固定 `Eagle Library`）。仓库名、插件 ID `EAGLEWEBDAV01` 不变
- **多语言**：界面三语（简中 / 繁中 / 英文），字典是 `plugin/_locales/*.json`；新增文案必须三种语言同步；日志与诊断保持中文
- **管理密码留空 = 不认证**，只读账号与额外来源网段已按用户要求删除，不要加回；删掉过的窗口说明文字也不要加回（清单见 `decisions.md`）
- **提示分层**：toast / 横幅 + 系统通知 / 行内红字 / 状态标签，不要混用（见 `architecture.md`）
- `plugin/manifest.json` 的 `devTools` 必须为 `false`；上架必须用 Eagle「打包插件」导出，不能用 `npm run package` 的产物
- 构建与测试：`npm run check`（类型检查 + 单元测试 + 构建）

## 工作约定

- 每完成一个阶段性工作就提交一次 git（提交信息用中文，带 Co-Authored-By）
- 与用户用中文交流，中文标点用全角，中英文和数字之间加空格；不用画图讲解；需要确认时用文字直接问
- 不确定的行为先实测再写进文档，并标注日期与环境（Eagle 4.0.0 Build 23，macOS arm64）
