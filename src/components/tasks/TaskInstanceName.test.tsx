import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

function renderName(name: string, taskId?: string | number) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <TaskInstanceName name={name} taskId={taskId} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("TaskInstanceName", () => {
  it("renders plain task names as static text", () => {
    renderName("manual-task");

    expect(screen.getByText("manual-task")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links plain task names to the detail page when taskId is provided", () => {
    renderName("manual-task", 42);
    expect(screen.getByRole("link", { name: /View details for manual-task/ })).toHaveAttribute("href", "/tasks/42");
  });

  it("collapses template prefix by default and toggles full name", () => {
    const marker = getTaskTemplateMarker(baseTemplate);
    const fullName = `dev-${marker}-202605230800-1`;
    const suffix = "202605230800-1";

    renderName(fullName, 7);

    const toggle = screen.getByRole("button", { name: /Expand full name \(template prefix: dev\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: /View details for/ })).toHaveAttribute("href", "/tasks/7");
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
    expect(screen.getByText("202605230800")).toBeInTheDocument();
  });
});
