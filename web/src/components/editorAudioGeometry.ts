import { layoutEditorClips, readClipSpeed, requireSupportedClipSpeed, timelineDuration, type EditorClip } from "./editorClipTime";

export interface EditorAudioSegment {
  speed?: number;
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
  const ownSpeed = readClipSpeed(segment.speed);
  if (segment.geometryLinked !== true) return ownSpeed;
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

export function requireSupportedAudioSpeed(segment: EditorAudioSegment): void {
  requireSupportedClipSpeed(segment.speed);
}

// Only explicitly linked, geometrically matching audio follows a clip edit.
// Independent and legacy segments retain every field, including their own rate.
export function changeClipSpeed(clips: EditorClip[], audio: EditorAudioSegment[], id: string, speed: number) {
  requireSupportedClipSpeed(speed);
  const before = layoutEditorClips(clips);
  const nextClips = clips.map(clip => clip.id === id ? { ...clip, speed } : clip);
  const after = layoutEditorClips(nextClips);
  const nextAudio = audio.map(segment => {
    const matches = before.filter(item => item.clip.id === segment.sourceClipId);
    const item = matches[0];
    if (segment.geometryLinked !== true || matches.length !== 1 ||
      !audioGeometryMatchesClip(segment, item.clip, item.timelineStart)) return segment;
    return { ...segment, timelineStart: after.find(next => next.clip.id === item.clip.id)!.timelineStart };
  });
  const duration = after.at(-1)?.timelineEnd ?? 0;
  if (duration < 1) throw new Error("Die Timeline muss mindestens eine Sekunde lang bleiben.");
  let end = 0;
  for (const segment of [...nextAudio].sort((a, b) => a.timelineStart - b.timelineStart)) {
    const segmentEnd = segment.timelineStart + audioSegmentTimelineDuration(segment, nextClips);
    if (segmentEnd > duration + 0.001 || segment.timelineStart < end - 0.001) {
      throw new Error("Die Geschwindigkeit würde Audiosegmente überlappen lassen oder über das Videoende hinausschieben.");
    }
    end = segmentEnd;
  }
  return { clips: nextClips, audioSegments: nextAudio, duration };
}

// A visual draft uses the captured rate even after its geometry no longer matches the clip.
export function audioGeometryDraft(initial: EditorAudioSegment, edge: "move" | "start" | "end",
  deltaTime: number, speed: number, minimum = 0, maximum = Infinity): EditorAudioSegment {
  readClipSpeed(speed);
  const draft = { ...initial, geometryLinked: false, speed };
  if (edge === "move") return { ...draft, timelineStart: Math.max(minimum, Math.min(maximum, initial.timelineStart + deltaTime)) };
  if (edge === "end") return { ...draft, sourceEnd: Math.max(initial.sourceStart + 0.1 * speed,
    Math.min(initial.sourceEnd, initial.sourceEnd + deltaTime * speed)) };
  const delta = Math.max(0, Math.min((initial.sourceEnd - initial.sourceStart) / speed - 0.1, deltaTime));
  return { ...draft, sourceStart: initial.sourceStart + delta * speed, timelineStart: initial.timelineStart + delta };
}

export function commitAudioGeometry(initial: EditorAudioSegment, draft: EditorAudioSegment, speed: number): EditorAudioSegment {
  const changed = Math.abs(draft.timelineStart - initial.timelineStart) > 1e-6 ||
    Math.abs(draft.sourceStart - initial.sourceStart) > 1e-6 || Math.abs(draft.sourceEnd - initial.sourceEnd) > 1e-6;
  return changed ? { ...initial, timelineStart: draft.timelineStart, sourceStart: draft.sourceStart,
    sourceEnd: draft.sourceEnd, geometryLinked: false, speed: readClipSpeed(speed) } : initial;
}

export function audioSegmentTimelineDuration(segment: EditorAudioSegment, clips: EditorClip[]): number {
  return timelineDuration(segment.sourceStart, segment.sourceEnd, effectiveAudioSpeed(segment, clips));
}
