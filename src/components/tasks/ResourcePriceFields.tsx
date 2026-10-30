import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo } from "react";

import { FieldError } from "../form-fields";
import { Input, Select } from "../ui";
import { resourceApi } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  findMatchingPriceOptionId,
  formatResourceSpecOption,
  normalizePriceOptions,
  normalizeResourceSpecs,
} from "../../lib/resource-price";
import { cn } from "../../lib/utils";

const DEFAULT_PRICE = "1";

type ResourcePriceFieldsProps = {
  price: string;
  onPriceChange: (price: string) => void;
  onDefaultPriceChange?: (price: string) => void;
  allowDefaultPrice?: boolean;
  originalPrice?: string | number;
  onApplySpec: (values: { cpu: string; gpu: string; memory: string }) => void;
  /** The form's current CPU/GPU/memory, so the spec select keeps showing the spec they match. */
  resources?: { cpu: string; gpu: string; memory: string };
  priceError?: string;
  priceTouched?: boolean;
  onPriceBlur?: () => void;
};

export function ResourcePriceFields({
  price,
  onPriceChange,
  onDefaultPriceChange = onPriceChange,
  allowDefaultPrice = true,
  originalPrice,
  onApplySpec,
  resources,
  priceError,
  priceTouched,
  onPriceBlur,
}: ResourcePriceFieldsProps) {
  const { text } = useI18n();
  const fieldId = useId();
  const priceLabelId = `${fieldId}-label`;
  const priceHintId = `${fieldId}-hint`;
  const priceErrorId = `${fieldId}-error`;
  const currentPriceOptionId = `${fieldId}-current`;
  const resourcesQuery = useQuery({
    queryKey: ["resources"],
    queryFn: () => resourceApi.resources(),
    staleTime: 60_000,
  });
  const pricesQuery = useQuery({
    queryKey: ["prices"],
    queryFn: () => resourceApi.prices(),
    staleTime: 60_000,
  });

  const specs = useMemo(() => normalizeResourceSpecs(resourcesQuery.data ?? []), [resourcesQuery.data]);
  const priceOptions = useMemo(() => normalizePriceOptions(pricesQuery.data ?? []), [pricesQuery.data]);
  const matchedPriceOptionId = findMatchingPriceOptionId(priceOptions, price);
  const hasUnlistedPrice = priceOptions.length > 0 && Boolean(price.trim()) && !matchedPriceOptionId;
  const isOriginalPrice = originalPrice !== undefined && Number(originalPrice) === Number(price);
  const priceDescription = [
    hasUnlistedPrice ? priceHintId : null,
    priceTouched && priceError ? priceErrorId : null,
  ].filter(Boolean).join(" ") || undefined;

  // Derived rather than stored: editing CPU/GPU/memory by hand drops the select back to its
  // placeholder instead of naming a spec the form no longer matches.
  const same = (a: unknown, b: string) => a !== undefined && b.trim() !== "" && Number(a) === Number(b);
  const matchedSpecIndex = resources
    ? specs.findIndex((spec) => same(spec.cpu, resources.cpu) && same(spec.gpu ?? 0, resources.gpu) && same(spec.memory, resources.memory))
    : -1;
  const matchedSpecId = matchedSpecIndex === -1 ? "" : String(specs[matchedSpecIndex].id ?? matchedSpecIndex);

  useEffect(() => {
    // A fresh form starts on the first listed rate; a rate the list does not contain is only
    // replaced while the caller still allows defaults (new and untouched), never on an edit.
    if (!allowDefaultPrice) return;
    if (price.trim() && (priceOptions.length === 0 || matchedPriceOptionId)) return;
    if (priceOptions.length > 0) {
      onDefaultPriceChange(String(priceOptions[0].value));
      return;
    }
    if (!price.trim() && !pricesQuery.isLoading && !pricesQuery.isError) {
      onDefaultPriceChange(DEFAULT_PRICE);
    }
  }, [allowDefaultPrice, matchedPriceOptionId, onDefaultPriceChange, price, priceOptions, pricesQuery.isError, pricesQuery.isLoading]);

  const loadHint =
    resourcesQuery.isError || pricesQuery.isError
      ? text("规格或价格列表加载失败，可继续手动填写", "Spec/price list failed to load; you can still enter values manually")
      : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-app-muted">{text("资源规格", "Resource spec")}</span>
          <Select
            className="w-full"
            disabled={specs.length === 0}
            value={matchedSpecId}
            onChange={(event) => {
              const spec = specs.find((item) => String(item.id) === event.target.value);
              if (!spec) return;
              onApplySpec({
                cpu: String(spec.cpu ?? 4),
                gpu: String(spec.gpu ?? 0),
                memory: String(spec.memory ?? 16),
              });
            }}
          >
            <option value="">
              {specs.length === 0
                ? text("暂无规格（可手填）", "No specs (enter manually)")
                : resources
                  ? text("自定义（选择规格以填充）", "Custom (select a spec to fill)")
                  : text("选择规格以填充", "Select a spec to fill")}
            </option>
            {specs.map((spec, index) => (
              <option key={String(spec.id ?? index)} value={String(spec.id ?? index)}>
                {formatResourceSpecOption(spec, index)}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          <span id={priceLabelId} className="mb-1 block text-app-muted">{text("计费单价（元/小时）", "Hourly rate (CNY/hr)")}</span>
          {priceOptions.length > 0 ? (
            <Select
              aria-labelledby={priceLabelId}
              aria-describedby={priceDescription}
              aria-invalid={Boolean(priceTouched && priceError)}
              className={cn("w-full", priceTouched && priceError && "border-app-danger")}
              value={hasUnlistedPrice ? currentPriceOptionId : matchedPriceOptionId}
              onBlur={onPriceBlur}
              onChange={(event) => {
                const option = priceOptions.find((item) => item.id === event.target.value);
                if (option) onPriceChange(String(option.value));
              }}
            >
              <option value="" disabled>{text("请选择价格", "Select a price")}</option>
              {hasUnlistedPrice ? (
                <option value={currentPriceOptionId}>
                  {isOriginalPrice
                    ? text(`原实例单价：${price} 元/小时`, `Original instance rate: CNY ${price}/hr`)
                    : text(`当前手动单价：${price} 元/小时`, `Current manual rate: CNY ${price}/hr`)}
                </option>
              ) : null}
              {priceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              aria-labelledby={priceLabelId}
              aria-describedby={priceDescription}
              aria-invalid={Boolean(priceTouched && priceError)}
              className={cn("w-full", priceTouched && priceError && "border-app-danger")}
              min="0.01"
              step="any"
              type="number"
              value={price}
              onBlur={onPriceBlur}
              onChange={(event) => onPriceChange(event.target.value)}
              required
            />
          )}
          {hasUnlistedPrice ? (
            <span id={priceHintId} className="mt-1 block text-xs text-app-muted">
              {text("此单价不在当前价格列表中，请确认后保留或另选。", "This rate is not in the current price list. Verify it before keeping it, or select another rate.")}
            </span>
          ) : null}
          <FieldError id={priceErrorId} message={priceTouched ? priceError : undefined} />
        </label>
      </div>
      {loadHint ? <p className="text-xs text-app-muted">{loadHint}</p> : null}
    </div>
  );
}
