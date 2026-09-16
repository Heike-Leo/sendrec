export const EDITOR_CLIP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
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
  if (!(EDITOR_CLIP_SPEEDS as readonly number[]).includes(readClipSpeed(speed))) {
    throw new RangeError("Diese Clip-Geschwindigkeit wird nicht unterstützt.");
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

export function layoutEditorClips(clips: EditorClip[]) {
  let offset = 0;
  return clips.map((clip) => {
    const duration = Math.max(0, timelineDuration(clip.start, clip.end, clip.speed));
    const timelineStart = offset;
    offset += duration;
    return { clip, timelineStart, timelineEnd: offset, timelineDuration: duration,
      clipDuration: duration, sourceStart: clip.start, sourceEnd: clip.end, speed: readClipSpeed(clip.speed) };
  });
}

export function timelineClipPosition(clips: EditorClip[], time: number) {
  const layout = layoutEditorClips(clips);
  const total = layout.at(-1)?.timelineEnd ?? 0;
  const clamped = Math.max(0, Math.min(time, total));
  for (let index = 0; index < layout.length; index++) {
    const item = layout[index];
    // Keep the established seek ownership of an exact boundary (the preceding clip).
    if (clamped <= item.timelineEnd || index === layout.length - 1) {
      const timelineOffset = Math.max(0, Math.min(clamped - item.timelineStart, item.timelineDuration));
      return { clip: item.clip, index, timelineStart: item.timelineStart, timelineOffset,
        sourceTime: timelineOffsetToSourceTime(timelineOffset, item.sourceStart, item.speed) };
    }
  }
  return null;
}

export function clipSourceToTimelineTime(clip: EditorClip, timelineStart: number, sourceTime: number) {
  return timelineStart + Math.max(0, Math.min(timelineDuration(clip.start, clip.end, clip.speed),
    sourceTimeToTimelineOffset(sourceTime, clip.start, clip.speed)));
}

export function splitEditorClip(clip: EditorClip, sourceTime: number, leftId: string, rightId: string) {
  // Existing strict 100-ms distance from either edge, now in visible timeline seconds.
  if (sourceTime <= timelineOffsetToSourceTime(0.1, clip.start, clip.speed) ||
    sourceTime >= timelineOffsetToSourceTime(-0.1, clip.end, clip.speed)) return null;
  return [{ ...clip, id: leftId, end: sourceTime }, { ...clip, id: rightId, start: sourceTime }] as const;
}

export function canContinueClipSource(current: EditorClip, next: EditorClip): boolean {
  // Continuity concerns source coordinates, not speed or timeline duration.
  return current.sourceVideoId === next.sourceVideoId && Math.abs(next.start - current.end) < 1e-7;
}

export function clipFromStored(clip: StoredEditorClip): EditorClip {
  readClipSpeed(clip.speed);
  return { id: clip.id, sourceVideoId: clip.sourceId, start: clip.sourceStart, end: clip.sourceEnd, speed: clip.speed };
}

export function clipToStored(clip: EditorClip): StoredEditorClip {
  readClipSpeed(clip.speed);
  return { id: clip.id, sourceId: clip.sourceVideoId, sourceStart: clip.start, sourceEnd: clip.end,
    duration: timelineDuration(clip.start, clip.end, clip.speed), speed: clip.speed };
}
