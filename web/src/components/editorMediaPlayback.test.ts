import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMediaPlaybackSpeed, mediaDriftInTimelineSeconds, seekMediaTimelineOffset } from "./editorMediaPlayback";

afterEach(() => vi.restoreAllMocks());

describe("prepared video playback speed", () => {
  it.each([undefined, 1, 0.5, 0.75, 1.25, 1.5, 2])("applies %s and preserves pitch without changing transport", speed => {
    const video = document.createElement("video");
    video.src = "https://media.example/source.mp4";
    video.currentTime = 3;
    video.playbackRate = 1.75;
    Object.defineProperty(video, "preservesPitch", { configurable: true, writable: true, value: false });
    const load = vi.spyOn(video, "load");
    const play = vi.spyOn(video, "play");
    applyMediaPlaybackSpeed(video, speed);
    expect(video.playbackRate).toBe(speed ?? 1);
    expect(video.preservesPitch).toBe(true);
    expect(video.currentTime).toBe(3);
    expect(load).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("updates consecutive clips of the same source without reload and resets on state restore", () => {
    const video = document.createElement("video");
    video.src = "https://media.example/source.mp4";
    const load = vi.spyOn(video, "load");
    for (const speed of [0.5, 2, 0.75, 1]) {
      applyMediaPlaybackSpeed(video, speed);
      expect(video.playbackRate).toBe(speed);
      expect(video.src).toBe("https://media.example/source.mp4");
    }
    expect(load).not.toHaveBeenCalled();
    const rate = vi.spyOn(video, "playbackRate", "set");
    applyMediaPlaybackSpeed(video, 1);
    expect(rate).not.toHaveBeenCalled();
  });

  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])("seeks to the source time for %s", speed => {
    const video = document.createElement("video");
    seekMediaTimelineOffset(video, 3, 2, speed);
    expect(video.currentTime).toBe(3 + 2 * speed);
    expect(video.playbackRate).toBe(speed);
    expect(mediaDriftInTimelineSeconds(video.currentTime + 0.15 * speed, video.currentTime, speed)).toBeCloseTo(0.15);
  });

  it("does not add pitch polyfills on unsupported media", () => {
    const media = { playbackRate: 1 };
    applyMediaPlaybackSpeed(media as HTMLMediaElement, 2);
    expect(media).toEqual({ playbackRate: 2 });
  });

  it.each([0, -1, NaN, Infinity, 3])("rejects %s before mutating the media element", speed => {
    const video = document.createElement("video");
    expect(() => applyMediaPlaybackSpeed(video, speed)).toThrow(RangeError);
    expect(video.playbackRate).toBe(1);
  });
});
