# 本地数据格式与 1.x 兼容约定

确认日期：2026-10-28。以下记录当前桌面与 sidecar 的格式；安装包升级验收仍按 [发布清单第 2 节](RELEASE_CHECKLIST_1.0.0.md#2-050承载本地存储迁移) 单独执行。

1.x 保留旧格式的导入与向前迁移路径。升级必须保留迁移源，拒绝无法识别的格式，不能把损坏或未来版本当成空存储覆盖。新格式或密码派生参数需要版本化；不能仅修改常量就让旧数据失去可读性。降级只会看到旧版快照，不把新旧存储当作双向同步。

## 运行时存储：manifest v1

源码：`src-tauri/src/runtime_storage.rs`、`tools/easy-console/local-data-store.ts`。

- 存储锚点为应用数据目录下的 `runtime-storage.json`；当前内容放在同级 `runtime-storage.d/`。配置覆盖只改变 sidecar 的锚点，不改变桌面应用标识。
- `manifest.json` 是迁移完成标记，格式为 `{"version":"1"}`。版本值是字符串。所有旧记录落盘后才发布主/备份 manifest；已完成的迁移不重新导入旧快照。
- 每个 key 的文件名是该 key 的 UTF-8 字节的 SHA-256 小写十六进制，加 `.json`。不对 key 做大小写、空白或路径归一化。
- 记录只包含字符串字段 `key` 和可选 `value`。例如 `{"key":"easy-console-language","value":"zh-CN"}`；值可以是序列化后的业务 JSON，存储层保持原字符串。
- 只有 `key`、没有 `value` 的记录是删除标记；文件不存在与已有删除标记不能混为一谈。旧 CLI 数据、浏览器兜底数据和中断后的迁移不得复活已删除的值。
- 主文件损坏或缺失时尝试 `.bak`。写入先同步临时文件，再发布备份与新主文件；恢复失败必须报错，不能静默清空。无变更写入和失败的 CAS 不轮换备份。
- 初次迁移读取旧 `runtime-storage.json` 及必要的 `.bak`，保留它们不变。旧 CLI `local-data.json` 只填充缺失记录，并在成功后写入按目标区分的迁移标记；凭据通过独立 adapter 导入 sidecar 本地凭据存储。

## 桌面 / Node 共享目录锁

源码：`src-tauri/src/runtime_storage_lock.rs`、`tools/easy-console/local-data-store.ts`。这是当前共享锁协议基线，磁盘上没有独立的协议版本文件。

- 锁目标为规范化后的存储锚点加 `.lock` 后缀，例如 `runtime-storage.json.lock/`，通过原子创建空目录取得锁。锚点不存在时规范化其父目录，不创建空的旧数据文件。
- 同一锚点的读取、迁移、写入、CAS 和事务均使用这把锁；不是每个 key 一把锁。Node 用异步调用链标识重入，独立请求仍串行竞争。
- 目录 mtime 是心跳：每 10 秒更新，超过 30 秒才可作为陈旧锁回收；回收前再次核对 mtime。持有者发现目录丢失或 mtime 被其他持有者改变时，当前操作失败，不能继续写入。
- 释放时仅删除仍属于本持有者的空锁目录，不递归清理别的进程的目录。Rust 与 `proper-lockfile` 的参数必须保持兼容；变更协议需要安排混合版本的迁移策略。
- 已有回归覆盖双向互斥、同 key 的 Node/Rust 并发更新、删除标记和中断迁移。安装包与跨平台结果见发布清单及 CI。

## 本地导出备份：v1

源码：`src/lib/local-data-backup.ts`，`LOCAL_DATA_BACKUP_VERSION = 1`。

顶层是 `app: "EasyConsole"`、数字 `version: 1`、`exportedAt`、`includeSecrets` 和 `items`。当前 items 支持 settings、language、taskTemplates、resourcePresets、scheduledTasks、runLogs，以及显式包含机密时的 token / savedAccounts。旧备份可以缺少后来新增的 section；导入方保留按 section 选择和凭据 adapter 隔离。

这份导出格式不是整个应用数据目录的镜像。执行台账、变更清单、SSH 主机信任、VS Code key 等不在当前导出 section 中；完整升级验收必须另外核对这些持久数据。0.4.27 安装包生成的数据 fixture 和升级导入回归仍为发布清单待办。

## 加密导出备份：v1

源码：`src/lib/backup-crypto.ts`。

顶层是 `app: "EasyConsole"`、`encrypted: true`、数字 `version: 1`、`exportedAt`、`kdf` 和 `cipher`。v1 固定使用 PBKDF2 / SHA-256、150000 次迭代、16 字节随机 salt，派生 AES-256-GCM 密钥；IV 为 12 字节，salt、IV 和密文均为 base64。

密文内是完整的本地备份 JSON。当前 v1 解密器使用固定的派生参数，不能只改导出 metadata 或默认迭代次数；后续格式必须保留 v1 解密路径。错误密码或密文损坏必须报错。
