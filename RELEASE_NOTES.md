# EasyConsole v0.1.1

本版本补齐桌面端自动更新链路，并把 GitHub Release 作为稳定更新源。

## 更新内容

- 新增设置页“应用更新”区域，可查看当前版本、更新源，并手动检查更新。
- 新增启动后自动检查更新开关；桌面端会按节流策略检查 GitHub Release 中的稳定版本。
- 检测到新版本时展示更新说明，用户确认后下载、安装，并提示重启完成更新。
- 发布流程加入 Tauri updater 签名、版本一致性校验，以及 GitHub Release updater manifest 生成。
- CLI/MCP 侧车继续随桌面包一起发布，保持与桌面应用版本一致。

## 发布备注

发布前请确认 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 已配置，并在 draft release 中检查 `latest.json` 与签名文件是否存在。
