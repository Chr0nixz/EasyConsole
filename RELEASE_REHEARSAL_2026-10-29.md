# 2026-10-29 草稿打包演练

状态：**通过，草稿已清理。** 六个目标构建及产物核验全部通过。源码 `91c5153bec7b62d2b62cf6dd469bbb78317acaaa`，版本 **0.4.27**；本轮未推版本 tag，未做安装、账号操作或自动更新。

- [Release 演练](https://github.com/Chr0nixz/EasyConsole/actions/runs/40750407480)：`workflow_dispatch`，仅限本分支草稿预发布。
- [三平台 CI](https://github.com/Chr0nixz/EasyConsole/actions/runs/40750384576) 和 [Android debug CI](https://github.com/Chr0nixz/EasyConsole/actions/runs/40750384903) 全部通过；三平台覆盖率、native 单测/SSH 集成测试和 Android debug APK 构建均成功。
- 本地 117 文件 / 882 测试、覆盖率四项、app/tools 类型检查、lint（37 警告 / 0 错误）、桌面输入构建和 cargo check/fmt/clippy 均通过。详细数值见发布清单。

## 演练产物

| 目标 | 安装包 / 更新包 | 签名与 sidecar 布局 |
| --- | --- | --- |
| Windows x64 | NSIS + MSI 已生成 | 两包 updater 签名均通过；MSI 目录表核对通过 |
| Linux x64 | 重跑 AppImage / deb / rpm 与附件上传全部成功 | 重跑三包 updater 签名均通过；deb / rpm 布局核对通过 |
| macOS arm64 | DMG + app 更新归档已生成 | app updater 签名通过；两个 sidecar 均在 Contents/MacOS |
| macOS x64 | DMG + app 更新归档已生成 | app updater 签名通过；两个 sidecar 均在 Contents/MacOS |
| Android aarch64 | 已生成，29896189 字节 | APK v2 签名通过，证书与 0.4.27 相同，ABI arm64-v8a |
| Android x86_64 | 已生成，29671146 字节 | APK v2 签名通过，证书与 0.4.27 相同，ABI x86_64 |

已核对：draft/prerelease、target SHA、Release body 与 `latest.json.notes` 一致、版本与平台 URL 正确、URL 指向本次草稿、更新包签名能由固定公钥验证、Android 两架构证书与已发布版本相同。资产 SHA-256 已记录，演练草稿已删除。CI artifacts 保留用于复查。

Windows 阶段已确认草稿 `manual-51`（Release ID `427091116`）的 draft/prerelease 均为 true，target 为本次完整 SHA；updater 版本为 0.4.27，notes 与 Release body 完全一致。当前三个 Windows 平台键的 URL 均指向本次草稿内的同名资产，默认更新包为 NSIS。

NSIS（asset `686069764`）SHA-256：`6ace674ba2c73955c5b7d90aed0e9afc078180198c6847c785c77ddbecc04431`；MSI（asset `686069546`）SHA-256：`8e71e35a5c781fb9c620eae8c3b3fb1b795bdf985eb5b89942b4d3ba91e47da6`。下载后尺寸与 digest 均和 GitHub 一致；用缓存的 `minisign-verify 0.2.5` 验证 metadata 中的签名，两包均通过固定 updater 公钥验证。NSIS 的 `Get-AuthenticodeSignature` 为 NotSigned，符合本次决定；不是 updater 验证失败。

只读查询新旧 MSI 的 File / Component / Directory / Property 表，两版均把 `EasyConsole.exe`、`easy-console-cli.exe` 和 `easy-console-mcp.exe` 放在 `INSTALLDIR`；父目录为 `ProgramFiles64Folder`，默认 EasyConsole 子目录，ALLUSERS=1。即 MSI 默认 MCP 路径为 `%ProgramFiles%\EasyConsole\easy-console-mcp.exe`；本轮未执行安装器。旧版公开 MSI asset `671520937` 的 SHA-256 为 `4d8d74c59dde42414046a92b0e89fce829759893b1d6e5ed083c9738e4fa4eeb`。

Windows 出包后再次查询公开 latest，仍为 v0.4.27（Release `422568352`，updater asset `671613547`），草稿未替换正式更新源。其余平台完成后继续复核。

首轮 Linux job `123035306379` 在已上传 Release 资产后，于 Upload desktop artifacts 失去 runner 通信（GitHub annotation 原文为 “The hosted runner lost communication with the server.”）。首轮 job 失败，Android 因依赖失败被跳过；首轮不能认定通过。同一源码重跑 job `123266201753` 已成功，其他三个桌面目标的成功结果复用，随后 Android 两架构也均通过。三个 Linux 包和两个 macOS app 归档均已下载、核对 GitHub SHA-256，并通过固定 updater 公钥验证；重跑替换的 Linux 资产也已重新核验，见下方最终 updater 记录。

只读检查首次 deb 的 data.tar.gz 和 rpm 包清单，三个入口位于 `/usr/bin/EasyConsole`、`/usr/bin/easy-console-cli`、`/usr/bin/easy-console-mcp`。macOS 两归档均包含 `EasyConsole.app/Contents/MacOS/` 下三个同名入口；移到 `/Applications` 后对应 MCP 路径为 `/Applications/EasyConsole.app/Contents/MacOS/easy-console-mcp`。逐个读取三个入口的二进制头：Linux 均为 ELF64 x86-64，两个 macOS 归档均为对应 arm64 / x86-64 的 Mach-O 64。本轮没有在这些系统上执行安装。

重跑后的七个唯一桌面更新包全部通过 metadata 签名验证，两个 DMG 也完成下载 digest 核对。11 个平台键和别名均引用本次草稿内的资产，Windows 默认 NSIS。最终桌面 updater asset `687395662` 的原始 SHA-256 为 `bb8384edf62913809d0efcb0245a117a812f075cb68c9c74c3b699af2ecb06d6`；[规范化 JSON 快照](docs/release-evidence/2026-10-29/manual-51.latest.snapshot.json) 保存正文、URL 和签名，供草稿删除后复核，不是生产更新源。

Android 两个 release job 也已成功。下载 APK 后重新用 apksigner / aapt 核对：均为 `com.easyconsole.desktop`、0.4.27 / 4027，一个签名者，APK v2 验证通过；证书 SHA-256 均与下方两份旧版公开 APK 相同，各自仅包含预期 ABI。本轮不使用 debug 证书代替正式证书。

## 最终资产 SHA-256

以下 11 个安装/更新资产全部完成下载 digest 核对。七个桌面更新资产另完成固定公钥验签；两个 APK 另完成 Android 证书及 ABI 检查。

| 资产 | SHA-256 |
| --- | --- |
| NSIS | `6ace674ba2c73955c5b7d90aed0e9afc078180198c6847c785c77ddbecc04431` |
| MSI | `8e71e35a5c781fb9c620eae8c3b3fb1b795bdf985eb5b89942b4d3ba91e47da6` |
| AppImage（重跑） | `362176bcbb09b9a746df8fcc2988ce2c003f82da89d961eb862a0f8b378a9651` |
| deb（重跑） | `0d6b10310e4f625ca86f06eb4b077282246782234547e9d409987e0af3f5bb11` |
| rpm（重跑） | `c54689b7cede5c9e5d08bd40da3c6029c8cb07e30d271fa1776d75eadd7d4bfe` |
| macOS arm64 app.tar.gz | `e2baef6dea36a14b607189d94331a1cd5e5e2f9554a10189ac8303285efbe922` |
| macOS x64 app.tar.gz | `68b3e0ee9c70d2b53361d434dc204cf09b234c4cbbd8e8a9644f48b2968ae2fb` |
| macOS arm64 DMG | `fe135b9417329981a9c52201d886ec02e5bd17f7d78809730437313320456a24` |
| macOS x64 DMG | `3a18e36c940cc1268f6fed2c19ee30427fc46d1d76ad2716f228ac676dcd8821` |
| Android aarch64（asset 687412442） | `dc0caafc3add32ccfea62866648b285f6cdc15611efb04fddccadc69517889ce` |
| Android x86_64（asset 687417139） | `fd70a071e1945a9325ef5eba5caeeeb26a6870524de2f22806c71ed1e7ca85cc` |

构建证据保留于本次 run 的 CI artifacts（30 天保留）：Windows desktop `12845450358`、Linux desktop `12873998296`、macOS arm64 `12849490977`、macOS x64 `12849958951`、Android aarch64 `12874447978`、Android x86_64 `12873709319`。GitHub Release 草稿可删除，构建记录不因此删除。

## 草稿清理与正式更新源

全部核验后删除 Release `427091116`（`manual-51`），再次查询草稿列表已无该条目；该草稿未生成 Git tag，清理时 `manual-51` ref 不存在。公开 latest 仍为 Release `422568352` / `v0.4.27`，updater asset 仍为 `671613547`。没有发布或替换生产安装包、版本 tag 或自动更新元数据。

## Windows sidecar 可执行产物检查

同一源码的三平台 CI 产物 `easy-console-sidecars-windows-x64`（artifact ID `12842439553`）ZIP SHA-256 为 `a10c27bf0642df8d6e418a93d2fea11a34b5e3204b8259d7a3518f2f1d08fdc4`，与 GitHub digest 一致。内含 CLI 58490736 字节、MCP 60091975 字节，各一个文件；没有 target-triple 后缀。

在独立临时配置/共享存储/下载目录，用 HTTPS 保留测试域且不提供 token 执行以下检查，全部通过，未连接真实控制台：

- CLI 帮助可启动；login、refresh-token、task download、backup export --output 四个默认预览成功，未创建凭据或目标文件。
- MCP SDK 客户端可完成 stdio 握手；`tools/list` 有 54 个唯一工具，refresh-token confirm 为布尔参数，三个实验性接口说明正确。
- `resources/list` 包含两个集合；读取空模板返回 JSON 数组；MCP refresh-token 默认预览成功，未创建凭据。

这里只证明可执行 sidecar 的启动和契约，不代替安装包路径或真实 API 验收。

同一 Release job 的 sidecar artifact `12844972147`（ZIP SHA-256 `306f2840df1ca7eb78bd3882a1b27f8c1b3b509b403f5e8fa85f7910e48542c9`）也完成上述全部检查。CLI / MCP 分别为 58490720 / 60091967 字节，与新 MSI File 表完全一致；未安装应用或访问真实账号。

## 已发布 Android 的公开签名基线

从 [v0.4.27](https://github.com/Chr0nixz/EasyConsole/releases/tag/v0.4.27) 下载公开资产 `EasyConsole-v0.4.27-android-aarch64.apk`，核对 GitHub 资产 SHA-256 后，用 Android SDK Build Tools 35.0.1 的 `apksigner verify --verbose --print-certs` 与 `aapt dump badging` 读取。只读取 APK 里的公开证书，未读取 keystore 或口令。

| 字段 | 值 |
| --- | --- |
| 资产 ID | `671631949` |
| APK SHA-256 | `0afb12e802a4e3520a2526f9187fd6ce9ba8552a5a8774cc51cf9dfa14b50bc5` |
| 公开 x86_64 APK | asset `671630681`，SHA-256 `53325402a34696ae1b64049a4521af8ffc94f43f4758a8063abf96d8dee3425c`；签名验证通过，包名、版本及证书指纹与 aarch64 相同 |
| application ID | `com.easyconsole.desktop` |
| versionName / versionCode | `0.4.27` / `4027` |
| APK 签名验证 | 通过，v2，一个签名者 |
| 证书 SHA-256 | `2f7730e118dd16346098c92d426196430c8779584c60a7fd1f130e8c6e9d001b` |

公开证书和构建服务可签名都不能证明离线私钥备份可用；备份恢复验证仍是独立发布门槛。演练也不验证 0.4.27 → 0.5.0 数据迁移、系统钥匙串、真实安装路径、OpenSSH 或移动设备行为。
