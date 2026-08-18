import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

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
  onApplySpec: (values: { cpu: string; gpu: string; memory: string }) => void;
  priceError?: string;
  priceTouched?: boolean;
  onPriceBlur?: () => void;
};

export function ResourcePriceFields({
  price,
  onPriceChange,
  onApplySpec,
  priceError,
  priceTouched,
  onPriceBlur,
}: ResourcePriceFieldsProps) {
  const { text } = useI18n();
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

  useEffect(() => {
    if (price.trim()) return;
    if (priceOptions.length > 0) {
      onPriceChange(String(priceOptions[0].value));
      return;
    }
    if (!pricesQuery.isLoading && !pricesQuery.isError) {
      onPriceChange(DEFAULT_PRICE);
    }
  }, [onPriceChange, price, priceOptions, pricesQuery.isError, pricesQuery.isLoading]);

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
            value=""
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
            <option value="">{specs.length === 0 ? text("暂无规格（可手填）", "No specs (enter manually)") : text("选择规格以填充", "Select a spec to fill")}</option>
            {specs.map((spec, index) => (
              <option key={String(spec.id ?? index)} value={String(spec.id ?? index)}>
                {formatResourceSpecOption(spec, index)}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-app-muted">{text("价格", "Price")}</span>
          {priceOptions.length > 0 ? (
            <Select
              className={cn("w-full", priceTouched && priceError && "border-app-danger")}
              value={matchedPriceOptionId}
              onBlur={onPriceBlur}
              onChange={(event) => {
                const option = priceOptions.find((item) => item.id === event.target.value);
                if (option) onPriceChange(String(option.value));
              }}
            >
              <option value="">{text("请选择价格", "Select a price")}</option>
              {priceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
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
          <FieldError message={priceTouched ? priceError : undefined} />
        </label>
      </div>
      {loadHint ? <p className="text-xs text-app-muted">{loadHint}</p> : null}
    </div>
  );
}
