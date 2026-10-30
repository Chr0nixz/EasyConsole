import { describe, expect, it } from "vitest";
import { sampleGpuIdle, type GpuIdleHistory } from "./idle-gpu";

describe("continuous GPU idle sampling", () => {
  it("waits for the complete window and checks all devices", () => {
    let history: GpuIdleHistory | undefined;
    for (let minute = 0; minute <= 30; minute++) {
      const result = sampleGpuIdle(history, [0, 2], minute * 60_000, 30 * 60_000);
      history = result.history;
      expect(result.evaluation).toBe(minute === 30 ? "idle" : "unknown");
    }
    expect(sampleGpuIdle(history, [0, 70], 31 * 60_000, 30 * 60_000).evaluation).toBe("active");
  });

  it("resets after a gap, unavailable data, device changes or backwards time", () => {
    const history = { devices: 2, samples: [{ at: 0, max: 0 }, { at: 60_000, max: 0 }] };
    expect(sampleGpuIdle(history, [0, 0], 5 * 60_000, 60_000).evaluation).toBe("unknown");
    expect(sampleGpuIdle(history, null, 120_000, 60_000).history).toBeUndefined();
    expect(sampleGpuIdle(history, [0], 120_000, 60_000).evaluation).toBe("unknown");
    expect(sampleGpuIdle(history, [0, 0], 0, 60_000).evaluation).toBe("unknown");
    for (const values of [[], [NaN], [-1], [101]]) expect(sampleGpuIdle(history, values, 120_000, 60_000).history).toBeUndefined();
  });

  it("bounds history while allowing an old busy sample to age out", () => {
    let history: GpuIdleHistory | undefined;
    for (let minute = 0; minute <= 100; minute++) {
      history = sampleGpuIdle(history, [minute === 0 ? 100 : 0], minute * 60_000, 30 * 60_000).history;
    }
    expect(history!.samples.length).toBeLessThanOrEqual(34);
    expect(sampleGpuIdle(history, [0], 101 * 60_000, 30 * 60_000).evaluation).toBe("idle");
  });
});
