import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RotateCcw, Save, Settings2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button, Input, Panel } from "../components/ui";
import { setApiBaseUrl } from "../lib/api";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  getRuntimeSettings,
  normalizeAppSettings,
  setRuntimeSettings,
  stringifyAppSettings,
  type AppSettings,
} from "../lib/app-settings";
import { deriveWebsshUrl } from "../lib/webssh";
import { browserRuntime } from "../lib/runtime";
import { useToast } from "../lib/use-toast";

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validate(settings: AppSettings) {
  if (!isHttpUrl(settings.apiBaseUrl)) return "API Base URL 需要是 http 或 https 开头的完整地址";
  if (!isHttpUrl(settings.monitorDashboardUrl)) return "监控面板 URL 需要是 http 或 https 开头的完整地址";
  return null;
}

function applySettings(settings: AppSettings) {
  setRuntimeSettings(settings);
  setApiBaseUrl(settings.apiBaseUrl);
}

export function SettingsPage({ standalone = false }: { standalone?: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AppSettings>(() => getRuntimeSettings());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const normalized = useMemo(() => normalizeAppSettings(form), [form]);
  const derivedWebsshUrl = useMemo(() => {
    if (!isHttpUrl(normalized.apiBaseUrl)) return "API Base URL 有效后自动生成";
    try {
      return deriveWebsshUrl("{id}", 120, 32, normalized.apiBaseUrl);
    } catch {
      return "API Base URL 有效后自动生成";
    }
  }, [normalized.apiBaseUrl]);

  async function saveSettings(nextSettings: AppSettings, successTitle: string) {
    const nextError = validate(nextSettings);
    setError(nextError);
    if (nextError) return;

    setSaving(true);
    try {
      applySettings(nextSettings);
      await browserRuntime.storage.set(APP_SETTINGS_STORAGE_KEY, stringifyAppSettings(nextSettings));
      queryClient.clear();
      setForm(nextSettings);
      toast.success(successTitle, "后续请求会使用新的运行时配置");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void saveSettings(normalized, "设置已保存");
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
        toast.success("设置已恢复默认", "当前使用环境变量或内置默认地址");
      } catch (resetError) {
        setError(resetError instanceof Error ? resetError.message : "恢复默认失败");
      } finally {
        setSaving(false);
      }
    })();
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
              <h2 className="text-sm font-semibold">运行时地址</h2>
              <p className="mt-1 text-xs text-app-muted">保存在本机，优先级高于 .env 默认值。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={saving} type="button" variant="secondary" onClick={resetToDefault}>
              <RotateCcw className="h-4 w-4" />
              恢复默认
            </Button>
            <Button disabled={saving} type="submit">
              <Save className="h-4 w-4" />
              {saving ? "保存中" : "保存设置"}
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
              <span className="mt-1 block text-xs leading-5 text-app-muted">示例：http://116.172.93.164:28080/api</span>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-app-text">监控面板 URL</span>
              <Input
                className="w-full font-mono"
                inputMode="url"
                onChange={(event) => setForm((value) => ({ ...value, monitorDashboardUrl: event.target.value }))}
                placeholder={DEFAULT_APP_SETTINGS.monitorDashboardUrl}
                spellCheck={false}
                value={form.monitorDashboardUrl}
              />
              <span className="mt-1 block text-xs leading-5 text-app-muted">打开任务监控时会追加 var-pod 参数。</span>
            </label>

            {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{error}</div> : null}
          </div>

          <div className="rounded-lg border border-app-border bg-app-panel p-3">
            <div className="text-xs font-medium text-app-muted">当前派生地址</div>
            <div className="mt-3 space-y-3 text-xs">
              <div>
                <div className="mb-1 text-app-muted">WebSSH</div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-app-surface px-2.5 py-2 font-mono text-app-text">
                  {derivedWebsshUrl}
                </code>
              </div>
              <div>
                <div className="mb-1 text-app-muted">生效范围</div>
                <p className="leading-5 text-app-muted">
                  保存后，任务、镜像、存储、登录校验、监控链接和 WebSSH 地址会使用这组配置。已保存账号只保存 token，不保存密码。
                </p>
              </div>
            </div>
          </div>
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
          返回登录
        </Link>
        {content}
      </div>
    </main>
  );
}
