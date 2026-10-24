import { Monitor, Moon, Sun } from "lucide-react";

import { SegmentedControl } from "./ui";
import { useI18n } from "../lib/i18n";
import { themePreferences, type ThemePreference } from "../lib/theme";
import { useTheme } from "../lib/use-theme";

export function ThemeSwitch({ showLabels = false }: { showLabels?: boolean }) {
  const { text } = useI18n();
  const { preference, setPreference } = useTheme();
  const labels: Record<ThemePreference, string> = {
    light: text("浅色", "Light"),
    dark: text("深色", "Dark"),
    system: text("跟随系统", "System"),
  };
  const icons = { light: Sun, dark: Moon, system: Monitor } as const;

  return (
    <SegmentedControl<ThemePreference>
      label={text("界面主题", "Theme")}
      value={preference}
      options={themePreferences.map((item) => {
        const Icon = icons[item];
        return {
          value: item,
          ariaLabel: showLabels ? undefined : labels[item],
          title: labels[item],
          label: (
            <>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {showLabels ? labels[item] : null}
            </>
          ),
        };
      })}
      optionClassName={showLabels ? undefined : "w-8 px-0"}
      onChange={(next) => setPreference(next)}
    />
  );
}
