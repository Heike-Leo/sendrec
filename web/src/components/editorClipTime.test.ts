import { describe, expect, it } from "vitest";
import { clipFromStored, clipToStored, readClipSpeed, requireSupportedClipSpeed, sourceDuration,
  sourceTimeToTimelineOffset, timelineDuration, timelineOffsetToSourceTime } from "./editorClipTime";

describe("clip speed preparation", () => {
  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])("maps source and timeline at %s without rounding", speed => {
    expect(readClipSpeed(speed)).toBe(speed);
    expect(sourceDuration(3, 13)).toBe(10);
    expect(timelineDuration(3, 13, speed)).toBe(10 / speed);
    expect(sourceTimeToTimelineOffset(3, 3, speed)).toBe(0);
    expect(sourceTimeToTimelineOffset(13, 3, speed)).toBe(10 / speed);
    for (const source of [3, 3.123456789, 10.333333333, 13]) {
      expect(timelineOffsetToSourceTime(sourceTimeToTimelineOffset(source, 3, speed), 3, speed)).toBeCloseTo(source, 12);
    }
    expect(timelineDuration(0.1, 0.3, speed)).toBe((0.3 - 0.1) / speed);
    expect(timelineDuration(3, 3, speed)).toBe(0);
    if (speed === 1) expect(() => requireSupportedClipSpeed(speed)).not.toThrow();
    else expect(() => requireSupportedClipSpeed(speed)).toThrow("noch nicht unterstützt");
  });
  it("defaults only missing speed to one", () => {
    expect(readClipSpeed()).toBe(1);
    expect(timelineDuration(0, 10)).toBe(10);
    expect(() => requireSupportedClipSpeed()).not.toThrow();
  });
  it.each([0, -1, NaN, Infinity, -Infinity, 0.49, 2.01])("rejects invalid speed %s", speed => {
    expect(() => readClipSpeed(speed)).toThrow(RangeError);
    expect(() => timelineDuration(0, 10, speed)).toThrow(RangeError);
    expect(() => requireSupportedClipSpeed(speed)).toThrow(RangeError);
  });
  it.each([undefined, 1, 1.5])("retains stored speed %s without activating duration changes", speed => {
    const stored = JSON.parse(JSON.stringify({ id: "c", sourceId: "source", sourceStart: 3, sourceEnd: 13, duration: 10, speed }));
    const restored = clipFromStored(stored);
    expect(JSON.parse(JSON.stringify(clipToStored(restored)))).toEqual(stored);
    expect({ ...restored }.speed).toBe(speed);
  });
  it("retains arbitrary finite speeds within the planned range", () => {
    expect(readClipSpeed(1.1)).toBe(1.1);
  });
});
