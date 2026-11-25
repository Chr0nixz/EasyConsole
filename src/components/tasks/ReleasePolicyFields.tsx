import { CalendarClock, Flag, Hand } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { addHours, formatCost, formatDateTimeLocalInput, formatSecondsDuration, localizedText, releaseConditionText } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { isReleaseConditionValue, TIMED_RELEASE_PRESET_HOURS, type ReleaseConditionValue } from "../../lib/release-policy";
import { cn } from "../../lib/utils";
import { FieldError } from "../form-fields";
import { Input, SegmentedControl } from "../ui";

/**
 * How a form states a timed release:
 * - `at`: a moment, for an instance created now (`YYYY-MM-DDTHH:mm`);
 * - `hours`: hours after each creation, for a template;
 * - `fixed`: hours the caller cannot change, for a scheduled plan.
 */
export type TimedReleaseInput =
  | { kind: "at"; value: string; onChange: (value: string) => void; onBlur?: () => void; error?: string }
  | { kind: "hours"; hours: number; onChange: (hours: number) => void; onBlur?: () => void; error?: string }
  | { kind: "fixed"; hours: number };

// Timed first and manual last: the order says which choice ends billing on its own.
const CONDITION_ORDER: ReleaseConditionValue[] = ["2", "3", "1"];
const CONDITION_ICONS = { "1": Hand, "2": CalendarClock, "3": Flag } as const;
const CUSTOM = "custom";

/**
 * The release policy of a new instance, the same control in create, clone, template and
 * scheduled plan: the condition as a segmented choice with its consequence underneath, then
 * the timed release's duration (or the task-end fields the caller passes as children).
 */
export function ReleasePolicyFields({
  condition,
  onConditionChange,
  timed,
  hourlyRate,
  children,
}: {
  condition: string;
  onConditionChange: (value: ReleaseConditionValue) => void;
  timed: TimedReleaseInput;
  /** Per-instance rate, when known, to price a timed release's duration. */
  hourlyRate?: number | null;
  /** The working directory and script fields shown for release after task ends. */
  children?: ReactNode;
}) {
  const { locale, text } = useI18n();
  const options = CONDITION_ORDER.map((value) => {
    const Icon = CONDITION_ICONS[value];
    return {
      value,
      label: (
        <>
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {localizedText(releaseConditionText[Number(value)], locale)}
        </>
      ),
    };
  });
  const consequence = condition === "1"
    ? text("实例会一直计费，直到你手动释放。", "The instance bills until you release it yourself.")
    : condition === "2"
      ? text("到时间自动释放，停止计费。", "Released automatically at that time, which stops billing.")
      : text("脚本结束后自动释放，停止计费。", "Released automatically when the script ends, which stops billing.");

  return (
    <div className="space-y-3">
      <div className="text-sm">
        <span className="mb-1 block text-app-muted">{text("释放条件", "Release condition")}</span>
        <SegmentedControl
          className="max-w-full flex-wrap"
          label={text("释放条件", "Release condition")}
          options={options}
          value={isReleaseConditionValue(condition) ? condition : "1"}
          onChange={(value) => onConditionChange(value)}
        />
        <p className="mt-1 text-xs leading-5 text-app-muted">{consequence}</p>
      </div>
      {condition === "2" ? <TimedReleaseField hourlyRate={hourlyRate ?? null} timed={timed} /> : null}
      {condition === "3" ? children : null}
    </div>
  );
}

function TimedReleaseField({ timed, hourlyRate }: { timed: TimedReleaseInput; hourlyRate: number | null }) {
  const { locale, text } = useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // The chip a moment was picked with; editing the time by hand makes it custom again.
  const [picked, setPicked] = useState<{ hours: number; value: string } | null>(null);
  const [customHours, setCustomHours] = useState(false);
  // "Releases in about …" counts from now, so it moves with the clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (timed.kind !== "at") return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [timed.kind]);
  const hoursLabel = (hours: number) => text(`${hours} 小时`, `${hours} hr`);
  const chipOptions = [
    ...TIMED_RELEASE_PRESET_HOURS.map((hours) => ({ value: String(hours), label: hoursLabel(hours) })),
    { value: CUSTOM, label: text("自定义", "Custom") },
  ];
  const spend = (hours: number | null) =>
    hourlyRate !== null && hours !== null && hours > 0 ? formatCost(hourlyRate * hours, locale) : null;

  // The plan and create footers already price the run; only the template, which has no footer
  // estimate, prices its duration here.
  if (timed.kind === "fixed") {
    return <p className="text-sm text-app-text">{text(`每次执行后 ${timed.hours} 小时自动释放`, `Released ${timed.hours} hours after each run`)}</p>;
  }

  if (timed.kind === "hours") {
    const preset = (TIMED_RELEASE_PRESET_HOURS as readonly number[]).includes(timed.hours) && !customHours;
    const cost = spend(timed.hours);
    return (
      <div className="space-y-2 text-sm">
        <span className="block text-app-muted" id={`${id}-label`}>{text("创建后多久释放", "Release after creation")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={text("释放时长", "Release after")}
            options={chipOptions}
            value={preset ? String(timed.hours) : CUSTOM}
            onChange={(value) => {
              if (value === CUSTOM) {
                setCustomHours(true);
                window.setTimeout(() => inputRef.current?.focus(), 0);
                return;
              }
              setCustomHours(false);
              timed.onChange(Number(value));
            }}
          />
          {preset ? null : (
            <label className="flex items-center gap-2">
              <Input
                ref={inputRef}
                aria-invalid={Boolean(timed.error)}
                aria-labelledby={`${id}-label`}
                className={cn("w-24", timed.error && "border-app-danger")}
                min="0.1"
                step="0.1"
                type="number"
                value={timed.hours}
                onBlur={timed.onBlur}
                onChange={(event) => timed.onChange(Number(event.target.value))}
                required
              />
              <span className="text-app-muted">{text("小时", "hours")}</span>
            </label>
          )}
        </div>
        <p className="app-numeric text-xs leading-5 text-app-muted">
          {text(`每个实例创建后 ${timed.hours || "-"} 小时自动释放`, `Each instance is released ${timed.hours || "-"} hours after it is created`)}
          {cost ? text(`，约 ${cost}`, `, about ${cost}`) : null}
        </p>
        <FieldError message={timed.error} />
      </div>
    );
  }

  const value = timed.value.slice(0, 16);
  const pressed = picked && picked.value === value ? String(picked.hours) : CUSTOM;
  const releaseAt = value ? Date.parse(value) : Number.NaN;
  // Whole minutes: a time picked as "8 hours" from mid-minute still reads as 8 hours.
  const remainingMinutes = Number.isFinite(releaseAt) ? Math.round((releaseAt - nowMs) / 60_000) : null;
  return (
    <div className="space-y-2 text-sm">
      <label className="block text-app-muted" htmlFor={`${id}-at`}>{text("释放时间", "Release time")}</label>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={text("释放时长", "Release in")}
          options={chipOptions}
          value={pressed}
          onChange={(next) => {
            if (next === CUSTOM) {
              inputRef.current?.focus();
              return;
            }
            const hours = Number(next);
            const at = formatDateTimeLocalInput(addHours(new Date(), hours)).slice(0, 16);
            setPicked({ hours, value: at });
            timed.onChange(at);
          }}
        />
        <Input
          ref={inputRef}
          id={`${id}-at`}
          aria-invalid={Boolean(timed.error)}
          className={cn("w-auto min-w-[13rem]", timed.error && "border-app-danger")}
          step={60}
          type="datetime-local"
          value={value}
          onBlur={timed.onBlur}
          onChange={(event) => timed.onChange(event.target.value)}
          required
        />
      </div>
      {remainingMinutes !== null && remainingMinutes > 0 ? (
        <p className="app-numeric text-xs leading-5 text-app-muted">
          {remainingMinutes % 60 === 0 && remainingMinutes < 24 * 60
            ? text(`${remainingMinutes / 60} 小时后释放`, `Releases in ${remainingMinutes / 60} hours`)
            : text(`约 ${formatSecondsDuration(remainingMinutes * 60, locale)}后释放`, `Releases in about ${formatSecondsDuration(remainingMinutes * 60, locale)}`)}
        </p>
      ) : remainingMinutes !== null ? (
        <p className="text-xs leading-5 text-app-danger">{text("这个时间已经过去，请选一个将来的时间。", "This time has passed; pick one in the future.")}</p>
      ) : null}
      <FieldError message={timed.error} />
    </div>
  );
}
