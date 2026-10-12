# 文档索引

按读者找文档。

## 我想使用它（使用者）

1. [安装与首次设置](user/getting-started.md)
2. [各设备怎么用](user/clients.md)：Finder、Infuse、rclone、iPad、Windows
3. [目录结构与行为差异](user/library-behavior.md)：虚拟目录、删除、复制、重名、特殊字符
4. [状态窗口、日志与排查](user/window-and-troubleshooting.md)：提示、诊断信息、已知限制、安全建议

## 我想改代码（开发者 / 维护者）

1. [开发者上手](dev/getting-started.md)：环境、命令、预览与联调
2. [架构](dev/architecture.md)：模块、协议与写入策略、缓存、日志系统、界面约定
3. [Eagle API 实测笔记](dev/eagle-api-notes.md)：Eagle 行为的唯一事实来源
4. [产品决策与约定](dev/decisions.md)：用户明确要求的决定、命名、多语言、工作约定
5. [测试与验证状态](dev/testing.md)：里程碑、litmus、预置数据、未验证项

## 我要发布 / 上架（维护者）

- [打包、安装与上架](release/publishing.md)
- [插件中心上架材料](release/store-listing.md)（封面在 `release/store/`）

## 历史

- [archive/design.md](archive/design.md)：真机验证之前的调研与设计，已被上面的文档取代，仅供追溯

## 写文档的规则

- 一个事实只写在一处：Eagle 行为 → `dev/eagle-api-notes.md`；实现 → `dev/architecture.md`；决策 → `dev/decisions.md`；验证状态 → `dev/testing.md`
- 面向使用者的文档不写实现细节，也不写未实测的猜测
- 新增界面文案要三语同步
