import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  BellRing,
  DatabaseBackup,
  Download,
  ExternalLink,
  Globe,
  History,
  KeyRound,
  Network,
  Palette,
  PanelTopClose,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Button, Dialog, Input, Panel, Select } from "../components/ui";
import { setApiBaseUrl } from "../lib/api";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CUSTOM_COLORS,
  DEFAULT_SSH_SETTINGS,
  getRuntimeSettings,
  type ImportantNotificationEvent,
  normalizeAppSettings,
  type NotificationMode,
  setRuntimeSettings,
  SSH_FONT_PRESETS,
  stringifyAppSettings,
  type AppSettings,
  type SshAuthMode,
  type SshCustomColors,
  type SshTerminalTheme,
} from "../lib/app-settings";
import { APP_UPDATE_ENDPOINT_URL, GITHUB_API_RELEASE_URL } from "../lib/app-update";
import { useAppUpdate } from "../lib/app-update-context";
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
import { decryptBackup, encryptBackup, isEncryptedBackup, type EncryptedBackup } from "../lib/backup-crypto";
import { browserRuntime } from "../lib/runtime";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";
import { useConfirmAction } from "../lib/use-confirm-action";
import type { KnownHostEntry, PortForwardRule, PortForwardType, SshHistoryEntry } from "../lib/types";

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
  void browserRuntime.setDesktopClosePrompt(settings.desktopClosePrompt);
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

const sshTermTypeOptions = ["xterm-256color", "xterm", "vt100", "linux"];

const sshAuthModeOptions: Array<{ mode: SshAuthMode; zh: string; en: string }> = [
  { mode: "password", zh: "密码认证", en: "Password" },
  { mode: "key", zh: "密钥认证", en: "SSH key" },
];

const sshThemeOptions: Array<{ theme: SshTerminalTheme; zh: string; en: string }> = [
  { theme: "dark", zh: "深色", en: "Dark" },
  { theme: "light", zh: "浅色", en: "Light" },
  { theme: "hacker", zh: "黑客", en: "Hacker" },
  { theme: "custom", zh: "自定义", en: "Custom" },
];

type LucideIcon = typeof Settings2;

function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-app-border bg-app-panel text-app-accent">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-app-text">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-app-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function SubSectionHeading({ icon: Icon, label, trailing }: { icon: LucideIcon; label: string; trailing?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-app-muted">
        <Icon className="h-3.5 w-3.5 text-app-accent" />
        <span>{label}</span>
      </div>
      {trailing}
    </div>
  );
}

export function SettingsPage({ standalone = false }: { standalone?: boolean }) {
  const toast = useToast();
  const { t, text } = useI18n();
  const appUpdate = useAppUpdate();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirmAction();
  const [form, setForm] = useState<AppSettings>(() => getRuntimeSettings());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [importBackup, setImportBackup] = useState<LocalDataBackup | null>(null);
  const [importEncrypted, setImportEncrypted] = useState<EncryptedBackup | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [importDecryptError, setImportDecryptError] = useState<string | null>(null);
  const [importSections, setImportSections] = useState<LocalDataBackupSection[]>(nonSecretBackupSections);
  const [importSecrets, setImportSecrets] = useState(false);
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>([]);
  const [knownHostsLoading, setKnownHostsLoading] = useState(false);
  const [sshHistory, setSshHistory] = useState<SshHistoryEntry[]>([]);
  const [sshHistoryLoading, setSshHistoryLoading] = useState(false);
  const [showPortForwardForm, setShowPortForwardForm] = useState(false);
  const [pfType, setPfType] = useState<PortForwardType>("local");
  const [pfLocalHost, setPfLocalHost] = useState("127.0.0.1");
  const [pfLocalPort, setPfLocalPort] = useState("");
  const [pfRemoteHost, setPfRemoteHost] = useState("");
  const [pfRemotePort, setPfRemotePort] = useState("");
  const [pfEnabled, setPfEnabled] = useState(true);

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

  const loadKnownHosts = useCallback(async () => {
    if (!browserRuntime.supportsInAppSsh) return;
    setKnownHostsLoading(true);
    try {
      const hosts = await browserRuntime.listKnownHosts();
      setKnownHosts(hosts);
    } catch {
      toast.error(t("settings.sshLoadFailed"));
    } finally {
      setKnownHostsLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void loadKnownHosts();
  }, [loadKnownHosts]);

  function removeKnownHost(hostPort: string) {
    void (async () => {
      try {
        await browserRuntime.removeKnownHost(hostPort);
        setKnownHosts((hosts) => hosts.filter((host) => host.hostPort !== hostPort));
        toast.success(t("settings.sshRemoved"));
      } catch {
        toast.error(t("settings.sshRemoveFailed"));
      }
    })();
  }

  function clearAllKnownHosts() {
    confirm({
      title: t("settings.sshClearAllHosts"),
      description: t("settings.sshClearAllConfirm"),
      confirmLabel: t("settings.sshClearAllHosts"),
      tone: "danger",
      run: () => {
        void (async () => {
          try {
            await browserRuntime.clearKnownHosts();
            setKnownHosts([]);
            toast.success(t("settings.sshCleared"));
          } catch {
            toast.error(t("settings.sshClearFailed"));
          }
        })();
      },
    });
  }

  const loadSshHistory = useCallback(async () => {
    setSshHistoryLoading(true);
    try {
      const history = await browserRuntime.listSshHistory();
      setSshHistory(history);
    } catch {
      // ignore history load errors
    } finally {
      setSshHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSshHistory();
  }, [loadSshHistory]);

  function clearAllSshHistory() {
    confirm({
      title: t("settings.sshClearHistory"),
      description: t("settings.sshClearHistoryConfirm"),
      confirmLabel: t("settings.sshClearHistory"),
      tone: "danger",
      run: () => {
        void (async () => {
          try {
            await browserRuntime.clearSshHistory();
            setSshHistory([]);
            toast.success(t("settings.sshHistoryCleared"));
          } catch {
            toast.error(t("settings.sshClearFailed"));
          }
        })();
      },
    });
  }

  async function chooseKeyFile() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "SSH Keys", extensions: ["pem", "key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "ppk"] }],
      });
      if (typeof selected === "string") {
        setForm((value) => ({ ...value, ssh: { ...value.ssh, sshKeyPath: selected } }));
      }
    } catch {
      // Dialog not available or cancelled
    }
  }

  function updateSshField<K extends keyof typeof DEFAULT_SSH_SETTINGS>(key: K, value: typeof DEFAULT_SSH_SETTINGS[K]) {
    setForm((form) => ({ ...form, ssh: { ...form.ssh, [key]: value } }));
  }

  function updateSshTerminalField<K extends keyof typeof DEFAULT_SSH_SETTINGS.terminal>(key: K, value: typeof DEFAULT_SSH_SETTINGS.terminal[K]) {
    setForm((form) => ({ ...form, ssh: { ...form.ssh, terminal: { ...form.ssh.terminal, [key]: value } } }));
  }

  function syncFontPreset(presetId: string) {
    const preset = SSH_FONT_PRESETS.find((p) => p.id === presetId);
    if (preset && preset.id !== "custom") {
      setForm((form) => ({
        ...form,
        ssh: { ...form.ssh, terminal: { ...form.ssh.terminal, fontPreset: presetId, fontFamily: preset.value } },
      }));
    } else {
      setForm((form) => ({
        ...form,
        ssh: { ...form.ssh, terminal: { ...form.ssh.terminal, fontPreset: "custom" } },
      }));
    }
  }

  function updateCustomColor(field: keyof SshCustomColors, value: string) {
    setForm((form) => ({
      ...form,
      ssh: { ...form.ssh, terminal: { ...form.ssh.terminal, customColors: { ...form.ssh.terminal.customColors, [field]: value } } },
    }));
  }

  function renderColorField(field: keyof SshCustomColors, value: string) {
    const pickerValue = value.length >= 7 ? value.slice(0, 7) : "#000000";
    return (
      <div key={field} className="flex items-center gap-2">
        <input
          type="color"
          value={pickerValue}
          onChange={(e) => updateCustomColor(field, e.target.value)}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border border-app-border bg-transparent"
          aria-label={field}
        />
        <Input
          className="h-8 flex-1 font-mono text-xs"
          value={value}
          onChange={(e) => updateCustomColor(field, e.target.value)}
          placeholder="#rrggbb"
        />
      </div>
    );
  }

  function addPortForward() {
    const localPort = Number(pfLocalPort);
    const remotePort = Number(pfRemotePort);
    if (!localPort || localPort < 1 || localPort > 65535) {
      toast.error(t("settings.sshPortForwardLocalPort"));
      return;
    }
    if (pfType !== "dynamic") {
      if (!pfRemoteHost.trim()) {
        toast.error(t("settings.sshPortForwardRemoteHost"));
        return;
      }
      if (!remotePort || remotePort < 1 || remotePort > 65535) {
        toast.error(t("settings.sshPortForwardRemotePort"));
        return;
      }
    }
    const rule: PortForwardRule = {
      id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: pfType,
      localHost: pfLocalHost.trim() || "127.0.0.1",
      localPort,
      remoteHost: pfType === "dynamic" ? "" : pfRemoteHost.trim(),
      remotePort: pfType === "dynamic" ? 0 : remotePort,
      enabled: pfEnabled,
    };
    setForm((form) => ({
      ...form,
      ssh: { ...form.ssh, portForwards: [...form.ssh.portForwards, rule] },
    }));
    setShowPortForwardForm(false);
    setPfType("local");
    setPfLocalHost("127.0.0.1");
    setPfLocalPort("");
    setPfRemoteHost("");
    setPfRemotePort("");
    setPfEnabled(true);
  }

  function removePortForward(id: string) {
    setForm((form) => ({
      ...form,
      ssh: { ...form.ssh, portForwards: form.ssh.portForwards.filter((r) => r.id !== id) },
    }));
  }

  function togglePortForwardEnabled(id: string, enabled: boolean) {
    setForm((form) => ({
      ...form,
      ssh: {
        ...form.ssh,
        portForwards: form.ssh.portForwards.map((r) => (r.id === id ? { ...r, enabled } : r)),
      },
    }));
  }

  async function performExportBackup(withSecrets: boolean) {
    const backup = await exportLocalDataBackup(browserRuntime.storage, withSecrets);
    const password = exportPassword.trim();
    if (password) {
      const encrypted = await encryptBackup(backup, password);
      const blob = new Blob([JSON.stringify(encrypted, null, 2)], { type: "application/json" });
      saveBlob(blob, `easy-console-backup-${new Date().toISOString().slice(0, 10)}.encrypted.json`);
      toast.success(text("加密备份文件已导出", "Encrypted backup exported"));
    } else {
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      saveBlob(blob, `easy-console-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toast.success(text("备份文件已导出", "Backup exported"));
    }
  }

  function exportBackup() {
    if (includeSecrets) {
      confirm({
        title: text("导出确认", "Export confirmation"),
        description: text("导出文件将包含登录 token 和已保存账号。确认继续？", "The export will include login tokens and saved accounts. Continue?"),
        confirmLabel: text("导出", "Export"),
        tone: "danger",
        run: () => performExportBackup(true),
      });
      return;
    }
    void performExportBackup(false);
  }

  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      if (isEncryptedBackup(raw)) {
        setImportEncrypted(raw);
        setImportBackup(null);
        setImportPassword("");
        setImportDecryptError(null);
        setImportSecrets(false);
        setImportSections([]);
        return;
      }
      const backup = parseLocalDataBackup(JSON.stringify(raw));
      setImportBackup(backup);
      setImportEncrypted(null);
      setImportPassword("");
      setImportDecryptError(null);
      setImportSecrets(false);
      setImportSections(nonSecretBackupSections.filter((section) => backup.items[section] !== undefined));
    } catch (importError) {
      toast.error(text("备份文件无法识别", "Backup file is not recognized"), importError instanceof Error ? importError.message : text("请选择 EasyConsole 备份 JSON", "Choose an EasyConsole backup JSON file"));
    }
  }

  async function decryptImportFile() {
    if (!importEncrypted) return;
    const password = importPassword.trim();
    if (!password) {
      setImportDecryptError(text("请输入解密密码", "Enter the decryption password"));
      return;
    }
    try {
      const backup = await decryptBackup(importEncrypted, password);
      setImportBackup(backup);
      setImportEncrypted(null);
      setImportDecryptError(null);
      setImportSections(nonSecretBackupSections.filter((section) => backup.items[section] !== undefined));
    } catch (decryptError) {
      setImportDecryptError(decryptError instanceof Error ? decryptError.message : text("解密失败", "Decryption failed"));
    }
  }

  function toggleImportSection(section: LocalDataBackupSection, checked: boolean) {
    setImportSections((current) => checked ? [...new Set([...current, section])] : current.filter((item) => item !== section));
  }

  async function performImportBackup() {
    if (!importBackup) return;
    const sections = [...importSections, ...(importSecrets ? secretBackupSections.filter((section) => importBackup.items[section] !== undefined) : [])];
    await importLocalDataBackup(browserRuntime.storage, importBackup, sections);
    const nextSettings = normalizeAppSettings(importBackup.items.settings as Partial<AppSettings>);
    if (sections.includes("settings")) applySettings(nextSettings);
    queryClient.clear();
    toast.success(text("本地数据已导入", "Local data imported"), text("部分设置需要刷新后完全生效", "Some settings need a refresh to fully apply"));
    setImportBackup(null);
  }

  function applyImportBackup() {
    if (!importBackup) return;
    const sections = [...importSections, ...(importSecrets ? secretBackupSections.filter((section) => importBackup.items[section] !== undefined) : [])];
    if (sections.some((section) => secretBackupSections.includes(section))) {
      confirm({
        title: text("导入确认", "Import confirmation"),
        description: text("将导入登录凭据并覆盖本地账号数据。确认继续？", "This will import credentials and overwrite local account data. Continue?"),
        confirmLabel: text("导入", "Import"),
        tone: "danger",
        run: performImportBackup,
      });
      return;
    }
    void performImportBackup();
  }

  const content = (
    <>
    <form className="space-y-5" onSubmit={onSubmit}>
      <Panel>
        <SectionHeader
          icon={Settings2}
          title={t("settings.runtimeTitle")}
          description={t("settings.runtimeDescription")}
          actions={
            <>
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
            </>
          }
        />

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

          <aside className="rounded-lg border border-app-border bg-app-panel/60 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-app-muted">
              <Globe className="h-3.5 w-3.5 text-app-accent" />
              {t("settings.derivedTitle")}
            </div>
            <div className="mt-3 space-y-3 text-xs">
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-app-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-app-accent" />
                  WebSSH
                </div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-app-surface px-2.5 py-2 font-mono text-app-text ring-1 ring-inset ring-app-border">
                  {derivedWebsshUrl}
                </code>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-app-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-app-muted" />
                  {t("settings.scope")}
                </div>
                <p className="leading-5 text-app-muted">
                  {t("settings.scopeDescription")}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </Panel>

      {browserRuntime.supportsTray ? (
        <Panel>
          <SectionHeader
            icon={PanelTopClose}
            title={text("窗口关闭", "Window Close")}
            description={text("控制桌面端点击关闭按钮后的确认和托盘行为。", "Control confirmation and tray behavior when closing the desktop window.")}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <label className="flex items-start gap-3 rounded-md border border-app-border bg-app-panel px-3 py-2 text-sm transition-colors hover:border-app-accent/40 hover:bg-app-surface">
              <input
                className="mt-1"
                type="checkbox"
                checked={form.desktopClosePrompt}
                onChange={(event) => setForm((value) => ({ ...value, desktopClosePrompt: event.target.checked }))}
              />
              <span>
                <span className="block font-medium text-app-text">{text("关闭窗口前确认", "Confirm before closing")}</span>
                <span className="mt-1 block text-xs leading-5 text-app-muted">
                  {text("开启后点击关闭会先选择彻底退出或最小化到托盘。", "When enabled, closing asks whether to exit or minimize to tray.")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-app-border bg-app-panel px-3 py-2 text-sm transition-colors hover:border-app-accent/40 hover:bg-app-surface">
              <input
                className="mt-1"
                type="checkbox"
                checked={form.desktopCloseToTray}
                onChange={(event) => setForm((value) => ({ ...value, desktopCloseToTray: event.target.checked }))}
              />
              <span>
                <span className="block font-medium text-app-text">{text("关闭窗口时最小化到托盘", "Minimize to tray on close")}</span>
                <span className="mt-1 block text-xs leading-5 text-app-muted">
                  {text("未启用关闭确认时生效：关闭主窗口会隐藏到托盘而不是退出。", "Applies when close confirmation is off: closing the main window hides it to tray instead of exiting.")}
                </span>
              </span>
            </label>
          </div>
        </Panel>
      ) : null}

      {browserRuntime.supportsInAppSsh ? (
        <Panel>
          <SectionHeader
            icon={Terminal}
            title={t("settings.sshTitle")}
            description={t("settings.sshDescription")}
          />

          <div className="space-y-6 p-4">
            <div>
              <SubSectionHeading icon={Plug} label={t("settings.sshConnection")} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshDefaultUsername")}</span>
                  <Input value={form.ssh.defaultUsername} onChange={(e) => updateSshField("defaultUsername", e.target.value)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshDefaultPort")}</span>
                  <Input type="number" min={1} value={form.ssh.defaultPort} onChange={(e) => updateSshField("defaultPort", Number(e.target.value) || DEFAULT_SSH_SETTINGS.defaultPort)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshTermType")}</span>
                  <Select value={form.ssh.termType} onChange={(e) => updateSshField("termType", e.target.value)}>
                    {sshTermTypeOptions.map((term) => <option key={term} value={term}>{term}</option>)}
                  </Select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshDefaultCols")}</span>
                  <Input type="number" min={1} value={form.ssh.defaultCols} onChange={(e) => updateSshField("defaultCols", Number(e.target.value) || DEFAULT_SSH_SETTINGS.defaultCols)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshDefaultRows")}</span>
                  <Input type="number" min={1} value={form.ssh.defaultRows} onChange={(e) => updateSshField("defaultRows", Number(e.target.value) || DEFAULT_SSH_SETTINGS.defaultRows)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshConnectTimeout")}</span>
                  <Input type="number" min={1} value={form.ssh.connectTimeoutSec} onChange={(e) => updateSshField("connectTimeoutSec", Number(e.target.value) || DEFAULT_SSH_SETTINGS.connectTimeoutSec)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshKeepalive")}</span>
                  <Input type="number" min={0} value={form.ssh.keepaliveIntervalSec} onChange={(e) => updateSshField("keepaliveIntervalSec", Number(e.target.value) || 0)} />
                </label>
              </div>
            </div>

            <div>
              <SubSectionHeading icon={KeyRound} label={t("settings.sshAuth")} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshAuthMode")}</span>
                  <Select value={form.ssh.authMode} onChange={(e) => updateSshField("authMode", e.target.value as SshAuthMode)}>
                    {sshAuthModeOptions.map((opt) => <option key={opt.mode} value={opt.mode}>{text(opt.zh, opt.en)}</option>)}
                  </Select>
                </label>
                {form.ssh.authMode === "key" ? (
                  <label className="block text-sm">
                    <span className="mb-1 block text-app-muted">{t("settings.sshKeyPath")}</span>
                    <div className="flex gap-2">
                      <Input className="flex-1 font-mono text-xs" value={form.ssh.sshKeyPath} onChange={(e) => updateSshField("sshKeyPath", e.target.value)} placeholder="~/.ssh/id_rsa" />
                      <Button type="button" variant="secondary" onClick={() => void chooseKeyFile()}>
                        {t("settings.sshChooseKeyFile")}
                      </Button>
                    </div>
                  </label>
                ) : null}
              </div>
            </div>

            <div>
              <SubSectionHeading icon={Palette} label={t("settings.sshTerminal")} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshFontPreset")}</span>
                  <Select value={form.ssh.terminal.fontPreset} onChange={(e) => syncFontPreset(e.target.value)}>
                    {SSH_FONT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                  </Select>
                </label>
                {form.ssh.terminal.fontPreset === "custom" ? (
                  <label className="block text-sm sm:col-span-2">
                    <span className="mb-1 block text-app-muted">{t("settings.sshFontCustom")}</span>
                    <Input className="font-mono text-xs" value={form.ssh.terminal.fontFamily} onChange={(e) => updateSshTerminalField("fontFamily", e.target.value)} placeholder='Consolas, monospace' />
                  </label>
                ) : null}
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshFontSize")}</span>
                  <Input type="number" min={6} value={form.ssh.terminal.fontSize} onChange={(e) => updateSshTerminalField("fontSize", Number(e.target.value) || DEFAULT_SSH_SETTINGS.terminal.fontSize)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshScrollback")}</span>
                  <Input type="number" min={0} value={form.ssh.terminal.scrollback} onChange={(e) => updateSshTerminalField("scrollback", Number(e.target.value) || 0)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{t("settings.sshTheme")}</span>
                  <Select value={form.ssh.terminal.theme} onChange={(e) => updateSshTerminalField("theme", e.target.value as SshTerminalTheme)}>
                    {sshThemeOptions.map((opt) => <option key={opt.theme} value={opt.theme}>{text(opt.zh, opt.en)}</option>)}
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.ssh.terminal.cursorBlink} onChange={(e) => updateSshTerminalField("cursorBlink", e.target.checked)} />
                  {t("settings.sshCursorBlink")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.ssh.terminal.webglRenderer} onChange={(e) => updateSshTerminalField("webglRenderer", e.target.checked)} />
                  {t("settings.sshWebgl")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.ssh.terminal.webLinks} onChange={(e) => updateSshTerminalField("webLinks", e.target.checked)} />
                  {t("settings.sshWebLinks")}
                </label>
              </div>
              {form.ssh.terminal.theme === "custom" ? (
                <div className="mt-3 rounded-md border border-app-border bg-app-panel p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-app-muted">{t("settings.sshThemeCustom")}</span>
                    <Button type="button" variant="secondary" onClick={() => updateSshTerminalField("customColors", DEFAULT_CUSTOM_COLORS)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("settings.sshResetColors")}
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <div className="mb-1 text-xs text-app-muted">{t("settings.sshColorBackground")}</div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {renderColorField("background", form.ssh.terminal.customColors.background)}
                        {renderColorField("foreground", form.ssh.terminal.customColors.foreground)}
                        {renderColorField("cursor", form.ssh.terminal.customColors.cursor)}
                        {renderColorField("selection", form.ssh.terminal.customColors.selection)}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-app-muted">{t("settings.sshColorAnsi")}</div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {renderColorField("black", form.ssh.terminal.customColors.black)}
                        {renderColorField("red", form.ssh.terminal.customColors.red)}
                        {renderColorField("green", form.ssh.terminal.customColors.green)}
                        {renderColorField("yellow", form.ssh.terminal.customColors.yellow)}
                        {renderColorField("blue", form.ssh.terminal.customColors.blue)}
                        {renderColorField("magenta", form.ssh.terminal.customColors.magenta)}
                        {renderColorField("cyan", form.ssh.terminal.customColors.cyan)}
                        {renderColorField("white", form.ssh.terminal.customColors.white)}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-app-muted">{t("settings.sshColorAnsiBright")}</div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {renderColorField("brightBlack", form.ssh.terminal.customColors.brightBlack)}
                        {renderColorField("brightRed", form.ssh.terminal.customColors.brightRed)}
                        {renderColorField("brightGreen", form.ssh.terminal.customColors.brightGreen)}
                        {renderColorField("brightYellow", form.ssh.terminal.customColors.brightYellow)}
                        {renderColorField("brightBlue", form.ssh.terminal.customColors.brightBlue)}
                        {renderColorField("brightMagenta", form.ssh.terminal.customColors.brightMagenta)}
                        {renderColorField("brightCyan", form.ssh.terminal.customColors.brightCyan)}
                        {renderColorField("brightWhite", form.ssh.terminal.customColors.brightWhite)}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              <SubSectionHeading
                icon={ShieldCheck}
                label={t("settings.sshKnownHosts")}
                trailing={knownHosts.length > 0 ? (
                  <Button type="button" variant="secondary" onClick={clearAllKnownHosts}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("settings.sshClearAllHosts")}
                  </Button>
                ) : null}
              />
              {knownHostsLoading ? (
                <div className="py-4 text-center text-xs text-app-muted">...</div>
              ) : knownHosts.length === 0 ? (
                <div className="py-4 text-center text-xs text-app-muted">{t("settings.sshKnownHostsEmpty")}</div>
              ) : (
                <div className="space-y-1">
                  {knownHosts.map((host) => (
                    <div key={host.hostPort} className="flex items-center justify-between rounded-md border border-app-border bg-app-panel px-3 py-2 text-xs transition-colors hover:border-app-accent/40 hover:bg-app-surface">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-app-text">{host.hostPort}</div>
                        <div className="truncate font-mono text-app-muted">{host.fingerprint}</div>
                      </div>
                      <button className="ml-2 shrink-0 rounded p-1 text-app-muted hover:bg-app-surface hover:text-app-danger" type="button" onClick={() => removeKnownHost(host.hostPort)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <SubSectionHeading
                icon={History}
                label={t("settings.sshHistory")}
                trailing={sshHistory.length > 0 ? (
                  <Button type="button" variant="secondary" onClick={clearAllSshHistory}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("settings.sshClearHistory")}
                  </Button>
                ) : null}
              />
              {sshHistoryLoading ? (
                <div className="py-4 text-center text-xs text-app-muted">...</div>
              ) : sshHistory.length === 0 ? (
                <div className="py-4 text-center text-xs text-app-muted">{t("settings.sshHistoryEmpty")}</div>
              ) : (
                <div className="space-y-1">
                  {sshHistory.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between rounded-md border border-app-border bg-app-panel px-3 py-2 text-xs transition-colors hover:border-app-accent/40 hover:bg-app-surface">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-app-text">{entry.host}:{entry.port || "22"}</div>
                        <div className="truncate text-app-muted">
                          {entry.username}
                          {entry.taskName ? ` · ${entry.taskName}` : ""}
                          {" · "}
                          {new Date(entry.connectedAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <SubSectionHeading
                icon={Network}
                label={t("settings.sshPortForwards")}
                trailing={
                  <Button type="button" variant="secondary" onClick={() => setShowPortForwardForm((prev) => !prev)}>
                    {t("settings.sshPortForwardAdd")}
                  </Button>
                }
              />
              {showPortForwardForm ? (
                <div className="mb-3 space-y-3 rounded-md border border-app-border bg-app-panel p-3">
                  <label className="block text-sm">
                    <span className="mb-1 block text-app-muted">{t("settings.sshPortForwardType")}</span>
                    <Select
                      value={pfType}
                      onChange={(e) => setPfType(e.target.value as PortForwardType)}
                    >
                      <option value="local">{t("settings.sshPortForwardLocal")}</option>
                      <option value="remote">{t("settings.sshPortForwardRemote")}</option>
                      <option value="dynamic">{t("settings.sshPortForwardDynamic")}</option>
                    </Select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="mb-1 block text-app-muted">{t("settings.sshPortForwardLocalHost")}</span>
                      <Input value={pfLocalHost} onChange={(e) => setPfLocalHost(e.target.value)} placeholder="127.0.0.1" />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block text-app-muted">{t("settings.sshPortForwardLocalPort")}</span>
                      <Input type="number" min={1} max={65535} value={pfLocalPort} onChange={(e) => setPfLocalPort(e.target.value)} placeholder="8080" />
                    </label>
                  </div>
                  {pfType !== "dynamic" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-sm">
                        <span className="mb-1 block text-app-muted">{t("settings.sshPortForwardRemoteHost")}</span>
                        <Input value={pfRemoteHost} onChange={(e) => setPfRemoteHost(e.target.value)} placeholder="example.com" />
                      </label>
                      <label className="block text-sm">
                        <span className="mb-1 block text-app-muted">{t("settings.sshPortForwardRemotePort")}</span>
                        <Input type="number" min={1} max={65535} value={pfRemotePort} onChange={(e) => setPfRemotePort(e.target.value)} placeholder="80" />
                      </label>
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pfEnabled} onChange={(e) => setPfEnabled(e.target.checked)} />
                    <span className="text-app-muted">{t("settings.sshPortForwardEnabled")}</span>
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setShowPortForwardForm(false)}>
                      {text("取消", "Cancel")}
                    </Button>
                    <Button type="button" onClick={addPortForward}>
                      {text("添加", "Add")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {form.ssh.portForwards.length === 0 ? (
                <div className="py-4 text-center text-xs text-app-muted">{t("settings.sshPortForwardEmpty")}</div>
              ) : (
                <div className="space-y-1">
                  {form.ssh.portForwards.map((rule) => (
                    <div key={rule.id} className="flex items-center justify-between rounded-md border border-app-border bg-app-panel px-3 py-2 text-xs transition-colors hover:border-app-accent/40 hover:bg-app-surface">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-app-accentSoft px-1.5 py-0.5 font-mono text-[10px] font-medium text-app-accent">
                            {rule.type === "local" ? "-L" : rule.type === "remote" ? "-R" : "-D"}
                          </span>
                          <span className="font-mono text-app-text">
                            {rule.localHost}:{rule.localPort}
                            {rule.type !== "dynamic" ? ` → ${rule.remoteHost}:${rule.remotePort}` : ""}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-app-muted">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={(e) => togglePortForwardEnabled(rule.id, e.target.checked)}
                            />
                            <span>{t("settings.sshPortForwardEnabled")}</span>
                          </label>
                        </div>
                      </div>
                      <button
                        className="ml-2 shrink-0 rounded p-1 text-app-muted hover:bg-app-surface hover:text-app-danger"
                        type="button"
                        onClick={() => confirm({
                          title: t("settings.sshPortForwards"),
                          description: t("settings.sshPortForwardDeleteConfirm"),
                          confirmLabel: text("删除", "Delete"),
                          tone: "danger",
                          run: () => removePortForward(rule.id),
                        })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      ) : null}

      {browserRuntime.supportsUpdater ? (
      <Panel>
        <SectionHeader
          icon={Activity}
          title={text("应用更新", "App Updates")}
          description={
            browserRuntime.isMobile
              ? text("从 GitHub Release 检查 APK 更新。", "Checks for APK updates from GitHub Release.")
              : text("桌面端从 GitHub Release 检查稳定版更新。", "The desktop app checks stable updates from GitHub Release.")
          }
          actions={
            <>
              <Button
                disabled={!browserRuntime.supportsUpdater || appUpdate.state.status === "checking" || appUpdate.state.status === "downloading"}
                type="button"
                variant="secondary"
                onClick={() => void appUpdate.checkForUpdates(true)}
              >
                <RefreshCw className="h-4 w-4" />
                {appUpdate.state.status === "checking" ? text("检查中", "Checking") : text("检查更新", "Check")}
              </Button>
              <Button type="button" variant="secondary" onClick={appUpdate.openReleasePage}>
                <ExternalLink className="h-4 w-4" />
                GitHub
              </Button>
            </>
          }
        />
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-3">
            <label className="flex items-start gap-3 rounded-md border border-app-border bg-app-panel px-3 py-2 text-sm transition-colors hover:border-app-accent/40 hover:bg-app-surface">
              <input
                className="mt-1"
                type="checkbox"
                checked={form.autoCheckUpdates}
                onChange={(event) => setForm((value) => ({ ...value, autoCheckUpdates: event.target.checked }))}
              />
              <span>
                <span className="block font-medium text-app-text">{text("启动后自动检查更新", "Check for updates after startup")}</span>
                <span className="mt-1 block text-xs leading-5 text-app-muted">
                  {text("最多每 12 小时自动检查一次；手动检查不受限制。", "Automatic checks run at most once every 12 hours; manual checks are not limited.")}
                </span>
              </span>
            </label>
            {!browserRuntime.supportsUpdater ? (
              <div className="rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warning">
                {text("当前运行时不支持安装桌面更新。", "This runtime cannot install desktop updates.")}
              </div>
            ) : null}
            {appUpdate.state.error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{appUpdate.state.error}</div> : null}
          </div>
          <aside className="min-w-0 rounded-lg border border-app-border bg-app-panel/60 p-3 text-xs">
            <div className="grid gap-3">
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-app-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-app-accent" />
                  {text("当前版本", "Current version")}
                </div>
                <code className="font-mono text-app-text">{appUpdate.state.currentVersion ?? appUpdate.state.info?.currentVersion ?? "-"}</code>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-app-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-app-muted" />
                  {text("更新源", "Update source")}
                </div>
                <code className="block max-w-full break-all rounded-md bg-app-surface px-2.5 py-2 font-mono leading-5 text-app-text ring-1 ring-inset ring-app-border">
                  {browserRuntime.isMobile ? GITHUB_API_RELEASE_URL : APP_UPDATE_ENDPOINT_URL}
                </code>
              </div>
              {appUpdate.state.lastCheckedAt ? (
                <div className="text-app-muted">
                  {text("上次检查", "Last checked")} {new Date(appUpdate.state.lastCheckedAt).toLocaleString()}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </Panel>
      ) : null}

      <Panel>
        <SectionHeader
          icon={ScrollText}
          title={text("运行日志保留策略", "Run Log Retention")}
          description={text("设置运行日志的最大条数与保留天数。超出后自动清理最早的记录。", "Set the maximum number of run log entries and retention days. Older entries are pruned automatically.")}
        />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("最大条数", "Max entries")}</span>
            <Input
              type="number"
              min={1}
              value={form.runLogLimit}
              onChange={(event) => setForm((value) => ({ ...value, runLogLimit: Number(event.target.value) || DEFAULT_APP_SETTINGS.runLogLimit }))}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("保留天数", "Retention days")}</span>
            <Input
              type="number"
              min={1}
              value={form.runLogRetentionDays}
              onChange={(event) => setForm((value) => ({ ...value, runLogRetentionDays: Number(event.target.value) || DEFAULT_APP_SETTINGS.runLogRetentionDays }))}
            />
          </label>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={DatabaseBackup}
          title={text("本地数据备份", "Local Data Backup")}
          description={text("导出或恢复设置、任务模板、计划任务和运行日志。登录凭据默认不会包含。", "Export or restore settings, task templates, scheduled tasks, and run logs. Credentials are excluded by default.")}
          actions={
            <>
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
            </>
          }
        />
        <div className="border-b border-app-border bg-app-panel/40 px-4 py-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-app-muted">
              {text("加密密码（可选，留空则导出明文）", "Encryption password (optional, leave empty for plaintext)")}
            </span>
            <Input
              type="password"
              className="w-full sm:max-w-sm"
              placeholder={text("设置密码后导出文件将被加密", "If set, the export will be encrypted")}
              value={exportPassword}
              onChange={(event) => setExportPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="mt-1 text-xs text-app-muted">
            {text("加密使用 AES-GCM 256 + PBKDF2 密钥派生。导入时需要相同密码。", "Encryption uses AES-GCM 256 + PBKDF2 key derivation. The same password is required for import.")}
          </p>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={BellRing}
          title={text("重要事件通知", "Important Event Notifications")}
          description={text("为每类事件选择关闭、应用内通知或系统通知。", "Choose off, in-app, or system notifications for each event.")}
          actions={
            <Button disabled={saving} type="button" variant="secondary" onClick={sendTestNotification}>
              <BellRing className="h-4 w-4" />
              {text("测试通知", "Test notification")}
            </Button>
          }
        />
        <div className="divide-y divide-app-border">
          {notificationEvents.map((item) => {
            const tone =
              item.event === "task.success"
                ? "bg-app-success"
                : item.event === "task.failure"
                  ? "bg-app-danger"
                  : "bg-app-warning";
            return (
              <div key={item.event} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
                <div className="flex min-w-0 items-start gap-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-app-text">{text(item.zh, item.en)}</div>
                    <div className="mt-1 text-xs leading-5 text-app-muted">{text(item.descriptionZh, item.descriptionEn)}</div>
                  </div>
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
            );
          })}
        </div>
      </Panel>

      <Dialog
        open={Boolean(importEncrypted)}
        title={text("解密备份文件", "Decrypt Backup File")}
        onClose={() => setImportEncrypted(null)}
        width="max-w-md"
      >
        <div className="space-y-4 p-4 text-sm">
          <p className="text-app-muted">
            {text("该备份文件已加密。请输入导出时设置的密码以继续导入。", "This backup file is encrypted. Enter the password set during export to continue.")}
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-app-muted">{text("解密密码", "Decryption password")}</span>
            <Input
              type="password"
              className="w-full"
              value={importPassword}
              onChange={(event) => setImportPassword(event.target.value)}
              autoComplete="current-password"
              onKeyDown={(event) => {
                if (event.key === "Enter") void decryptImportFile();
              }}
            />
          </label>
          {importDecryptError ? (
            <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{importDecryptError}</div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setImportEncrypted(null)}>
              {text("取消", "Cancel")}
            </Button>
            <Button type="button" onClick={() => void decryptImportFile()}>
              {text("解密", "Decrypt")}
            </Button>
          </div>
        </div>
      </Dialog>

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
    {confirmDialog}
  </>
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
