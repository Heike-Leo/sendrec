import { apiFetch } from "../api/client";
import type { VoiceoverRecording } from "./editorVoiceoverRecorder";
import type { EditorVoiceoverSession } from "./editorVoiceoverSession";

export interface UploadedVoiceover {
  assetId: string;
  timelineStart: number;
  duration: number;
  mimeType: string;
  fileSize: number;
}

interface AudioAssetResponse {
  id: string;
  duration: number;
  mimeType: string;
  fileSize: number;
}

/** Transfer a completed take through the existing authenticated audio-asset API.
 * The server verifies media and duration; no timeline segment is created here.
 */
export async function uploadVoiceoverRecording(recording: VoiceoverRecording): Promise<UploadedVoiceover> {
  const timelineStart = recording.timelineStart;
  if (timelineStart === undefined || !Number.isFinite(timelineStart) || timelineStart < 0) {
    throw new Error("Voice-over-Aufnahme hat keine gültige Timeline-Startposition.");
  }
  if (!recording.blob.size || recording.byteSize !== recording.blob.size) {
    throw new Error("Voice-over-Aufnahme ist leer oder unvollständig.");
  }
  const mimeType = recording.mimeType || recording.blob.type;
  const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
  const format = mediaType === "audio/webm" ? "webm" : mediaType === "audio/mp4" ? "m4a" : null;
  if (!format) throw new Error("Nicht unterstütztes Voice-over-Aufnahmeformat.");

  const form = new FormData();
  form.append("file", new File([recording.blob], `voiceover.${format}`, { type: mimeType }));
  const asset = await apiFetch<AudioAssetResponse>("/api/audio-assets/", { method: "POST", body: form });
  if (!asset?.id || !Number.isFinite(asset.duration) || asset.duration <= 0) {
    throw new Error("Audio-Asset-Upload lieferte kein gültiges Ergebnis.");
  }
  return { assetId: asset.id, timelineStart, duration: asset.duration, mimeType: asset.mimeType, fileSize: asset.fileSize };
}

/** A cancelled/aborted session has no recording and therefore uploads nothing. */
export async function stopAndUploadVoiceover(session: Pick<EditorVoiceoverSession, "stop">): Promise<UploadedVoiceover | null> {
  const recording = await session.stop();
  return recording ? uploadVoiceoverRecording(recording) : null;
}
