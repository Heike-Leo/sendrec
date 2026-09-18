import { describe, expect, it } from "vitest";
import { audioSource, audioTrackId, audioTrackNeighbours, cloneAudioSegment, validateAudioSegments, previewAudioSegments, commitAudioGeometry, audioGeometryDraft, changeClipSpeed, type EditorAudioSegment } from "./editorAudioGeometry";

const clips = [{ id: "c", sourceVideoId: "v", start: 0, end: 10 }];
const original: EditorAudioSegment = { id: "a", sourceClipId: "c", sourceVideoId: "v", sourceStart: 0, sourceEnd: 2, timelineStart: 0 };
const voice: EditorAudioSegment = { id: "voice", trackId: "voice-over", source: { kind: "audioAsset", assetId: "asset" }, geometryLinked: false, speed: 1, sourceStart: 0, sourceEnd: 2, timelineStart: 0, muted: false, volume: 0.5 };

describe("future audio sources and tracks", () => {
  it("keeps absent legacy metadata absent through roundtrip", () => {
    expect(audioTrackId(original)).toBe("original");
    expect(audioSource(original)).toEqual({ kind: "video", videoId: "v", clipId: "c" });
    expect(JSON.parse(JSON.stringify(cloneAudioSegment(original)))).toEqual(original);
    expect(cloneAudioSegment(original)).not.toHaveProperty("trackId");
  });
  it("treats explicit original and legacy as the same track", () => {
    expect(() => validateAudioSegments([original, { ...original, id: "b", trackId: "original" }], clips)).toThrow("überlappen");
  });
  it("allows simultaneous different tracks, including voice-over without video IDs", () => {
    expect(() => validateAudioSegments([original, voice], clips)).not.toThrow();
    expect(voice).not.toHaveProperty("sourceClipId");
    expect(voice).not.toHaveProperty("sourceVideoId");
  });
  it("rejects overlaps within the voice-over track", () => {
    expect(() => validateAudioSegments([voice, { ...voice, id: "second", timelineStart: 1 }], clips)).toThrow("überlappen");
  });
  it("finds only same-track neighbours for movement", () => {
    const next = { ...original, id: "next", timelineStart: 5 };
    expect(audioTrackNeighbours([voice, next, original], original)).toEqual([original, next]);
    const moved = commitAudioGeometry(original, audioGeometryDraft(original, "move", 10, 1, 0, next.timelineStart - 2), 1);
    expect(moved.timelineStart).toBe(3);
  });
  it("preserves typed sources and track through trim/move, snapshots and JSON reload", () => {
    const snapshot = cloneAudioSegment(voice);
    const moved = commitAudioGeometry(voice, audioGeometryDraft(voice, "move", 3, 1), 1);
    const trimmed = commitAudioGeometry(moved, audioGeometryDraft(moved, "start", 0.5, 1), 1);
    expect(JSON.parse(JSON.stringify(trimmed))).toMatchObject({ trackId: "voice-over", source: voice.source, timelineStart: 3.5, sourceStart: 0.5, speed: 1, geometryLinked: false, volume: 0.5 });
    expect(snapshot).toEqual(voice);
    expect(snapshot.source).not.toBe(voice.source);
  });
  it("projects explicit video sources without rewriting persisted data", () => {
    const typed = { ...voice, source: { kind: "video" as const, clipId: "c", videoId: "v" } };
    expect(previewAudioSegments([typed])[0].sourceVideoId).toBe("v");
    expect(typed).not.toHaveProperty("sourceVideoId");
  });
  it("fails explicitly before unsupported preview instead of dropping sound", () => {
    expect(() => previewAudioSegments([voice])).toThrow("Audio-Asset");
    expect(() => previewAudioSegments([original, { ...original, id: "b", trackId: "other" }])).toThrow("Mehrspur");
  });
  it.each([
    { ...voice, geometryLinked: true },
    { ...voice, sourceVideoId: "fake" },
    { ...voice, trackId: " " },
    { ...voice, source: { kind: "audioAsset" as const, assetId: "" } },
  ])("rejects malformed/ambiguous contract %#", segment => {
    expect(() => validateAudioSegments([segment], clips)).toThrow();
  });
  it("speed validation does not treat other tracks as temporal neighbours", () => {
    expect(() => changeClipSpeed(clips, [original, voice], "c", 2)).not.toThrow();
  });
});
