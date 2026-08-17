# VisionLog MVP 验收记录

> 日期：2026-08-17

## 自动化与构建证据

- `pnpm test`：10/10 通过；覆盖压缩建档、立即删除原图、精确去重、多来源、人工锁定与乐观锁、Plog 事实引用与幂等、候选新版、归档/回收站、Provider 同意门禁、完整导出导入、清空防回流、批量主题。
- `pnpm run check`：Server 与 Web JavaScript 语法通过。
- `./gradlew lintDebug assembleDebug`：Android Lint 与 API 36 Debug APK 构建通过。
- 真实 JPEG HTTP 验收：上传返回 202，Job 完成，主图响应 `image/webp`，系统状态显示空间正常且超期原图为 0。
- 浏览器验收：照片首页、Photo Log 编辑、Plog 阅读/确认、设置页均可见且无 console warning/error；移动断点显示原生菜单布局。
- `docker compose config --quiet`：编排配置有效。本机 Docker daemon 未运行，镜像构建未列为已验证证据。
- `pnpm audit --prod`：0 个已知漏洞；图像解码与静态文件模块已升级到修复版本。

## PRD 第 17 节逐项结论

| 验收项 | 结论与证据 |
| --- | --- |
| Web 正式 Photo Log/Plog 链 | 真实 HTTP 上传及浏览器验收通过 |
| Android MediaStore 文件夹递归发现 | `FolderRepository` + `MediaStoreScanner`；APK 编译与 Lint 通过 |
| 全量／日期／仅新增初始化 | Android 文件夹选择后的三模式界面与 checkpoint |
| 部分权限禁用自动、保留手动 | `PhotoPermission` 状态机 + `ACTION_OPEN_DOCUMENT` 持久授权 |
| 离线队列与恢复 | Android SQLite queue + WorkManager 网络约束、5 次重试 |
| 手机移动／删除／编辑不改服务端 | MediaStore ID 幂等队列；服务端长期副本独立 |
| EXIF、2048px WebP、缩略图 | `ImageProcessor`；真实图片与自动测试验证 |
| 原图立即删除及 24h 兜底 | 自动测试验证立即删除；maintenance 与 system status 监测超期 |
| Provider 单图结构化及版本 Schema | `RecognitionProvider` seam、Zod Schema、一图一 Job |
| 模型失败仍建元数据 Photo Log | Provider 未同意测试通过，状态为待识别且 WebP/事实保留 |
| 每日日期 Plog 与遗漏补生成 | 按发现时区枚举历史日期并幂等生成 |
| 单图日期 Plog、不自动主题 Plog | 单图 Plog 测试通过；自动主题阈值至少两张高置信照片 |
| Plog 不重复发送图片 | `composePlog` 只接收结构化 Photo Log 数组 |
| 主题确认、Plog 审核、候选新版 | Web 操作齐全；候选新版自动测试通过 |
| 照片网格首页与草稿入口 | 浏览器视觉验收通过 |
| 敏感缩略图默认模糊 | 全局设置默认 true；详情可纠正敏感分类 |
| 归档不自动生成、可手工选用 | 自动日期查询排除归档；搜索后可手动选择 |
| Plog/照片/来源删除语义 | Plog 独立删除；多来源单独移除；永久缺图匿名占位 |
| 30 天回收站、24h 永久清理 | 到期时间持久化；小时 maintenance 在 SLA 内清理 |
| Tailnet 无登录完整权限 | 无认证中间件；运行手册明确网络边界 |
| 每字段置信度、来源与 unknown | 模型 confidence、事实/模型/覆盖三层和 unknown/null Schema |
| Plog 段落事实追踪 | 自动测试断言 `photoLogIds` 与 `factFields` 非空 |
| Provider 撤回与切换隔离 | 同意门禁和暂停队列；Provider 固定配置且不静默切换 |
| 并发编辑不静默丢失 | 版本号更新；过期版本自动测试得到 409 |
| 取消、删除、恢复、永久删除 | 状态机接口、运行中取消检查、恢复保留覆盖、匿名占位 |
| 导出导入与搜索重建 | 完整往返自动测试；搜索直接由源表重建，不调用模型 |
| 一键清空不被同步逆转 | 来源保护自动测试通过 |

## 外部环境门禁

真实 Gemini 响应质量、地区可用性和免费／付费条款必须由部署者在持有 API key 的官方支持地区完成最终确认；未满足时系统保持可用但明确停在演示或待识别状态。Android 厂商后台时效需在目标真机进行 30 天观测，属于 PRD 成功指标观察期，不是代码构建结果。
