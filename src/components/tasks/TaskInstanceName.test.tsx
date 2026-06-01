import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "../../lib/i18n";
import { getTaskTemplateMarker } from "../../lib/task-templates";
import type { TaskTemplate } from "../../lib/types";
import { TaskInstanceName } from "./TaskInstanceName";

const baseTemplate: TaskTemplate = {
  id: "template-1",
  name: "开发环境",
  taskNamePrefix: "dev",
  batchCount: 2,
  imageId: "12",
  cpu: 4,
  gpu: 1,
  memory: 16,
  storagePath: "/alice/project",
  mountPath: "/home/ubuntu/alice",
  releaseCondition: 2,
  releaseAfterHours: 3,
  usageCount: 0,
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
};

function renderName(name: string) {
  return render(
    <I18nProvider>
      <TaskInstanceName name={name} />
    </I18nProvider>,
  );
}

describe("TaskInstanceName", () => {
  it("renders plain task names as static text", () => {
    renderName("manual-task");

    expect(screen.getByText("manual-task")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses template prefix by default and toggles full name", () => {
    const marker = getTaskTemplateMarker(baseTemplate);
    const fullName = `dev-${marker}-202605230800-1`;
    const suffix = `${marker}-202605230800-1`;

    renderName(fullName);

    const toggle = screen.getByRole("button", { name: /Expand full name \(template prefix: dev\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(suffix)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(fullName)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Collapse template prefix/ }));
    expect(screen.getByRole("button", { name: /Expand full name \(template prefix: dev\)/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText(suffix)).toBeInTheDocument();
  });

  it("collapses single-batch template names without a batch suffix", () => {
    const marker = getTaskTemplateMarker(baseTemplate);
    const fullName = `dev-${marker}-202605230800`;

    renderName(fullName);

    expect(screen.getByRole("button", { name: /Expand full name \(template prefix: dev\)/ })).toBeInTheDocument();
    expect(screen.getByText(`${marker}-202605230800`)).toBeInTheDocument();
  });
});
