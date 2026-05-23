import { describe, expect, it } from "vitest";

import { buildMonitorDashboardUrl, getTaskPodName } from "./monitor-dashboard";

describe("monitor dashboard links", () => {
  it("uses task description as the grafana pod variable", () => {
    const url = buildMonitorDashboardUrl({
      id: 45568,
      task_id: 45568,
      name: "202605222101",
      description: "common-5rw2qjii",
    });

    expect(url).toBe(
      "http://116.172.93.164:33000/d/da7c4fef-70c7-43eb-8103-31b7d283ca9f/pod-board?orgId=1&var-pod=common-5rw2qjii",
    );
  });

  it("falls back when description is absent", () => {
    expect(getTaskPodName({ id: 45568, name: "202605222101" })).toBe("202605222101");
  });
});
