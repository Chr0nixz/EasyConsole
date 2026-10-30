//! Per-key runtime storage. Callers hold the native runtime-storage lock while
//! opening the store and running a read/modify/write or compare-and-swap.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{apply_storage_cas, load_string_map, storage_sidecar_path, trf, write_string_map};

const FORMAT_VERSION: &str = "1";

pub(crate) struct RuntimeStore {
    directory: PathBuf,
}

impl RuntimeStore {
    fn at(legacy_path: &Path) -> Self {
        Self {
            directory: legacy_path.with_extension("d"),
        }
    }

    fn manifest_path(&self) -> PathBuf {
        self.directory.join("manifest.json")
    }

    fn key_path(&self, key: &str) -> PathBuf {
        // Fixed-length filenames keep arbitrary keys, including account-scoped
        // URLs and imported data, inside the store on every platform.
        self.directory
            .join(format!("{:x}.json", Sha256::digest(key.as_bytes())))
    }

    fn exists(path: &Path) -> bool {
        path.exists() || storage_sidecar_path(path, ".bak").exists()
    }

    fn initialized(&self) -> Result<bool, String> {
        let path = self.manifest_path();
        if !Self::exists(&path) {
            return Ok(false);
        }
        let manifest = load_string_map(&path)?;
        if manifest.len() != 1
            || manifest.get("version").map(String::as_str) != Some(FORMAT_VERSION)
        {
            return Err(trf!(
                "本地存储版本无法识别，请保留数据并更新应用",
                "Unrecognized local storage version; keep the data and update the app"
            ));
        }
        Ok(true)
    }

    /// Import once, publishing the manifest only after all legacy keys are
    /// durable. The original file and backup remain untouched. An interrupted
    /// import can resume without overwriting already saved records/tombstones.
    pub(crate) fn open(legacy_path: &Path) -> Result<Self, String> {
        let store = Self::at(legacy_path);
        if store.initialized()? {
            return Ok(store);
        }
        let legacy = load_string_map(legacy_path)?;
        fs::create_dir_all(&store.directory).map_err(|error| {
            trf!(
                "无法创建本地存储目录：{error}",
                "Failed to create the local storage directory: {error}"
            )
        })?;
        #[cfg(unix)]
        if let Some(parent) = store.directory.parent() {
            Self::sync_directory(parent)?;
        }
        for (key, value) in legacy {
            if Self::exists(&store.key_path(&key)) {
                store.load_record(&key)?;
            } else {
                let record = HashMap::from([
                    ("key".to_string(), key.clone()),
                    ("value".to_string(), value),
                ]);
                store.persist_record(&key, &record)?;
            }
        }
        let manifest = HashMap::from([("version".to_string(), FORMAT_VERSION.to_string())]);
        // Both copies are completion markers: publish them only after every
        // imported record is durable, so metadata recovery cannot import a
        // stale legacy snapshot over current values.
        write_string_map(
            &storage_sidecar_path(&store.manifest_path(), ".bak"),
            &manifest,
        )?;
        write_string_map(&store.manifest_path(), &manifest)?;
        #[cfg(unix)]
        Self::sync_directory(&store.directory)?;
        Ok(store)
    }

    /// Startup reads close-to-tray preferences before the webview is ready.
    /// Do not run a potentially large one-time migration on the UI thread.
    #[cfg(any(desktop, test))]
    pub(crate) fn read_existing_value(
        legacy_path: &Path,
        key: &str,
    ) -> Result<Option<String>, String> {
        let store = Self::at(legacy_path);
        if store.initialized()? {
            store.get(key)
        } else {
            Ok(load_string_map(legacy_path)?.remove(key))
        }
    }

    fn load_record(&self, key: &str) -> Result<HashMap<String, String>, String> {
        let path = self.key_path(key);
        if !Self::exists(&path) {
            return Ok(HashMap::from([("key".to_string(), key.to_string())]));
        }
        let record = load_string_map(&path)?;
        if record.get("key").map(String::as_str) != Some(key)
            || record
                .keys()
                .any(|field| field != "key" && field != "value")
        {
            return Err(trf!(
                "本地存储条目无法识别，请保留数据并从备份恢复",
                "Unrecognized local storage entry; keep the data and restore from backup"
            ));
        }
        Ok(record)
    }

    fn persist_record(&self, key: &str, record: &HashMap<String, String>) -> Result<(), String> {
        write_string_map(&self.key_path(key), record)?;
        #[cfg(unix)]
        Self::sync_directory(&self.directory)?;
        Ok(())
    }

    #[cfg(unix)]
    fn sync_directory(path: &Path) -> Result<(), String> {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                trf!(
                    "无法同步本地存储目录：{error}",
                    "Failed to sync the local storage directory: {error}"
                )
            })
    }

    pub(crate) fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.load_record(key)?.remove("value"))
    }

    pub(crate) fn set(&self, key: &str, value: &str) -> Result<bool, String> {
        let mut record = self.load_record(key)?;
        if record.get("value").map(String::as_str) == Some(value) {
            return Ok(false);
        }
        record.insert("value".to_string(), value.to_string());
        self.persist_record(key, &record)?;
        Ok(true)
    }

    pub(crate) fn remove(&self, key: &str) -> Result<bool, String> {
        let mut record = self.load_record(key)?;
        if record.remove("value").is_none() {
            return Ok(false);
        }
        // Keep a tombstone so interrupted migration can never revive a key
        // from the retained legacy snapshot.
        self.persist_record(key, &record)?;
        Ok(true)
    }

    pub(crate) fn compare_and_swap(
        &self,
        key: &str,
        expected: Option<&str>,
        next: Option<&str>,
    ) -> Result<(bool, Option<String>), String> {
        let mut record = self.load_record(key)?;
        let changed = record.get("value").map(String::as_str) != next;
        let outcome = apply_storage_cas(&mut record, "value", expected, next);
        if outcome.0 && changed {
            self.persist_record(key, &record)?;
        }
        Ok(outcome)
    }

    /// Browser fallback migration must never resurrect a deletion made by
    /// another window or sidecar. An existing tombstone blocks this import.
    pub(crate) fn migrate_if_missing(
        &self,
        key: &str,
        next: Option<&str>,
    ) -> Result<(bool, Option<String>), String> {
        if Self::exists(&self.key_path(key)) {
            return Ok((false, self.get(key)?));
        }
        self.compare_and_swap(key, None, next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_fallback_migration_preserves_current_values_and_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(&dir.path().join("runtime-storage.json")).unwrap();
        assert_eq!(
            store.migrate_if_missing("key", Some("browser")).unwrap(),
            (true, None)
        );
        store.set("key", "sidecar").unwrap();
        assert_eq!(
            store
                .migrate_if_missing("key", Some("stale-browser"))
                .unwrap(),
            (false, Some("sidecar".into()))
        );
        store.remove("key").unwrap();
        assert_eq!(
            store
                .migrate_if_missing("key", Some("deleted-plan"))
                .unwrap(),
            (false, None)
        );
        assert_eq!(store.get("key").unwrap(), None);
        // A deliberate user update may recreate a deleted key; only migration
        // is blocked by the tombstone.
        assert_eq!(
            store.compare_and_swap("key", None, Some("new")).unwrap(),
            (true, None)
        );
        assert_eq!(store.get("key").unwrap().as_deref(), Some("new"));
    }

    fn legacy_store(path: &Path, entries: &[(&str, &str)]) {
        write_string_map(
            path,
            &entries
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
        .expect("write legacy store");
    }

    #[test]
    fn migrates_all_values_and_preserves_the_legacy_snapshot_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("settings", "old")]);
        legacy_store(
            &path,
            &[("settings", "new"), ("empty", ""), ("unicode", "中文数据")],
        );
        let original = fs::read(&path).unwrap();
        let original_backup = fs::read(storage_sidecar_path(&path, ".bak")).unwrap();

        let store = RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("settings").unwrap().as_deref(), Some("new"));
        assert_eq!(store.get("empty").unwrap().as_deref(), Some(""));
        assert_eq!(store.get("unicode").unwrap().as_deref(), Some("中文数据"));
        assert_eq!(store.get("missing").unwrap(), None);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            fs::read(storage_sidecar_path(&path, ".bak")).unwrap(),
            original_backup
        );
    }

    #[test]
    fn startup_reads_legacy_preferences_without_migrating_then_uses_the_current_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("settings", "old")]);
        assert_eq!(
            RuntimeStore::read_existing_value(&path, "settings")
                .unwrap()
                .as_deref(),
            Some("old")
        );
        assert!(!RuntimeStore::at(&path).directory.exists());

        RuntimeStore::open(&path)
            .unwrap()
            .set("settings", "new")
            .unwrap();
        assert_eq!(
            RuntimeStore::read_existing_value(&path, "settings")
                .unwrap()
                .as_deref(),
            Some("new")
        );
    }

    #[test]
    fn frequent_writes_leave_unrelated_values_and_their_backup_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let large = "x".repeat(512 * 1024);
        legacy_store(&path, &[("templates", &large), ("runLogs", "[]")]);
        let original = fs::read(&path).unwrap();
        let store = RuntimeStore::open(&path).unwrap();
        store.set("templates", "changed template").unwrap();
        let unrelated = store.key_path("templates");
        let main = fs::read(&unrelated).unwrap();
        let backup = fs::read(storage_sidecar_path(&unrelated, ".bak")).unwrap();

        for index in 0..20 {
            store.set("runLogs", &format!("[{index}]")).unwrap();
        }

        assert_eq!(fs::read(&unrelated).unwrap(), main);
        assert_eq!(
            fs::read(storage_sidecar_path(&unrelated, ".bak")).unwrap(),
            backup
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(store.get("runLogs").unwrap().as_deref(), Some("[19]"));
    }

    #[test]
    fn unchanged_values_and_conflicting_cas_do_not_rotate_backups() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(&dir.path().join("runtime-storage.json")).unwrap();
        store.set("key", "v1").unwrap();
        store.set("key", "v2").unwrap();
        let backup_path = storage_sidecar_path(&store.key_path("key"), ".bak");
        let backup = fs::read(&backup_path).unwrap();

        assert!(!store.set("key", "v2").unwrap());
        assert_eq!(
            store
                .compare_and_swap("key", Some("stale"), Some("v3"))
                .unwrap(),
            (false, Some("v2".to_string()))
        );
        assert_eq!(
            store
                .compare_and_swap("key", Some("v2"), Some("v2"))
                .unwrap(),
            (true, None)
        );
        assert!(!store.remove("missing").unwrap());
        assert_eq!(
            store.compare_and_swap("missing", None, None).unwrap(),
            (true, None)
        );
        assert!(!store.key_path("missing").exists());
        assert_eq!(fs::read(backup_path).unwrap(), backup);
        assert_eq!(store.get("key").unwrap().as_deref(), Some("v2"));
    }

    #[test]
    fn removed_values_stay_removed_after_restart_and_repeated_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("token", "old token")]);
        let store = RuntimeStore::open(&path).unwrap();
        assert!(store.remove("token").unwrap());
        assert_eq!(
            RuntimeStore::open(&path).unwrap().get("token").unwrap(),
            None
        );
        // Simulate losing only the initialization marker after a crash. A
        // tombstone must still win over the retained legacy value.
        fs::remove_file(store.manifest_path()).unwrap();
        fs::remove_file(storage_sidecar_path(&store.manifest_path(), ".bak")).unwrap();
        let reopened = RuntimeStore::open(&path).unwrap();
        assert_eq!(reopened.get("token").unwrap(), None);
        assert_eq!(
            RuntimeStore::read_existing_value(&path, "token").unwrap(),
            None
        );
    }

    #[test]
    fn interrupted_migration_keeps_newer_records_and_imports_the_remaining_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("first", "old"), ("second", "legacy")]);
        let partial = RuntimeStore::at(&path);
        fs::create_dir_all(&partial.directory).unwrap();
        partial.set("first", "new").unwrap();

        let store = RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("first").unwrap().as_deref(), Some("new"));
        assert_eq!(store.get("second").unwrap().as_deref(), Some("legacy"));
        assert!(store.initialized().unwrap());
    }

    #[test]
    fn failed_migration_never_publishes_the_manifest_and_can_resume() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("first", "one"), ("blocked", "two")]);
        let original = fs::read(&path).unwrap();
        let partial = RuntimeStore::at(&path);
        fs::create_dir_all(&partial.directory).unwrap();
        let blocked_path = partial.key_path("blocked");
        fs::create_dir(&blocked_path).unwrap();

        assert!(RuntimeStore::open(&path).is_err());
        assert!(!RuntimeStore::exists(&partial.manifest_path()));
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir(blocked_path).unwrap();
        let store = RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("first").unwrap().as_deref(), Some("one"));
        assert_eq!(store.get("blocked").unwrap().as_deref(), Some("two"));
    }

    #[test]
    fn migrates_the_legacy_backup_when_the_primary_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("key", "backup value")]);
        legacy_store(&path, &[("key", "newer value")]);
        fs::write(&path, "broken JSON").unwrap();

        let store = RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("key").unwrap().as_deref(), Some("backup value"));
        assert_eq!(fs::read_to_string(path).unwrap(), "broken JSON");
    }

    #[test]
    fn corrupt_legacy_data_without_a_backup_is_not_marked_as_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        fs::write(&path, "broken JSON").unwrap();
        assert!(RuntimeStore::open(&path).is_err());
        assert!(!RuntimeStore::at(&path).manifest_path().exists());
    }

    #[test]
    fn unrecognized_store_versions_never_fall_back_to_stale_legacy_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("key", "legacy")]);
        let store = RuntimeStore::open(&path).unwrap();
        fs::write(store.manifest_path(), r#"{"version":"999"}"#).unwrap();
        assert!(RuntimeStore::open(&path).is_err());
        assert!(RuntimeStore::read_existing_value(&path, "key").is_err());
    }

    #[test]
    fn a_corrupt_manifest_recovers_without_reimporting_legacy_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        legacy_store(&path, &[("key", "legacy")]);
        let store = RuntimeStore::open(&path).unwrap();
        store.set("key", "current").unwrap();
        fs::write(store.manifest_path(), "broken JSON").unwrap();
        assert_eq!(
            RuntimeStore::open(&path)
                .unwrap()
                .get("key")
                .unwrap()
                .as_deref(),
            Some("current")
        );
    }

    #[test]
    fn arbitrary_and_long_keys_roundtrip_without_becoming_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let store = RuntimeStore::open(&path).unwrap();
        for key in [
            "../outside",
            "C:\\outside:stream",
            "KEY",
            "key",
            "",
            &"账号/".repeat(300),
        ] {
            store.set(key, key).unwrap();
            assert_eq!(
                store.key_path(key).parent(),
                Some(store.directory.as_path())
            );
        }
        let reopened = RuntimeStore::open(&path).unwrap();
        assert_eq!(reopened.get("KEY").unwrap().as_deref(), Some("KEY"));
        assert_eq!(reopened.get("key").unwrap().as_deref(), Some("key"));
        assert_eq!(
            reopened.get("../outside").unwrap().as_deref(),
            Some("../outside")
        );
        assert_eq!(
            reopened.get(&"账号/".repeat(300)).unwrap().as_deref(),
            Some("账号/".repeat(300).as_str())
        );
        assert!(!dir.path().join("outside").exists());
    }

    #[test]
    fn a_record_for_another_key_is_rejected_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(&dir.path().join("runtime-storage.json")).unwrap();
        store.set("key", "value").unwrap();
        let path = store.key_path("key");
        fs::write(&path, r#"{"key":"other","value":"wrong entry"}"#).unwrap();
        assert!(store.get("key").is_err());
        assert!(store.set("key", "replacement").is_err());
        assert!(store.remove("key").is_err());
        assert!(store
            .compare_and_swap("key", None, Some("replacement"))
            .is_err());
        assert!(fs::read_to_string(path).unwrap().contains("wrong entry"));
    }

    #[test]
    fn per_key_reads_recover_from_corrupt_and_missing_primaries() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(&dir.path().join("runtime-storage.json")).unwrap();
        for key in ["corrupt", "missing"] {
            store.set(key, "backup").unwrap();
            store.set(key, "newer").unwrap();
        }
        fs::write(store.key_path("corrupt"), "broken JSON").unwrap();
        fs::remove_file(store.key_path("missing")).unwrap();
        assert_eq!(store.get("corrupt").unwrap().as_deref(), Some("backup"));
        assert_eq!(store.get("missing").unwrap().as_deref(), Some("backup"));
    }

    #[test]
    fn a_failed_cas_write_preserves_the_previous_value_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(&dir.path().join("runtime-storage.json")).unwrap();
        store.set("key", "v1").unwrap();
        let blocked_tmp = storage_sidecar_path(&store.key_path("key"), ".tmp");
        fs::create_dir(&blocked_tmp).unwrap();
        assert!(store
            .compare_and_swap("key", Some("v1"), Some("v2"))
            .is_err());
        assert_eq!(store.get("key").unwrap().as_deref(), Some("v1"));
        fs::remove_dir(blocked_tmp).unwrap();
        assert_eq!(
            store
                .compare_and_swap("key", Some("v1"), Some("v2"))
                .unwrap(),
            (true, None)
        );
        assert_eq!(store.get("key").unwrap().as_deref(), Some("v2"));
        assert_eq!(
            store.compare_and_swap("key", Some("v2"), None).unwrap(),
            (true, None)
        );
        assert_eq!(store.get("key").unwrap(), None);
        assert_eq!(
            store.compare_and_swap("key", None, Some("v3")).unwrap(),
            (true, None)
        );
        assert_eq!(store.get("key").unwrap().as_deref(), Some("v3"));
    }

    #[test]
    fn concurrent_cas_under_the_native_lock_has_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        RuntimeStore::open(&path)
            .unwrap()
            .set("key", "initial")
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|index| {
                    let barrier = std::sync::Arc::clone(&barrier);
                    let path = &path;
                    scope.spawn(move || {
                        barrier.wait();
                        let _guard = crate::lock_runtime_storage();
                        let store = RuntimeStore::open(path).unwrap();
                        let value = format!("window-{index}");
                        (
                            value.clone(),
                            store
                                .compare_and_swap("key", Some("initial"), Some(&value))
                                .unwrap(),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let winners: Vec<_> = results.iter().filter(|(_, outcome)| outcome.0).collect();
        assert_eq!(winners.len(), 1);
        let winner = &winners[0].0;
        assert_eq!(
            RuntimeStore::open(&path)
                .unwrap()
                .get("key")
                .unwrap()
                .as_ref(),
            Some(winner)
        );
        for (_, outcome) in results.iter().filter(|(_, outcome)| !outcome.0) {
            assert_eq!(outcome.1.as_ref(), Some(winner));
        }
    }
}
