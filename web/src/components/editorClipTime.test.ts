import { describe, expect, it } from "vitest";
import { layoutEditorClips, timelineClipPosition, clipSourceToTimelineTime, splitEditorClip, canContinueClipSource, type EditorClip } from "./editorClipTime";
import { seekMediaTimelineOffset, applyMediaPlaybackSpeed } from "./editorMediaPlayback";
import { clipFromStored, clipToStored, readClipSpeed, requireSupportedClipSpeed, sourceDuration,
  sourceTimeToTimelineOffset, timelineDuration, timelineOffsetToSourceTime } from "./editorClipTime";

describe("clip speed preparation", () => {
  it.each([0.6, 0.9, 1.1, 1.9])("rejects a non-menu speed %s in the editor", speed => {
    expect(() => requireSupportedClipSpeed(speed)).toThrow("nicht unterstützt");
  });
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
    expect(() => requireSupportedClipSpeed(speed)).not.toThrow();
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
  it.each([undefined, 1, 1.5])("retains stored speed %s with timeline duration", speed => {
    const stored = JSON.parse(JSON.stringify({ id: "c", sourceId: "source", sourceStart: 3, sourceEnd: 13, duration: 10 / (speed ?? 1), speed }));
    const restored = clipFromStored(stored);
    expect(JSON.parse(JSON.stringify(clipToStored(restored)))).toEqual(stored);
    expect({ ...restored }.speed).toBe(speed);
  });
  it("retains arbitrary finite speeds within the planned range", () => {
    expect(readClipSpeed(1.1)).toBe(1.1);
  });
});

describe("speed-aware video timeline geometry (not editor activation)", () => {
  const clip = (speed = 1, start = 10, end = 20): EditorClip => ({ id: "a", sourceVideoId: "source", start, end, speed });

  it("lays out mixed speeds and multiple/repeated sources without rounding", () => {
    const clips = [clip(), { ...clip(2, 0, 10), id: "b" }, { ...clip(0.5, 20, 30), id: "c", sourceVideoId: "inserted" }];
    const layout = layoutEditorClips(clips);
    expect(layout.map(x => [x.timelineStart, x.timelineEnd, x.timelineDuration])).toEqual([[0, 10, 10], [10, 15, 5], [15, 35, 20]]);
    expect(layout.map(x => [x.sourceStart, x.sourceEnd, x.speed])).toEqual([[10, 20, 1], [0, 10, 2], [20, 30, 0.5]]);
    expect(timelineClipPosition(clips, 17)?.sourceTime).toBe(21);
    expect(timelineClipPosition(clips, 17)?.clip.id).toBe("c");
    const fractional = layoutEditorClips([clip(0.75, 0.1, 0.3), clip(1.25, 0.2, 0.7)]);
    expect(fractional[1].timelineEnd).toBe((0.3 - 0.1) / 0.75 + (0.7 - 0.2) / 1.25);
  });

  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])("maps seek and preview timeupdate at %s with no double speed", speed => {
    const c = clip(speed);
    const media = { currentTime: 0, playbackRate: 1, preservesPitch: false } as HTMLMediaElement;
    for (const time of [0, 0.123456789, 2, 10 / speed]) {
      const position = timelineClipPosition([c], time)!;
      seekMediaTimelineOffset(media, c.start, position.timelineOffset, c.speed);
      expect(media.currentTime).toBe(position.sourceTime);
      expect(media.currentTime).toBeCloseTo(10 + time * speed, 12);
      expect(clipSourceToTimelineTime(c, 0, media.currentTime)).toBeCloseTo(time, 12);
    }
    expect(clipSourceToTimelineTime(c, 3, 100)).toBe(3 + 10 / speed);
    expect(clipSourceToTimelineTime(c, 3, -1)).toBe(3);
  });

  it.each([
    [2, "source", 20, true], [1, "source", 20, true], [0.5, "source", 20, true],
    [2, "other", 20, false], [2, "source", 25, false],
  ] as const)("keeps source continuity separate from rate: %s / %s / %s", (speed, sourceVideoId, start, continuous) => {
    const first = clip(2);
    const next = { ...clip(speed, start, start + 10), id: "b", sourceVideoId };
    expect(canContinueClipSource(first, next)).toBe(continuous);
    const layout = layoutEditorClips([first, next]);
    expect(layout[1].timelineStart).toBe(5);
    expect(clipSourceToTimelineTime(first, 0, first.end)).toBe(5);
    expect(clipSourceToTimelineTime(next, 5, next.start)).toBe(5);
    const media = { currentTime: first.end, playbackRate: 2 } as HTMLMediaElement;
    applyMediaPlaybackSpeed(media, next.speed);
    if (!continuous) seekMediaTimelineOffset(media, next.start, 0, next.speed);
    expect(media.playbackRate).toBe(speed);
    expect(media.currentTime).toBe(next.start);
  });

  it.each([0.5, 2])("splits at timeline offset, preserves speed and 100-ms minimum at %s", speed => {
    const original = clip(speed);
    const position = timelineClipPosition([original], 2)!;
    const result = splitEditorClip(original, position.sourceTime, "left", "right")!;
    expect(result[0].end).toBe(10 + 2 * speed);
    expect(result[1].start).toBe(result[0].end);
    expect(result.map(c => c.speed)).toEqual([speed, speed]);
    expect(layoutEditorClips([...result]).map(x => x.timelineDuration)).toEqual([2, 10 / speed - 2]);
    expect(original).toEqual(clip(speed));
    expect(splitEditorClip(original, 10 + 0.09 * speed, "l", "r")).toBeNull();
    expect(splitEditorClip(original, 20 - 0.09 * speed, "l", "r")).toBeNull();
    expect(splitEditorClip(original, 10 + 0.11 * speed, "l", "r")).not.toBeNull();
  });

  it("keeps default 1x and exact-boundary seek ownership, clamps and handles an empty timeline", () => {
    const first = { ...clip(), speed: undefined };
    expect(layoutEditorClips([first])[0].timelineDuration).toBe(10);
    expect(timelineClipPosition([], 0)).toBeNull();
    expect(timelineClipPosition([first], -5)?.sourceTime).toBe(10);
    expect(timelineClipPosition([first], 50)?.sourceTime).toBe(20);
    expect(timelineClipPosition([first, { ...clip(2), id: "b" }], 10)?.clip.id).toBe("a");
  });
});
