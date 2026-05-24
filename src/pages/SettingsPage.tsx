import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellRing, Download, RotateCcw, Save, Settings2, Upload } from "lucide-react";
import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button, Dialog, Input, Panel, Select } from "../components/ui";
import { setApiBaseUrl } from "../lib/api";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  getRuntimeSettings,
  type ImportantNotificationEvent,
  normalizeAppSettings,
  type NotificationMode,
  setRuntimeSettings,
  stringifyAppSettings,
  type AppSettings,
} from "../lib/app-settings";
import { deriveWebsshUrl } from "../lib/webssh";
import { saveBlob } from "../lib/download";
import {
  exportLocalDataBackup,
  importLocalDataBackup,
  nonSecretBackupSections,
  parseLocalDataBackup,
  secretBackupSections,
  summarizeBackup,
  type LocalDataBackup,
  type LocalDataBackupSection,
} from "../lib/local-data-backup";
import { browserRuntime } from "../lib/runtime";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validate(settings: AppSettings, t: (key: TranslationKey) => string) {
  if (!isHttpUrl(settings.apiBaseUrl)) return t("settings.apiBaseInvalid");
  if (!isHttpUrl(settings.monitorDashboardUrl)) return t("settings.monitorUrlInvalid");
  return null;
}

function applySettings(settings: AppSettings) {
  setRuntimeSettings(settings);
  setApiBaseUrl(settings.apiBaseUrl);
  void browserRuntime.setDesktopCloseToTray(settings.desktopCloseToTray);
}

const notificationEvents: Array<{ event: ImportantNotificationEvent; zh: string; en: string; descriptionZh: string; descriptionEn: string }> = [
  {
    event: "task.success",
    zh: "实例运行成功",
    en: "Instance succeeded",
    descriptionZh: "实例状态进入成功时触发。",
    descriptionEn: "Triggered when an instance enters the succeeded state.",
  },
  {
    event: "task.failure",
    zh: "实例运行失败",
    en: "Instance failed",
    descriptionZh: "实例状态进入失败时触发。",
    descriptionEn: "Triggered when an instance enters the failed state.",
  },
  {
    event: "task.abnormal",
    zh: "实例运行异常",
    en: "Instance abnormal",
    descriptionZh: "实例状态进入异常时触发。",
    descriptionEn: "Triggered when an instance enters the abnormal state.",
  },
];

const notificationModeOptions: Array<{ mode: NotificationMode; zh: string; en: string }> = [
  { mode: "off", zh: "不通知", en: "Off" },
  { mode: "app", zh: "应用内通知", en: "In-app" },
  { mode: "system", zh: "系统通知", en: "System" },
];

export function SettingsPage({ standalone = false }: { standalone?: boolean }) {
  const toast = useToast();
  const { t, text } = useI18n();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AppSettings>(() => getRuntimeSettings());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [importBackup, setImportBackup] = useState<LocalDataBackup | null>(null);
  const [importSections, setImportSections] = useState<LocalDataBackupSection[]>(nonSecretBackupSections);
  const [importSecrets, setImportSecrets] = useState(false);

  const normalized = useMemo(() => normalizeAppSettings(form), [form]);
  const derivedWebsshUrl = useMemo(() => {
    if (!isHttpUrl(normalized.apiBaseUrl)) return t("settings.websshPending");
    try {
      return deriveWebsshUrl("{id}", 120, 32, normalized.apiBaseUrl);
    } catch {
      return t("settings.websshPending");
    }
  }, [normalized.apiBaseUrl, t]);

  async function saveSettings(nextSettings: AppSettings, successTitle: string) {
    const nextError = validate(nextSettings, t);
    setError(nextError);
    if (nextError) return;

    setSaving(true);
    try {
      applySettings(nextSettings);
      await browserRuntime.storage.set(APP_SETTINGS_STORAGE_KEY, stringifyAppSettings(nextSettings));
      queryClient.clear();
      setForm(nextSettings);
      toast.success(successTitle, t("settings.saveDescription"));
      void runLogger.log({
        source: "settings",
        level: "info",
        action: "settings.save",
        result: "success",
        title: successTitle,
        metadata: nextSettings,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.saveFailed"));
      void runLogger.log({
        source: "settings",
        level: "error",
        action: "settings.save",
        result: "failure",
        title: t("settings.saveFailed"),
        error: errorMessage(saveError, t("settings.saveFailed")),
      });
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void saveSettings(normalized, t("settings.saved"));
  }

  function resetToDefault() {
    void (async () => {
      setSaving(true);
      try {
        applySettings(DEFAULT_APP_SETTINGS);
        await browserRuntime.storage.remove(APP_SETTINGS_STORAGE_KEY);
        queryClient.clear();
        setForm(DEFAULT_APP_SETTINGS);
        setError(null);
        toast.success(t("settings.resetDone"), t("settings.resetDescription"));
        void runLogger.log({
          source: "settings",
          level: "info",
          action: "settings.reset",
          result: "success",
          title: t("settings.resetDone"),
        });
      } catch (resetError) {
        setError(resetError instanceof Error ? resetError.message : t("settings.resetFailed"));
        void runLogger.log({
          source: "settings",
          level: "error",
          action: "settings.reset",
          result: "failure",
          title: t("settings.resetFailed"),
          error: errorMessage(resetError, t("settings.resetFailed")),
        });
      } finally {
        setSaving(false);
      }
    })();
  }

  function sendTestNotification() {
    void browserRuntime
      .notifySystem({
        title: text("EasyConsole 测试通知", "EasyConsole test notification"),
        body: text("系统通知通道已连接。", "The system notification channel is connected."),
      })
      .then((result) => {
        if (result === "shown") {
          toast.success(text("测试通知已发送", "Test notification sent"));
        } else if (result === "permission-denied") {
          toast.error(text("系统通知未开启", "System notifications are off"), text("请在系统或浏览器权限中允许 EasyConsole 发送通知。", "Allow EasyConsole to send notifications in system or browser permissions."));
        } else {
          toast.error(text("系统通知不可用", "System notifications are unavailable"), text("当前运行环境没有可用的系统通知能力。", "The current runtime does not expose system notifications."));
        }
      });
  }

  function updateNotificationPreference(event: ImportantNotificationEvent, mode: NotificationMode) {
    setForm((value) => ({
      ...value,
      notificationPreferences: {
        ...value.notificationPreferences,
        [event]: mode,
      },
    }));
  }

  async function testConnection() {
    const nextError = validate(normalized, t);
    setError(nextError);
    if (nextError) return;
    try {
      const response = await browserRuntime.request({
        method: "GET",
        url: `${normalized.apiBaseUrl.replace(/\/+$/, "")}/token`,
        responseType: "text",
        timeoutMs: 10_000,
      });
      if (response.status < 200 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      toast.success(text("连接测试通过", "Connection test passed"), normalized.apiBaseUrl);
    } catch (testError) {
      toast.error(text("连接测试失败", "Connection test failed"), testError instanceof Error ? testError.message : text("请检查地址和网络", "Check the URL and network"));
    }
  }

  async function exportBackup() {
    if (includeSecrets && !window.confirm(text("导出文件将包含登录 token 和已保存账号。确认继续？", "The export will include login tokens and saved accounts. Continue?"))) {
      return;
    }
    const backup = await exportLocalDataBackup(browserRuntime.storage, includeSecrets);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    saveBlob(blob, `easy-console-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast.success(text("备份文件已导出", "Backup exported"));
  }

  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const backup = parseLocalDataBackup(await file.text());
      setImportBackup(backup);
      setImportSecrets(false);
      setImportSections(nonSecretBackupSections.filter((section) => backup.items[section] !== undefined));
    } catch (importError) {
      toast.error(text("备份文件无法识别", "Backup file is not recognized"), importError instanceof Error ? importError.message : text("请选择 EasyConsole 备份 JSON", "Choose an EasyConsole backup JSON file"));
    }
  }

  function toggleImportSection(section: LocalDataBackupSection, checked: boolean) {
    setImportSections((current) => checked ? [...new Set([...current, section])] : current.filter((item) => item !== section));
  }

  async function applyImportBackup() {
    if (!importBackup) return;
    const sections = [...importSections, ...(importSecrets ? secretBackupSections.filter((section) => importBackup.items[section] !== undefined) : [])];
    if (sections.some((section) => secretBackupSections.includes(section)) && !window.confirm(text("将导入登录凭据并覆盖本地账号数据。确认继续？", "This will import credentials and overwrite local account data. Continue?"))) {
      return;
    }
    await importLocalDataBackup(browserRuntime.storage, importBackup, sections);
    const nextSettings = normalizeAppSettings(importBackup.items.settings as Partial<AppSettings>);
    if (sections.includes("settings")) applySettings(nextSettings);
    queryClient.clear();
    toast.success(text("本地数据已导入", "Local data imported"), text("部分设置需要刷新后完全生效", "Some settings need a refresh to fully apply"));
    setImportBackup(null);
  }

  const content = (
    <form className="space-y-5" onSubmit={onSubmit}>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md border border-app-border bg-app-panel text-app-accent">
              <Settings2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("settings.runtimeTitle")}</h2>
              <p className="mt-1 text-xs text-app-muted">{t("settings.runtimeDescription")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={saving} type="button" variant="secondary" onClick={resetToDefault}>
              <RotateCcw className="h-4 w-4" />
              {t("settings.resetDefault")}
            </Button>
            <Button disabled={saving} type="button" variant="secondary" onClick={() => void testConnection()}>
              {text("测试连接", "Test")}
            </Button>
            <Button disabled={saving} type="submit">
              <Save className="h-4 w-4" />
              {saving ? t("settings.saving") : t("settings.saveSettings")}
            </Button>
          </div>
        </div>

        <div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-app-text">API Base URL</span>
              <Input
                className="w-full font-mono"
                inputMode="url"
                onChange={(event) => setForm((value) => ({ ...value, apiBaseUrl: event.target.value }))}
                placeholder={DEFAULT_APP_SETTINGS.apiBaseUrl}
                spellCheck={false}
                value={form.apiBaseUrl}
              />
              <span className="mt-1 block text-xs leading-5 text-app-muted">{t("settings.apiExample")}</span>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-app-text">{t("settings.monitorDashboardUrl")}</span>
              <Input
                className="w-full font-mono"
                inputMode="url"
                onChange={(event) => setForm((value) => ({ ...value, monitorDashboardUrl: event.target.value }))}
                placeholder={DEFAULT_APP_SETTINGS.monitorDashboardUrl}
                spellCheck={false}
                value={form.monitorDashboardUrl}
              />
              <span className="mt-1 block text-xs leading-5 text-app-muted">{t("settings.monitorHelp")}</span>
            </label>

            {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{error}</div> : null}
            {browserRuntime.isDesktop ? (
              <label className="flex items-start gap-3 rounded-md border border-app-border bg-app-panel px-3 py-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={form.desktopCloseToTray}
                  onChange={(event) => setForm((value) => ({ ...value, desktopCloseToTray: event.target.checked }))}
                />
                <span>
                  <span className="block font-medium text-app-text">{text("关闭窗口时驻留后台", "Keep running after window close")}</span>
                  <span className="mt-1 block text-xs leading-5 text-app-muted">
                    {text("开启后关闭主窗口会隐藏到托盘，计划任务仍会在后台检查；从托盘菜单退出才会结束应用。", "When enabled, closing the main window hides it to the tray and scheduled tasks keep running. Use the tray menu to quit.")}
                  </span>
                </span>
              </label>
            ) : null}
          </div>

          <div className="rounded-lg border border-app-border bg-app-panel p-3">
            <div className="text-xs font-medium text-app-muted">{t("settings.derivedTitle")}</div>
            <div className="mt-3 space-y-3 text-xs">
              <div>
                <div className="mb-1 text-app-muted">WebSSH</div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-app-surface px-2.5 py-2 font-mono text-app-text">
                  {derivedWebsshUrl}
                </code>
              </div>
              <div>
                <div className="mb-1 text-app-muted">{t("settings.scope")}</div>
                <p className="leading-5 text-app-muted">
                  {t("settings.scopeDescription")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{text("本地数据备份", "Local Data Backup")}</h2>
            <p className="mt-1 text-xs text-app-muted">
              {text("导出或恢复设置、任务模板、计划任务和运行日志。登录凭据默认不会包含。", "Export or restore settings, task templates, scheduled tasks, and run logs. Credentials are excluded by default.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-app-muted">
              <input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} />
              {text("包含登录凭据", "Include credentials")}
            </label>
            <Button type="button" variant="secondary" onClick={() => void exportBackup()}>
              <Download className="h-4 w-4" />
              {text("导出", "Export")}
            </Button>
            <label className="app-interactive inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-app-border bg-app-surface px-3 text-sm font-medium text-app-text hover:bg-app-panel [@media(pointer:coarse)]:min-h-11">
              <Upload className="h-4 w-4" />
              {text("导入", "Import")}
              <input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void readImportFile(event)} />
            </label>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{text("重要事件通知", "Important Event Notifications")}</h2>
            <p className="mt-1 text-xs text-app-muted">
              {text("为每类事件选择关闭、应用内通知或系统通知。", "Choose off, in-app, or system notifications for each event.")}
            </p>
          </div>
          <Button disabled={saving} type="button" variant="secondary" onClick={sendTestNotification}>
            <BellRing className="h-4 w-4" />
            {text("测试通知", "Test notification")}
          </Button>
        </div>
        <div className="divide-y divide-app-border">
          {notificationEvents.map((item) => (
            <div key={item.event} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
              <div className="min-w-0">
                <div className="text-sm font-medium text-app-text">{text(item.zh, item.en)}</div>
                <div className="mt-1 text-xs leading-5 text-app-muted">{text(item.descriptionZh, item.descriptionEn)}</div>
              </div>
              <Select
                value={form.notificationPreferences[item.event]}
                onChange={(event) => updateNotificationPreference(item.event, event.target.value as NotificationMode)}
              >
                {notificationModeOptions.map((option) => (
                  <option key={option.mode} value={option.mode}>
                    {text(option.zh, option.en)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </Panel>

      <Dialog open={Boolean(importBackup)} title={text("导入本地数据", "Import Local Data")} onClose={() => setImportBackup(null)} width="max-w-xl">
        <div className="space-y-4 p-4 text-sm">
          {importBackup ? (
            <>
              <div className="rounded-md border border-app-border bg-app-panel p-3 text-xs leading-5 text-app-muted">
                {(() => {
                  const summary = summarizeBackup(importBackup);
                  return text(
                    `模板 ${summary.taskTemplates}，计划任务 ${summary.scheduledTasks}，运行日志 ${summary.runLogs}，账号 ${summary.savedAccounts}`,
                    `Templates ${summary.taskTemplates}, scheduled tasks ${summary.scheduledTasks}, run logs ${summary.runLogs}, accounts ${summary.savedAccounts}`,
                  );
                })()}
              </div>
              <div className="grid gap-2">
                {nonSecretBackupSections.map((section) => (
                  <label key={section} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={importSections.includes(section)}
                      disabled={importBackup.items[section] === undefined}
                      onChange={(event) => toggleImportSection(section, event.target.checked)}
                    />
                    <span>{section}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-app-danger">
                  <input
                    type="checkbox"
                    checked={importSecrets}
                    disabled={!secretBackupSections.some((section) => importBackup.items[section] !== undefined)}
                    onChange={(event) => setImportSecrets(event.target.checked)}
                  />
                  <span>{text("导入登录凭据", "Import credentials")}</span>
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setImportBackup(null)}>
                  {text("取消", "Cancel")}
                </Button>
                <Button type="button" onClick={() => void applyImportBackup()}>
                  {text("导入", "Import")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Dialog>
    </form>
  );

  if (!standalone) return content;

  return (
    <main className="min-h-screen bg-app-bg px-3 py-4 text-app-text sm:p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <Link className="app-interactive inline-flex h-9 items-center gap-2 rounded-md px-2 text-sm text-app-muted hover:bg-app-panel hover:text-app-text" to="/login">
          <ArrowLeft className="h-4 w-4" />
          {t("settings.backToLogin")}
        </Link>
        {content}
      </div>
    </main>
  );
}
