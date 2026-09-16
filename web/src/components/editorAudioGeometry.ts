import { layoutEditorClips, timelineDuration, type EditorClip } from "./editorClipTime";

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

export function effectiveAudioSpeed(segment: EditorAudioSegment, clips: EditorClip[]): number {
  if (segment.geometryLinked !== true) return 1;
  // A missing or ambiguous reference must never inherit a different source's rate.
  if (clips.filter(clip => clip.id === segment.sourceClipId).length !== 1) return 1;
  try {
    const item = layoutEditorClips(clips).find(item => item.clip.id === segment.sourceClipId)!;
    return audioGeometryMatchesClip(segment, item.clip, item.timelineStart) ? item.speed : 1;
  } catch {
    // Invalid clip speeds are rejected at editor load; fail closed for malformed internal input too.
    return 1;
  }
}

export function audioSegmentTimelineDuration(segment: EditorAudioSegment, clips: EditorClip[]): number {
  return timelineDuration(segment.sourceStart, segment.sourceEnd, effectiveAudioSpeed(segment, clips));
}
