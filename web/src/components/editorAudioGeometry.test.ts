import { describe, expect, it, vi } from "vitest";
import { audioGeometryMatchesClip, effectiveAudioSpeed, audioSegmentTimelineDuration, type EditorAudioSegment } from "./editorAudioGeometry";
import { EditorAudioPreview } from "./editorAudioPreview";
import { coupledAudio, isAudioStillCoupled } from "./VideoEditorModal";
import { splitEditorClip } from "./editorClipTime";

const clip = { id: "c", sourceVideoId: "v", start: 2, end: 12 };
const segment: EditorAudioSegment = { id: "a", sourceClipId: "c", sourceVideoId: "v", sourceStart: 2, sourceEnd: 12, timelineStart: 0 };

describe("audio geometry metadata", () => {
  it.each([true, false, undefined])("compares geometry independently of intent, mute and gain: %s", geometryLinked => {
    const audio = { ...segment, geometryLinked, muted: true, volume: 0.5 };
    expect(audioGeometryMatchesClip(audio, clip, 0)).toBe(true);
    expect(isAudioStillCoupled([clip], [audio])).toBe(false);
    expect(audioGeometryMatchesClip({ ...audio, timelineStart: 1e-8 }, clip, 0)).toBe(true);
  });
  it.each([{ sourceClipId: "other" }, { sourceVideoId: "other" }, { sourceStart: 3 },
    { sourceEnd: 11 }, { timelineStart: 1 }, { timelineStart: NaN }])("rejects mismatched geometry %j", change => {
    expect(audioGeometryMatchesClip({ ...segment, ...change }, clip, 0)).toBe(false);
  });
  it("marks new original audio and split successors, using clip IDs and source boundaries", () => {
    const original = coupledAudio([clip]);
    expect(original[0].geometryLinked).toBe(true);
    const split = splitEditorClip(clip, 6, "left", "right")!;
    const audio = coupledAudio([...split], original);
    expect(audio.map(a => [a.sourceClipId, a.sourceStart, a.sourceEnd, a.timelineStart, a.geometryLinked]))
      .toEqual([["left", 2, 6, 0, true], ["right", 6, 12, 4, true]]);
    expect(audio[0].id).not.toBe(audio[1].id);
  });
  it.each([true, false, undefined])("preserves surviving segments' linkage through regeneration: %s", geometryLinked => {
    const original = { ...segment, geometryLinked };
    const regenerated = coupledAudio([clip], [original]);
    expect(regenerated[0].geometryLinked).toBe(geometryLinked);
    const stored = JSON.parse(JSON.stringify(regenerated))[0];
    expect(Object.hasOwn(stored, "geometryLinked")).toBe(geometryLinked !== undefined);
  });
});

describe("linked audio speed", () => {
  it.each([undefined, 0.5, 0.75, 1, 1.25, 1.5, 2])("derives rate and duration without rounding for %s", speed => {
    const clips = [{ ...clip, speed }];
    const audio = coupledAudio(clips)[0];
    expect(effectiveAudioSpeed(audio, clips)).toBe(speed ?? 1);
    expect(audioSegmentTimelineDuration(audio, clips)).toBe(10 / (speed ?? 1));
    expect(audio.sourceStart).toBe(2); expect(audio.sourceEnd).toBe(12);
    expect(effectiveAudioSpeed({ ...audio, muted: true, volume: 0.5 }, clips)).toBe(speed ?? 1);
    expect(audio).not.toHaveProperty("speed");
  });
  it.each([false, undefined])("never inherits video rate for linkage %s", geometryLinked => {
    const clips = [{ ...clip, speed: 2 }];
    const audio = { ...segment, geometryLinked };
    expect(effectiveAudioSpeed(audio, clips)).toBe(1);
    expect(audioSegmentTimelineDuration(audio, clips)).toBe(10);
    expect(audio.timelineStart).toBe(0);
  });
  it.each([{ sourceClipId: "missing" }, { sourceVideoId: "other" }, { sourceStart: 3 },
    { sourceEnd: 11 }, { timelineStart: 1 }])("fails closed for contradictory references/geometry %j", change => {
    expect(effectiveAudioSpeed({ ...segment, geometryLinked: true, ...change }, [{ ...clip, speed: 2 }])).toBe(1);
  });
  it("rejects ambiguous IDs and invalid clip speed", () => {
    const audio = { ...segment, geometryLinked: true };
    expect(effectiveAudioSpeed(audio, [clip, clip])).toBe(1);
    expect(effectiveAudioSpeed(audio, [{ ...clip, speed: NaN }])).toBe(1);
  });
  it("uses clip IDs for repeated sources and mixed-speed, multi-source adjacency", () => {
    const clips = [{ ...clip, speed: 2 }, { ...clip, id: "b", speed: 0.5 }, { ...clip, id: "d", sourceVideoId: "other", speed: 1.5 }];
    const audio = coupledAudio(clips);
    expect(audio.map(s => s.timelineStart)).toEqual([0, 5, 25]);
    expect(audio.map(s => effectiveAudioSpeed(s, clips))).toEqual([2, 0.5, 1.5]);
    for (let i = 0; i < audio.length - 1; i++) {
      expect(audio[i].timelineStart + audioSegmentTimelineDuration(audio[i], clips)).toBe(audio[i + 1].timelineStart);
    }
    const moved = { ...audio[0], geometryLinked: false, timelineStart: 1 };
    expect(effectiveAudioSpeed(moved, clips)).toBe(1); // 23d.4 must freeze pre-detachment speed.
  });
  it.each([2, 0.5])("splits video and linked source audio without gaps at %s", speed => {
    const original = { ...clip, start: 0, end: 10, speed };
    const split = [...splitEditorClip(original, 2 * speed, "left", "right")!];
    const audio = coupledAudio(split);
    expect(audio.map(s => s.geometryLinked)).toEqual([true, true]);
    expect(audio.map(s => s.sourceClipId)).toEqual(["left", "right"]);
    expect(audio[0].sourceEnd).toBe(2 * speed);
    expect(audio[1].sourceStart).toBe(audio[0].sourceEnd);
    expect(audioSegmentTimelineDuration(audio[0], split)).toBe(2);
    expect(audio[1].timelineStart).toBe(2);
    expect(audio[1].timelineStart + audioSegmentTimelineDuration(audio[1], split)).toBe(10 / speed);
  });

  it.each([2, 0.5])("feeds effective rate to real preview controller at %s, including seek/end/drift/gain", async speed => {
    const clips = [{ ...clip, speed }];
    let segments = coupledAudio(clips).map(s => ({ ...s, volume: 0.4, muted: false }));
    const audio = document.createElement("audio");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    Object.defineProperties(audio, {
      readyState: { configurable: true, get: () => 4 },
      paused: { configurable: true, get: () => false },
      preservesPitch: { configurable: true, writable: true, value: false },
    });
    const play = vi.spyOn(audio, "play").mockResolvedValue();
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    vi.spyOn(audio, "load").mockImplementation(() => {});
    const error = vi.fn();
    let time = 1;
    const preview = new EditorAudioPreview(audio, { segments: () => segments, time: () => time,
      url: () => "https://media.example/v.mp4", error, canCheckDrift: () => true,
      speed: s => effectiveAudioSpeed(segments.find(item => item.id === s.id)!, clips) });
    try {
      preview.sync(true); audio.dispatchEvent(new Event("loadedmetadata"));
      expect(audio.playbackRate).toBe(speed);
      expect(audio.currentTime).toBe(2 + speed);
      expect(audio.preservesPitch).toBe(true); expect(audio.volume).toBe(0.4);
      time = 2; preview.sync(false, true);
      expect(audio.currentTime).toBe(2 + 2 * speed);
      preview.sync(true); audio.dispatchEvent(new Event("playing"));
      audio.currentTime += 0.3 * speed;
      preview.checkDrift(2000);
      expect(audio.currentTime).toBe(2 + 2 * speed);
      segments = segments.map(s => ({ ...s, muted: true }));
      play.mockClear(); preview.sync(true);
      expect(play).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalled();
      expect(effectiveAudioSpeed(segments[0], clips)).toBe(speed);
      segments = segments.map(s => ({ ...s, muted: false }));
      time = 10 / speed; play.mockClear(); preview.sync(true);
      expect(play).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalledWith(expect.any(String));
    } finally { await Promise.resolve(); preview.dispose(); vi.restoreAllMocks(); }
  });
});
