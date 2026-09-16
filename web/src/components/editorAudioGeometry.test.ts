import { describe, expect, it } from "vitest";
import { audioGeometryMatchesClip, type EditorAudioSegment } from "./editorAudioGeometry";
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
