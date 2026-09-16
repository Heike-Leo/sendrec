import type { EditorClip } from "./editorClipTime";

export interface EditorAudioSegment {
  geometryLinked?: boolean;
  volume?: number;
  muted?: boolean;
  id: string;
  sourceClipId: string;
  sourceVideoId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
}

// Current geometry only, not linkage intent or permission to regenerate audio.
// The caller supplies the expected clip position; no audio speed is derived here.
export function audioGeometryMatchesClip(segment: EditorAudioSegment, clip: EditorClip, timelineStart: number): boolean {
  const sameTime = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6;
  return segment.sourceClipId === clip.id && segment.sourceVideoId === clip.sourceVideoId &&
    sameTime(segment.sourceStart, clip.start) && sameTime(segment.sourceEnd, clip.end) &&
    sameTime(segment.timelineStart, timelineStart);
}
