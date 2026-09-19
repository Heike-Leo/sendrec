import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api/client";
import type { EditorAudioSegment } from "./editorAudioGeometry";
import { finishVoiceoverToTimeline, voiceoverSegment } from "./editorVoiceoverTimeline";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const clips = [{ id: "clip", sourceVideoId: "video", start: 0, end: 15 }];
const original: EditorAudioSegment = { id: "original", sourceClipId: "clip", sourceVideoId: "video",
  sourceStart: 0, sourceEnd: 15, timelineStart: 0, geometryLinked: true, volume: 0.4 };
const imported: EditorAudioSegment = { id: "imported", trackId: "voiceover-1", source: { kind: "audioAsset", assetId: "old" },
  sourceStart: 0, sourceEnd: 2, timelineStart: 7, geometryLinked: false, speed: 1, muted: true, volume: 0.7 };
const uploaded = { assetId: "new", timelineStart: 2, duration: 4, mimeType: "audio/webm", fileSize: 123 };
const recording = { blob: new Blob(["voice"], { type: "audio/webm" }), mimeType: "audio/webm", byteSize: 5,
  duration: 3.9, startTimestamp: 100, timelineStart: 2 };

describe("voice-over asset insertion into the regular audio timeline", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "new-segment" });
  });

  it("creates an independent segment using server duration and recorded start, without changing existing audio", () => {
    const previous = [original, imported];
    const segment = voiceoverSegment(uploaded, clips, previous);
    expect(segment).toEqual({ id: "new-segment", trackId: "voiceover-1", source: { kind: "audioAsset", assetId: "new" },
      sourceStart: 0, sourceEnd: 4, timelineStart: 2, geometryLinked: false, speed: 1, muted: false, volume: 1 });
    expect(previous).toEqual([original, imported]);
  });

  it("commits after successful upload as one undoable audio edit", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "new", duration: 4, mimeType: "audio/webm", fileSize: 5 });
    let segments = [original, imported];
    const history: EditorAudioSegment[][] = [];
    const editor = { rememberEditorState: vi.fn(() => {
      history.push(segments.map(item => ({ ...item })));
    }), setAudioSegments: vi.fn((next: EditorAudioSegment[]) => {
      segments = next;
    }) };
    const result = await finishVoiceoverToTimeline({ stop: vi.fn().mockResolvedValue(recording) }, clips, segments, editor);
    expect(result).toMatchObject({ id: "new-segment", trackId: "voiceover-1", timelineStart: 2, sourceEnd: 4 });
    expect(editor.rememberEditorState).toHaveBeenCalledOnce();
    expect(editor.setAudioSegments).toHaveBeenCalledOnce();
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(original);
    expect(segments[1]).toEqual(imported);
    segments = history.pop()!; // Editor undo restores its pre-insertion snapshot.
    expect(segments).toEqual([original, imported]);
  });

  it("does not commit when recording is cancelled or upload fails", async () => {
    const editor = { rememberEditorState: vi.fn(), setAudioSegments: vi.fn() };
    expect(await finishVoiceoverToTimeline({ stop: vi.fn().mockResolvedValue(null) }, clips, [original], editor)).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    vi.mocked(apiFetch).mockRejectedValue(new Error("network"));
    await expect(finishVoiceoverToTimeline({ stop: vi.fn().mockResolvedValue(recording) }, clips, [original], editor))
      .rejects.toThrow("network");
    expect(editor.rememberEditorState).not.toHaveBeenCalled();
    expect(editor.setAudioSegments).not.toHaveBeenCalled();
  });

  it("rejects overlap, duplicate identity and out-of-bounds duration before commit", () => {
    expect(() => voiceoverSegment({ ...uploaded, timelineStart: 8 }, clips, [imported])).toThrow("überlappen");
    expect(() => voiceoverSegment(uploaded, clips, [{ ...imported, id: "new-segment" }])).toThrow("ID");
    expect(() => voiceoverSegment({ ...uploaded, timelineStart: 13 }, clips, [])).toThrow("außerhalb");
  });

  it("never commits an invalid uploaded segment", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "new", duration: 4, mimeType: "audio/webm", fileSize: 5 });
    const editor = { rememberEditorState: vi.fn(), setAudioSegments: vi.fn() };
    await expect(finishVoiceoverToTimeline({ stop: vi.fn().mockResolvedValue(recording) }, clips,
      [{ ...imported, timelineStart: 3 }], editor)).rejects.toThrow("überlappen");
    expect(editor.rememberEditorState).not.toHaveBeenCalled();
    expect(editor.setAudioSegments).not.toHaveBeenCalled();
  });
});
