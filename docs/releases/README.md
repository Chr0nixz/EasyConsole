# 发布正文来源

正式 tag 发布前，将该版本最终正文保存为本目录的 `<major.minor.patch>.md`，例如 `0.5.0.md` 或 `1.0.0.md`。文件必须存在且非空；历史综合 changelog `RELEASE_NOTES.md` 不会整份塞进单次更新提示。

`tools/easy-console/release-metadata.ts` 统一生成 release tag、名称、草稿状态和正文：

- 只有匹配当前版本的 tag **push** 才正式发布，并要求对应正文文件。
- `workflow_dispatch` 始终是 `manual-N` 草稿预发布，包括从 tag 手动运行的情形；缺少版本正文时使用明确的打包演练说明。
- 四个桌面矩阵使用同一份正文，Android 使用桌面 job 输出的同一 release tag；草稿指向实际构建的源码 SHA。
- 正文通过 `releaseBody` 交给固定版本的 tauri-action。该 Action 把同一字符串写入 GitHub Release 正文和 `latest.json.notes`；桌面更新器的 `update.body`、Android 的 Release body 进入应用更新提示。

本地预览不会创建 Release：

```powershell
node --import tsx tools/easy-console/release-metadata.ts
```

演练完成后，核对 GitHub Release 的 draft/prerelease、target commit、资产、`latest.json.version`、`notes`、各平台 URL 和签名，再删除本次演练草稿。正式应用内更新、旧数据完整性与离线签名备份仍需单独验收。

1.0 的产品全貌草案在 [RELEASE_NOTES_1.0.0_DRAFT.md](../../RELEASE_NOTES_1.0.0_DRAFT.md)。它不在自动发布路径内，不能代替真实环境验收后的最终正文。

链路依据：[固定 tauri-action 的 releaseBody 输入](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/action.yml)、[正文传入 updater metadata](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/src/index.ts)、[notes 序列化](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/src/upload-version-json.ts)。
