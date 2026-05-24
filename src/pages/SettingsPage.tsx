import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellRing, RotateCcw, Save, Settings2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button, Input, Panel, Select } from "../components/ui";
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
