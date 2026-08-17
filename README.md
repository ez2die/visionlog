# VisionLog

个人照片日志 MVP：上传照片后生成压缩长期副本、结构化 Photo Log、动态主题与日期/选图 Plog，并支持编辑、搜索、归档和 30 天回收站。

## 本地运行

```bash
pnpm install
cp .env.example .env
pnpm start
```

打开 <http://localhost:4173>。未设置 `GEMINI_API_KEY` 时会使用确定性的本地演示 Provider；它用于跑通产品链路，不声称完成真实视觉识别。

若使用 Gemini，设置 `GEMINI_API_KEY`、固定模型 ID、服务层级与同意状态。免费服务须在界面设置页确认风险后才会发送图片。

数据默认保存在 `./data`：SQLite 数据库、2048px WebP 主图、缩略图和短暂上传文件。原始上传在压缩图校验后立即删除。

也可以直接部署家庭服务器：

```bash
cp .env.example .env
docker compose up -d --build
```

应用不提供登录。只在家庭网络或 Tailscale Tailnet 内开放 `4173` 端口；所有可达设备都有查看、编辑和永久删除权限。

## Android

Android 客户端位于 `android/`，最低 Android 10。它支持：

- 完整／部分／拒绝照片权限状态；部分权限禁用自动文件夹同步。
- 选择一个 MediaStore 实体图片文件夹，递归包含子目录。
- 全量、指定日期以后、仅新增三种初始化方式。
- SQLite 持久上传队列、前台补偿扫描、WorkManager 15 分钟后台扫描和最多 5 次重试。
- 系统文档选择器手动纳入照片，在部分权限下也可使用。
- 内嵌 Web 照片库，共用家庭服务器的全部整理能力。

用 Android Studio 打开 `android/`，或在已安装 Android SDK 36 的环境构建：

```bash
cd android
./gradlew assembleDebug
```

Debug APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。首次打开后填写 Tailnet 地址，例如 `http://100.x.x.x:4173`。

## 验证

```bash
pnpm test
pnpm run check
cd android && ./gradlew lintDebug assembleDebug
```

## 网络边界

应用不含登录。请只把端口暴露在家庭网络或 Tailnet 内；任何能访问该端口的设备都拥有完整读写和永久删除权限。
