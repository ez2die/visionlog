# VisionLog MVP HTTP 接口

所有接口无应用层认证，仅允许在家庭网络或 Tailnet 内开放。JSON 请求使用 `Content-Type: application/json`。

## 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活与当前 Provider |
| GET | `/api/system/status` | 剩余空间、超期原图、Provider 暂停状态 |
| GET/PATCH | `/api/settings` | 全局时区、Plog 小时、敏感模糊、Provider 同意 |
| POST | `/api/maintenance/run` | 过期清理与日期 Plog 补生成 |

## 照片与任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/photos/import` | multipart 多图导入；Android 传 `source=android`、`x-visionlog-source-key`、`x-visionlog-timezone` |
| GET | `/api/photos` | 照片列表；支持 `q/dateFrom/dateTo/topicId/status/tag/location/mime/archived/trash` |
| GET/PATCH | `/api/photos/:id` | Photo Log 详情与版本号乐观锁编辑 |
| POST | `/api/photos/batch` | `archive/trash/add_topic/re_recognize` |
| POST | `/api/photos/:id/archive` | 归档或恢复归档 |
| POST | `/api/photos/:id/trash` | 移到 30 天回收站 |
| POST | `/api/photos/:id/restore` | 恢复照片及关系 |
| DELETE | `/api/photos/:id` | 永久删除；必须已在回收站 |
| DELETE | `/api/photos/:id/sources/:sourceId` | 多来源资产仅移除一个来源 |
| GET | `/api/jobs` | 最近处理任务与错误 |
| POST | `/api/jobs/:id/retry` | 重新排队 |
| POST | `/api/jobs/:id/cancel` | 取消下游步骤并保留部分结果 |

图片通过 `/media/:assetId/master` 和 `/media/:assetId/thumbnail` 读取。

## Topic 与 Plog

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/topics` | 活跃、候选与归档主题 |
| POST | `/api/topics/:id/confirm` | 同时确认名称与成员 |
| PATCH/DELETE | `/api/topics/:id` | 重命名、归档、删除分类 |
| POST | `/api/topics/:id/merge` | 把另一主题合并到当前主题 |
| GET/POST | `/api/plogs`、`/api/plogs/generate` | 列表与手工/日期/主题生成 |
| GET/PATCH | `/api/plogs/:id` | 阅读、编辑文字/封面、确认与反馈 |
| POST | `/api/plogs/:id/regenerate` | 生成不覆盖当前版的候选新版 |
| POST | `/api/plogs/:id/resolve-update` | 接受或拒绝候选新版 |
| POST | `/api/plogs/:id/archive` | 归档／取消归档 |
| POST | `/api/plogs/:id/trash` | 删除 Plog，不删除照片 |

## 迁移与清空

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/library/export` | 生成含 manifest 与哈希的 `.tar.gz` 完整导出 |
| POST | `/api/library/import` | 只导入空白实例，验证文件哈希、计数和引用 |
| POST | `/api/library/clear` | 确认短语为 `清空我的 VisionLog`，批量放入回收站并保护来源 |
| POST | `/api/library/reset-import-protection` | 允许重新导入曾永久删除的来源 |
| GET | `/api/search?q=` | 按照片、主题、Plog 分组搜索 |
| POST | `/api/search/rebuild` | 验证从源表直接重建的搜索策略 |

