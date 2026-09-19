import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api/client";
import type { VoiceoverRecording } from "./editorVoiceoverRecorder";
import { stopAndUploadVoiceover, uploadVoiceoverRecording } from "./editorVoiceoverUpload";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

function recording(mimeType = "audio/webm;codecs=opus"): VoiceoverRecording {
  const blob = new Blob(["recorded bytes"], { type: mimeType });
  return { blob, mimeType, byteSize: blob.size, duration: 3.9, startTimestamp: 100, timelineStart: 2 };
}

describe("completed voice-over audio asset upload", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["audio/webm;codecs=opus", "voiceover.webm"],
    ["audio/mp4;codecs=mp4a.40.2", "voiceover.m4a"],
  ])("uploads %s through the existing authenticated asset client", async (mimeType, filename) => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "asset-1", duration: 4.02, mimeType, fileSize: 14 });
    const result = await uploadVoiceoverRecording(recording(mimeType));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(path).toBe("/api/audio-assets/");
    expect(options).toMatchObject({ method: "POST" });
    expect(options?.headers).toBeUndefined(); // apiFetch owns auth, org and multipart boundaries.
    const file = (options?.body as FormData).get("file") as File;
    expect(file.name).toBe(filename);
    expect(file.type).toBe(mimeType);
    expect(await file.text()).toBe("recorded bytes");
    expect(result).toEqual({ assetId: "asset-1", timelineStart: 2, duration: 4.02, mimeType, fileSize: 14 });
    expect(result).not.toHaveProperty("audioSegments");
  });

  it("preserves session start and uploads only after stop returns final recording", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "asset-2", duration: 4, mimeType: "audio/webm", fileSize: 14 });
    const session = { stop: vi.fn().mockResolvedValue(recording()) };
    const result = await stopAndUploadVoiceover(session);
    expect(session.stop).toHaveBeenCalledOnce();
    expect(result?.timelineStart).toBe(2);
    expect(result?.assetId).toBe("asset-2");
  });

  it("does not upload an aborted session or failed stop", async () => {
    expect(await stopAndUploadVoiceover({ stop: vi.fn().mockResolvedValue(null) })).toBeNull();
    await expect(stopAndUploadVoiceover({ stop: vi.fn().mockRejectedValue(new Error("recorder failed")) })).rejects.toThrow("recorder failed");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("propagates upload errors without creating a timeline segment", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("upload failed"));
    await expect(uploadVoiceoverRecording(recording())).rejects.toThrow("upload failed");
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("rejects incomplete recordings before the upload", async () => {
    await expect(uploadVoiceoverRecording({ ...recording(), timelineStart: undefined })).rejects.toThrow("Timeline");
    await expect(uploadVoiceoverRecording({ ...recording(), byteSize: 0 })).rejects.toThrow("unvollständig");
    await expect(uploadVoiceoverRecording(recording("audio/ogg"))).rejects.toThrow("Aufnahmeformat");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects an incomplete asset response instead of claiming success", async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    await expect(uploadVoiceoverRecording(recording())).rejects.toThrow("kein gültiges Ergebnis");
  });
});
