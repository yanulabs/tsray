import { describe, expect, it } from "vitest";
import { calculateWorkerCount } from "../src/util/memory.js";

const GB = 1024 ** 3;

describe("memory-aware worker sizing", () => {
  it("reserves CI headroom across memory budgets", () => {
    expect(calculateWorkerCount(4 * GB, 56)).toBe(1);
    expect(calculateWorkerCount(7 * GB, 56)).toBe(2);
    expect(calculateWorkerCount(8 * GB, 56)).toBe(3);
    expect(calculateWorkerCount(16 * GB, 56)).toBe(7);
    expect(calculateWorkerCount(32 * GB, 56)).toBe(8);
  });

  it("caps large hosts at eight workers", () => {
    expect(calculateWorkerCount(34 * GB, 56)).toBe(8);
  });

  it("never selects zero workers and respects project count", () => {
    expect(calculateWorkerCount(GB, 56)).toBe(1);
    expect(calculateWorkerCount(34 * GB, 2)).toBe(2);
  });

  it("honors TSRAY_WORKERS as an explicit override", () => {
    expect(calculateWorkerCount(7 * GB, 56, 2)).toBe(2);
    expect(calculateWorkerCount(7 * GB, 56, 12)).toBe(12);
  });
});
