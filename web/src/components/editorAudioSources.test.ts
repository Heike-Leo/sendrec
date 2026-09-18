import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api/client";
import { audioSourceKey, createAudioSourceResolver } from "./editorAudioSources";
import { groupAudioSegments } from "./editorAudioGeometry";
vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
import { audioSource, audioTrackId, audioTrackNeighbours, cloneAudioSegment, validateAudioSegments, previewAudioSegments, commitAudioGeometry, audioGeometryDraft, changeClipSpeed, type EditorAudioSegment } from "./editorAudioGeometry";

const clips = [{ id: "c", sourceVideoId: "v", start: 0, end: 10 }];
const original: EditorAudioSegment = { id: "a", sourceClipId: "c", sourceVideoId: "v", sourceStart: 0, sourceEnd: 2, timelineStart: 0 };
const voice: EditorAudioSegment = { id: "voice", trackId: "voiceover-1", source: { kind: "audioAsset", assetId: "asset" }, geometryLinked: false, speed: 1, sourceStart: 0, sourceEnd: 2, timelineStart: 0, muted: false, volume: 0.5 };

describe("future audio sources and tracks", () => {
  it("groups deterministically without rewriting defaults or segment order", () => {
    const second = { ...original, id: "second", timelineStart: 4 };
    const input = [voice, second, original];
    const snapshot = JSON.stringify(input);
    expect(groupAudioSegments(input)).toEqual([
      { trackId: "original", segments: [second, original] },
      { trackId: "voiceover-1", segments: [voice] },
    ]);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(groupAudioSegments([])).toEqual([]);
  });
  it.each(["voiceover-2", "voice-over", "unknown", "", " original"])("rejects unknown track %s and a third used track", trackId => {
    const third = { ...voice, id: "third", trackId };
    expect(() => groupAudioSegments([original, voice, third])).toThrow("Audiospur");
    expect(() => validateAudioSegments([original, voice, third], clips)).toThrow("Audiospur");
  });
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
    expect(JSON.parse(JSON.stringify(trimmed))).toMatchObject({ trackId: "voiceover-1", source: voice.source, timelineStart: 3.5, sourceStart: 0.5, speed: 1, geometryLinked: false, volume: 0.5 });
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
    expect(() => previewAudioSegments([original, { ...original, id: "b", trackId: "voiceover-1" }])).toThrow("Mehrspur");
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

describe("session audio source resolver", () => {
  beforeEach(() => vi.resetAllMocks());
  const asset = { kind: "audioAsset" as const, assetId: "same-uuid" };
  const video = { kind: "video" as const, videoId: "same-uuid", clipId: "clip" };

  it("uses typed noncolliding keys and preserves legacy video resolution", async () => {
    const loadVideoUrl = vi.fn<(id: string) => string | Promise<string>>().mockReturnValue("video-url");
    vi.mocked(apiFetch).mockResolvedValue({ url: "asset-url" });
    const resolver = createAudioSourceResolver({ loadVideoUrl });
    expect(audioSourceKey(video)).toBe("video:same-uuid");
    expect(audioSourceKey(asset)).toBe("audioAsset:same-uuid");
    expect(audioSourceKey({ ...video, clipId: "other-clip" })).toBe(audioSourceKey(video));
    expect(await resolver.resolve(audioSource(original))).toBe("video-url");
    expect(loadVideoUrl).toHaveBeenCalledWith("v");
    expect(await resolver.resolve(video)).toBe("video-url");
    expect(await resolver.resolve(asset)).toBe("asset-url");
    expect(apiFetch).toHaveBeenCalledWith("/api/audio-assets/same-uuid");
  });

  it("deduplicates asset requests, refreshes expiry and never touches peak cache", async () => {
    let time = 0;
    const resolver = createAudioSourceResolver({ loadVideoUrl: vi.fn(), now: () => time });
    vi.mocked(apiFetch).mockResolvedValueOnce({ url: "first" }).mockResolvedValueOnce({ url: "second" }).mockResolvedValueOnce({ url: "third" });
    const peaks = new Map([[audioSourceKey(asset), Promise.resolve({ min: [0], max: [1] })]]);
    const cachedPeaks = peaks.get(audioSourceKey(asset));
    expect(await Promise.all([resolver.resolve(asset), resolver.resolve(asset)])).toEqual(["first", "first"]);
    time = 269999;
    expect(await resolver.resolve(asset)).toBe("first");
    time = 270000;
    expect(await resolver.resolve(asset)).toBe("second");
    expect(await resolver.resolve(asset, { refresh: true })).toBe("third");
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(peaks.get(audioSourceKey(asset))).toBe(cachedPeaks);
  });

  it("does not let an obsolete in-flight URL overwrite an explicit refresh", async () => {
    let finish!: (value: { url: string }) => void;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ url: "new" });
    const resolver = createAudioSourceResolver({ loadVideoUrl: vi.fn() });
    const old = resolver.resolve(asset);
    expect(await resolver.resolve(asset, { refresh: true })).toBe("new");
    finish({ url: "old" });
    await old;
    expect(await resolver.resolve(asset)).toBe("new");
  });

  it("propagates unauthorized assets without a fallback or poisoned cache", async () => {
    const denied = new Error("404 foreign asset");
    vi.mocked(apiFetch).mockRejectedValueOnce(denied).mockResolvedValueOnce({ url: "authorized" });
    const loadVideoUrl = vi.fn();
    const resolver = createAudioSourceResolver({ loadVideoUrl });
    await expect(resolver.resolve(asset)).rejects.toBe(denied);
    expect(loadVideoUrl).not.toHaveBeenCalled();
    expect(await resolver.resolve(asset)).toBe("authorized");
  });

  it("rejects malformed references and missing URL responses", async () => {
    expect(() => audioSourceKey({ kind: "audioAsset", assetId: "" })).toThrow("Audioquelle");
    expect(() => audioSource({ ...voice, source: null as never })).toThrow("Audioquelle");
    const resolver = createAudioSourceResolver({ loadVideoUrl: vi.fn() });
    vi.mocked(apiFetch).mockResolvedValue({ downloadUrl: "wrong-response-shape" });
    await expect(resolver.resolve(asset)).rejects.toThrow("Audioquelle");
  });
});
