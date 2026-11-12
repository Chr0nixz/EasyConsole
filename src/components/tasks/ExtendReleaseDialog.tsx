import { useId, useState } from "react";

import { Button, Dialog, SegmentedControl, SettingTag } from "../ui";
import { formatCost, formatHourlyRate, getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import {
  formatReleaseCountdown,
  formatReleaseMoment,
  getExtendedReleaseAt,
  getExtensionCost,
  parseReleaseTime,
  RELEASE_EXTENSION_HOURS,
  type ReleaseExtensionHours,
} from "../../lib/task-release-notifications";
import type { Task } from "../../lib/types";
import { useExtendRelease } from "../../lib/use-extend-release";

/**
 * Extending a timed release is a spending decision, so the dialog answers the two questions
 * it turns on before the click: until when, and for how much more. Mount it only while open;
 * the time it counts from is fixed when it mounts, so the preview holds still.
 */
export function ExtendReleaseDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { locale, text } = useI18n();
  const { extend, pending } = useExtendRelease();
  const [hours, setHours] = useState<ReleaseExtensionHours>(1);
  const [openedAt] = useState(() => Date.now());
  const summaryId = useId();

  const releaseAt = parseReleaseTime(task);
  const nextReleaseAt = getExtendedReleaseAt(task, hours, openedAt);
  const cost = getExtensionCost(task, hours);
  const rate = Number(task.price);
  const hoursLabel = (value: number) => text(`${value} 小时`, value === 1 ? "1 hour" : `${value} hours`);

  return (
    <Dialog
      open
      title={text("延长定时释放", "Extend Timed Release")}
      onClose={() => { if (!pending) onClose(); }}
      width="max-w-md"
      mobileMode="bottom-sheet"
      describedBy={summaryId}
    >
      <div className="space-y-4 p-4">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="min-w-0 truncate font-medium text-app-text" title={getTaskName(task)}>{getTaskName(task)}</span>
          <SettingTag title={text("尚待真实环境验证", "Awaiting real-environment validation")}>{text("实验性", "Experimental")}</SettingTag>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-app-muted">{text("延长", "Extend by")}</span>
          <SegmentedControl
            label={text("延长时长", "Extension")}
            options={RELEASE_EXTENSION_HOURS.map((value) => ({ value: String(value), label: `+${hoursLabel(value)}` }))}
            value={String(hours)}
            onChange={(value) => setHours(Number(value) as ReleaseExtensionHours)}
          />
        </div>
        <dl id={summaryId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-app-panel px-3 py-2 text-xs leading-5 text-app-muted">
          <dt>{text("当前释放", "Releases")}</dt>
          <dd className="app-numeric text-app-text">
            {releaseAt === null
              ? text("时间未知，从现在起算", "Unknown, counted from now")
              : `${formatReleaseMoment(releaseAt, locale)} · ${formatReleaseCountdown(releaseAt - openedAt, locale)}`}
          </dd>
          <dt>{text("延长后", "After extending")}</dt>
          <dd className="app-numeric font-medium text-app-text">{formatReleaseMoment(nextReleaseAt, locale)}</dd>
          <dt>{text("多计费", "Extra charge")}</dt>
          <dd className="app-numeric text-app-text">
            {cost === null
              ? text("单价未知", "Rate unknown")
              : text(
                  `约 ${formatCost(cost, locale)}（${formatHourlyRate(rate, locale)} × ${hoursLabel(hours)}）`,
                  `about ${formatCost(cost, locale)} (${formatHourlyRate(rate, locale)} × ${hoursLabel(hours)})`,
                )}
          </dd>
        </dl>
        <p className="text-xs leading-5 text-app-muted">
          {text(
            "延长会写入新的释放时间；如后端不支持修改，会明确报错，原释放时间不变。",
            "Extending writes a new release time. If the backend does not support the change, it reports an error and the release time stays as it was.",
          )}
        </p>
        <div className="flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end">
          <Button disabled={pending} type="button" variant="secondary" onClick={onClose}>
            {text("取消", "Cancel")}
          </Button>
          <Button disabled={pending} type="button" onClick={() => extend(task, hours, { onSuccess: onClose })}>
            {pending
              ? text("提交中…", "Submitting…")
              : text(`延长 ${hours} 小时`, hours === 1 ? "Extend 1 Hour" : `Extend ${hours} Hours`)}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
