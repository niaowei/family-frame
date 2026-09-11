# apps/android — 相框原生端

家庭语音相框的 Android 原生客户端（Java）。安装在家中长辈的 Android 设备/相框上，绑定服务端后自动接收、展示家人发来的照片，播放语音留言，并对纯文字留言做语音播报。

## 构建

前置要求：JDK 17、Android SDK（Platform 35 / Build-Tools 35）、网络可达 Maven 仓库。

```bash
cd apps/android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`。

`app/libs/` 内置了 okhttp / okio 依赖 jar，无需额外仓库配置。

## 绑定与使用

1. 服务端执行 `npm run bootstrap:family` 创建家庭与设备，输出一次性设备令牌（数据库只存哈希）。
2. 相框安装 APK 后进入「设置」页，填入服务端地址与设备令牌，点「保存并同步」完成绑定。
3. 之后回到主界面即自动同步；家人在网页用短码也可以为新设备配对。

## 主要模块

| 模块 | 职责 |
|---|---|
| `FrameActivity` | 主界面：全屏轮播、播放按钮、留言展示、点亮即同步 |
| `ConfigActivity` | 设置页：服务端地址/令牌、立即同步、库状态、储存卡备份/恢复 |
| `SyncEngine` | 增量/全量同步、媒体下载校验、完成回执、seen/heard 事件；类级锁串行化避免多入口并发覆盖 |
| `FrameStore` | 本地库（`files/library/index.json` + 媒体文件），进程内共享单例；索引缺失时自动从磁盘恢复 |
| `VoiceEngine` | 真人录音播放（MediaPlayer）；文字留言微软在线神经语音合成，离线 eSpeakNG 兜底 |
| `MsTts` | Edge 朗读 WebSocket 端点的 TTS 客户端，含时钟偏差自动修正 |
| `Backup` | 媒体导出/恢复到系统储存卡目录（SAF），不含设备令牌 |

## 验收

仓库根目录的 `scripts/check-frame-sync.mjs` 会对真机执行端到端验收（feed 校验、媒体完整性、回执、切页与重启后内容不丢失）。
