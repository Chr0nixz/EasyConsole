import { localizedText, releaseConditionText } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { formatPayloadResources } from "../../lib/resource-presets";
import type { CreateTaskPayload } from "../../lib/types";

/**
 * What submitting a creation commits the user to, shown above every create preview (batch
 * create, template apply, scheduled run now / run due): how many instances, what each one
 * holds, and that EasyConsole cannot take a creation back. The creation counterpart of
 * `BatchReleaseImpact`, so spending never reads lighter than releasing.
 */
export function CreateImpactSummary({ payloads }: { payloads: CreateTaskPayload[] }) {
  const { locale, text } = useI18n();
  const gpus = payloads.reduce((total, payload) => {
    const value = Number(payload.gpu);
    return Number.isFinite(value) && value > 0 ? total + value : total;
  }, 0);
  const shapes = new Set(payloads.map(formatPayloadResources));
  const conditions = new Set(payloads.map((payload) => Number(payload.releace_conditions)));
  const condition = conditions.size === 1 ? releaseConditionText[[...conditions][0]] : undefined;

  return (
    <div className="space-y-3">
      <p>
        {text("将创建 ", "Create ")}
        <span className="font-medium text-app-text">{text(`${payloads.length} 个实例`, `${payloads.length} instance${payloads.length === 1 ? "" : "s"}`)}</span>
        {text("：提交后立即在后端创建，每个实例启动后占用资源并开始计费。", ": each is created on the backend at once, and holds resources and bills once it starts.")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-app-panel px-3 py-2 text-xs leading-5">
        <dt>{text("每个实例", "Per instance")}</dt>
        <dd className="app-numeric text-app-text">{shapes.size === 1 ? [...shapes][0] : text("各不相同，逐项见下方", "Varies, listed per item below")}</dd>
        <dt>{text("合计 GPU", "GPUs in total")}</dt>
        <dd className="app-numeric text-app-text">{gpus > 0 ? gpus : "—"}</dd>
        <dt>{text("释放条件", "Release condition")}</dt>
        <dd className="text-app-text">{condition ? localizedText(condition, locale) : text("各不相同", "Varies")}</dd>
      </dl>
      <p className="text-xs leading-5">
        {text(
          "EasyConsole 无法撤回已提交的创建；多建的实例只能逐个释放。",
          "EasyConsole cannot take back a submitted creation; extra instances can only be released one by one.",
        )}
      </p>
    </div>
  );
}
