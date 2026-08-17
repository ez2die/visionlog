# VisionLog MVP 技术设计

## 模块与 seam

`Library` 是主业务模块。Web、Android 和测试只通过其 HTTP 接口完成导入、查询、修正、Plog、归档与删除。它隐藏 SQLite 事务、状态转换、幂等与关系维护。

- `ImageProcessor`：文件校验、EXIF、方向修正、2048px WebP 与缩略图。当前 adapter 为 Sharp + exifr。
- `RecognitionProvider`：一图一请求的识别与仅结构化文字的 Plog 写作。当前有 Gemini adapter 和不伪装视觉能力的确定性演示 adapter。
- `DataTransfer`：完整导出、哈希验证、空白实例导入和引用完整性校验。
- `SyncWorker`：Android 持久队列的最终一致上传；MediaStore 扫描和上传错误被封装在原生端内部。

## 运行拓扑

```text
Android MediaStore -> SQLite sync queue -> WorkManager -> HTTP multipart
                                                        |
Web upload ---------------------------------------------+
                                                        v
Fastify -> Library -> SQLite / compressed WebP
                    -> RecognitionProvider -> Gemini
```

应用本身没有身份认证。部署端口只能暴露在家庭网络或 Tailnet；可达端口即拥有完整权限。

## 持久化与状态

- SQLite 使用 WAL、外键与同步事务。
- 上传先按原始字节 SHA-256 去重，压缩后立即删除临时原图。
- Job、Android 上传队列、回收站期限、模型原始响应期限都持久化。
- Photo Log 编辑使用版本号乐观锁；用户修改后整条锁定。
- Plog 输入变化只设置“有可用更新”，候选新版经比较确认后才替换当前版。
- 永久删除把 `(source_kind, source_key)` 写入最小忽略表，避免后台回流。

## 隐私门禁

- 未配置 Gemini 时使用演示 adapter；它只根据文件名建立可辨识的演示数据。
- 配置 Gemini 后，未确认当前 Provider 条款时任务停在“待识别”。
- API key 仅来自服务端环境变量，不进入客户端、SQLite 或导出包。
- 原始模型响应 30 天清理；临时上传 24 小时兜底清理。

## 已知平台边界

- Android 自动同步要求完整图片权限；部分权限只支持系统文档选择器手动纳入。
- 系统后台执行由 WorkManager 调度，15 分钟是最小周期而不是送达 SLA。
- Gemini 的官方地区与条款必须在实际部署位置再次确认；Provider seam 支持替换。
- VisionLog 保存的是长期压缩副本，不是原图备份，也不承诺服务端灾备。
