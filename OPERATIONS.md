# VisionLog MVP 运行手册

## 家庭服务器

直接运行：

```bash
pnpm install
cp .env.example .env
pnpm start
```

或在 Docker daemon 已启动时：

```bash
docker compose up -d --build
docker compose ps
```

健康检查：`curl http://127.0.0.1:4173/api/health`。数据目录为 `./data`，升级前停止进程；SQLite 会在启动时执行幂等 schema 迁移。

## Tailscale

服务监听 `0.0.0.0:4173`。通过服务器的 Tailnet IP 访问，例如 `http://100.x.x.x:4173`。不要把该端口直接暴露到公网；应用没有登录，Tailnet 成员等同完整管理员。

## Gemini

在官方支持地区的服务端设置 `GEMINI_API_KEY` 和固定的 `GEMINI_MODEL`。免费服务还应设置 `GEMINI_TERMS_TIER=free`，并在 Web 设置页阅读风险后开启 Provider 同意。未配置 key 时使用演示 adapter；未同意时照片仍压缩建档，任务停在待识别。

## Android 安装

构建 `cd android && ./gradlew assembleDebug`，把 `app/build/outputs/apk/debug/app-debug.apk` 安装到 Android 10+ 手机。填写服务器 Tailnet 地址，授予完整图片权限并选择一个设备图片文件夹。Android 14+ 部分权限下自动同步暂停，但“手动选择照片导入”仍可用。

## 故障处置

- 服务不可达：Android 队列保留 URI，恢复网络后自动重试；打开 App 会补偿扫描。
- Provider 暂停：确认设置页的数据处理授权，随后对待识别任务点重试。
- 存储不足：服务返回 507 并停止接收；释放空间后重试，不会自动删图或降质。
- 临时原图超期：`/api/system/status` 的 `overdueOriginals` 必须为 0；非零会在首页显示阻断横幅。
- 迁移：从设置页生成导出包，只能导入数据为空的新实例。导出是迁移手段，不是定时备份。

## 验证命令

```bash
pnpm run check
pnpm test
cd android && ./gradlew lintDebug assembleDebug
docker compose config --quiet
```

