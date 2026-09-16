// Preparation only: these time conversions do not drive playback or rendering yet.
export interface EditorClip {
  id: string;
  sourceVideoId: string;
  sourceTitle?: string;
  start: number;
  end: number;
  speed?: number;
}

export interface StoredEditorClip {
  id: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  speed?: number;
}

export function readClipSpeed(speed?: number): number {
  if (speed === undefined) return 1;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new RangeError("Clip-Geschwindigkeit muss endlich und zwischen 0.5 und 2.0 sein.");
  }
  return speed;
}

export function requireSupportedClipSpeed(speed?: number): void {
  if (readClipSpeed(speed) !== 1) {
    throw new RangeError("Clip-Geschwindigkeit ungleich 1.0 wird noch nicht unterstützt.");
  }
}

export function sourceDuration(start: number, end: number): number {
  return end - start;
}

export function timelineDuration(start: number, end: number, speed?: number): number {
  return sourceDuration(start, end) / readClipSpeed(speed);
}

export function sourceTimeToTimelineOffset(sourceTime: number, start: number, speed?: number): number {
  return (sourceTime - start) / readClipSpeed(speed);
}

export function timelineOffsetToSourceTime(offset: number, start: number, speed?: number): number {
  return start + offset * readClipSpeed(speed);
}

export function clipFromStored(clip: StoredEditorClip): EditorClip {
  readClipSpeed(clip.speed);
  return { id: clip.id, sourceVideoId: clip.sourceId, start: clip.sourceStart, end: clip.sourceEnd, speed: clip.speed };
}

export function clipToStored(clip: EditorClip): StoredEditorClip {
  readClipSpeed(clip.speed);
  // Keep the legacy duration contract until timeline/preview/render support speed together.
  return { id: clip.id, sourceId: clip.sourceVideoId, sourceStart: clip.start, sourceEnd: clip.end,
    duration: clip.end - clip.start, speed: clip.speed };
}
