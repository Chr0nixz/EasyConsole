# 发布正文来源

正式 tag 发布前，将该版本最终正文保存为本目录的 `<major.minor.patch>.md`，例如 `0.5.0.md` 或 `1.0.0.md`。文件必须存在且非空；历史综合 changelog `RELEASE_NOTES.md` 不会整份塞进单次更新提示。

`tools/easy-console/release-metadata.ts` 统一生成 release tag、名称、草稿状态和正文：

- 只有匹配当前版本的 tag **push** 才正式发布，并要求对应正文文件。
- `workflow_dispatch` 始终是 `manual-N` 草稿预发布，包括从 tag 手动运行的情形；缺少版本正文时使用明确的打包演练说明。
- 四个桌面矩阵使用同一份正文，Android 使用桌面 job 输出的同一 release tag；草稿指向实际构建的源码 SHA。
- 正文通过 `releaseBody` 交给固定版本的 tauri-action。该 Action 把同一字符串写入 GitHub Release 正文和 `latest.json.notes`；桌面更新器的 `update.body`、Android 的 Release body 进入应用更新提示。

演练从**包含新 workflow 的发布准备分支**发起。历史 tag 保留当时的旧 workflow；例如 v0.4.27 只按 ref_type 决定公开/草稿，不能把本分支的保护视为对旧 tag 生效。GitHub dispatch 的 [ref 参数可选分支或 tag](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)，因此操作时要明确选择准备分支，不手动运行历史 tag。

本地预览不会创建 Release：

```powershell
node --import tsx tools/easy-console/release-metadata.ts
```

演练完成后，核对 GitHub Release 的 draft/prerelease、target commit、资产、`latest.json.version`、`notes`、各平台 URL 和签名，再删除本次演练草稿。正式应用内更新、旧数据完整性与离线签名备份仍需单独验收。

1.0 的产品全貌草案在 [RELEASE_NOTES_1.0.0_DRAFT.md](../../RELEASE_NOTES_1.0.0_DRAFT.md)。它不在自动发布路径内，不能代替真实环境验收后的最终正文。

链路依据：[固定 tauri-action 的 releaseBody 输入](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/action.yml)、[正文传入 updater metadata](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/src/index.ts)、[notes 序列化](https://github.com/tauri-apps/tauri-action/blob/84b9d35b5fc46c1e45415bdb6144030364f7ebc5/src/upload-version-json.ts)。

## 为什么 tauri-action 停在 v0.6.2

2026-11-25 评估了 action-v1.0.0（`1deb371b0cd8bd54025b384f1cd735e725c4060f`），结论是暂不升级，release.yml 继续固定 action-v0.6.2。

- **更新下载会占用 GitHub API 配额。** v1 把 `latest.json` 的下载地址从 `github.com/<o>/<r>/releases/download/...` 改成 [`api.github.com/repos/<o>/<r>/releases/assets/<id>`](https://github.com/tauri-apps/tauri-action/blob/1deb371b0cd8bd54025b384f1cd735e725c4060f/src/upload-version-json.ts)，没有开关。上游这样改是为了[私有仓库更新](https://github.com/tauri-apps/tauri-action/issues/1297)，本仓库是公开的，用不到。已装客户端（tauri-plugin-updater 2.10.1）会带 User-Agent 和 `Accept: application/octet-stream`，所以下载本身能成功。但每次下载都要计入 GitHub 未认证 API 的 `core` 配额：每个 IP 每小时 60 次。2026-11-25 用更新器的请求头取 v0.4.27 资产实测：API 地址返回 302 并让 `x-ratelimit-used` 加一，`releases/download` 地址不计数。团队在实验室或校园 NAT 后面共用出口 IP，这份配额还要和 Android 端检查更新（已经走 API）以及同一网络里的其他工具分着用。配额耗尽后，桌面更新会直接报 `Download request failed with status: 403`。
- **v1 的新功能本仓库都不需要。** 移动端构建、workflow artifact 上传、私有仓库支持这里都用不上，本仓库也不构建 universal 包。v0.6.2 已经运行在 node24，没有运行时退役逼着升级。
- **草稿演练证明不了客户端能更新。** 0.4.27 客户端的更新端点固定为 `releases/latest/download/latest.json`，永远不会指向草稿；草稿资产通过 API 下载也需要认证。要验证真实更新，只能发布正式 latest，也就是推送给所有已装客户端。
- **下面三项对本流程无害，复评时不用再查。** 一是 macOS `.app.tar.gz` 和 `.sig` 资产名会带上版本号，但客户端只读 `latest.json` 里的 URL。二是 `releaseDraft: true` 遇到已发布的 release 会失败；手动运行用的 `manual-N` 按 run number 唯一，演练草稿用完即删，tag push 也不走草稿，所以碰不到。三是 v1 会覆盖已发布 release 的名称和正文；tag push 的四个桌面 job 写入的都是同一份 `release-metadata.ts` 输出，只会冲掉在 job 运行期间到网页上手改的正文。

出现以下任一情况时重新评估：v0.6.2 不兼容新版 Tauri CLI 或 runner；上游提供了保留 `browser_download_url` 的选项。到时也可以在四个桌面 job 之后加一步，把 `latest.json` 的 URL 改回 `releases/download`（updater 签名只覆盖安装包，不覆盖 URL）。但这等于在持有签名密钥的 workflow 里加入自己的代码，要先做一次草稿演练。
