import { describe, expect, it } from "vitest";
import { calculateWorkerCount } from "../src/util/memory.js";

const GB = 1024 ** 3;

describe("memory-aware worker sizing", () => {
  it("caps a 7 GB CI runner at four workers", () => {
    expect(calculateWorkerCount(7 * GB, 56)).toBe(4);
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
