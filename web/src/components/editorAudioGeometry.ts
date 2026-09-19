import { layoutEditorClips, readClipSpeed, requireSupportedClipSpeed, timelineDuration, type EditorClip } from "./editorClipTime";

export type EditorAudioSource =
  | { kind: "video"; videoId: string; clipId: string }
  | { kind: "audioAsset"; assetId: string };

export interface EditorAudioSegment {
  trackId?: string;
  source?: EditorAudioSource;
  speed?: number;
  geometryLinked?: boolean;
  volume?: number;
  muted?: boolean;
  id: string;
  sourceClipId?: string;
  sourceVideoId?: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
}

export const ORIGINAL_AUDIO_TRACK = "original";
export const AUDIO_TRACK_ORDER = [ORIGINAL_AUDIO_TRACK, "voiceover-1"] as const;
export type EditorAudioTrackId = typeof AUDIO_TRACK_ORDER[number];
export function audioTrackId(segment: EditorAudioSegment): string {
  if (segment.trackId !== undefined && !AUDIO_TRACK_ORDER.some(id => id === segment.trackId)) throw new Error("Ungültige Audiospur: erlaubt sind original und voiceover-1.");
  return segment.trackId ?? ORIGINAL_AUDIO_TRACK;
}

// Stable track order and segment order; never mutate persisted data or materialize defaults.
export function groupAudioSegments(segments: EditorAudioSegment[]) {
  const groups = new Map<string, EditorAudioSegment[]>();
  for (const segment of segments) {
    const track = audioTrackId(segment);
    const items = groups.get(track) ?? [];
    items.push(segment);
    groups.set(track, items);
  }
  return AUDIO_TRACK_ORDER.filter(track => groups.has(track)).map(trackId => ({
    trackId, segments: groups.get(trackId)!,
  }));
}

export function audioSource(segment: EditorAudioSegment): EditorAudioSource {
  const source = segment.source;
  const valid = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;
  if (source !== undefined) {
    if (segment.sourceClipId !== undefined || segment.sourceVideoId !== undefined) throw new Error("Mehrdeutige Audioquelle.");
    if (source === null || typeof source !== "object") throw new Error("Ungültige Audioquelle.");
    if (source.kind === "video" && valid(source.videoId) && valid(source.clipId) && !("assetId" in source)) return source;
    if (source.kind === "audioAsset" && valid(source.assetId) && !("videoId" in source) && !("clipId" in source) && segment.geometryLinked !== true) return source;
    throw new Error("Ungültige Audioquelle.");
  }
  if (!valid(segment.sourceClipId) || !valid(segment.sourceVideoId)) throw new Error("Audioquelle fehlt.");
  return { kind: "video", videoId: segment.sourceVideoId, clipId: segment.sourceClipId };
}

export function videoAudioSource(segment: EditorAudioSegment) {
  const source = audioSource(segment);
  return source.kind === "video" ? source : undefined;
}

export function audioTrackNeighbours(segments: EditorAudioSegment[], segment: EditorAudioSegment) {
  return segments.filter(item => audioTrackId(item) === audioTrackId(segment)).sort((a, b) => a.timelineStart - b.timelineStart);
}

export function cloneAudioSegment(segment: EditorAudioSegment): EditorAudioSegment {
  return { ...segment, ...(segment.source ? { source: { ...segment.source } } : {}) };
}

export function validateAudioSegments(segments: EditorAudioSegment[], clips: EditorClip[]): void {
  const ids = new Set<string>();
  const ends = new Map<string, number>();
  for (const segment of [...segments].sort((a,b) => a.timelineStart - b.timelineStart)) {
    audioSource(segment);
    const track = audioTrackId(segment);
    if (!segment.id.trim() || ids.has(segment.id)) throw new Error("Ungültige Audiosegment-ID.");
    ids.add(segment.id);
    if (![segment.sourceStart, segment.sourceEnd, segment.timelineStart].every(Number.isFinite) || segment.sourceStart < 0 || segment.sourceEnd < segment.sourceStart || segment.timelineStart < 0) throw new Error("Ungültige Audiozeiten.");
    const duration = audioSegmentTimelineDuration(segment, clips);
    if (duration === 0) continue;
    if (segment.timelineStart < (ends.get(track) ?? 0) - 0.001) throw new Error("Audiosegmente derselben Spur dürfen sich nicht überlappen.");
    ends.set(track, segment.timelineStart + duration);
  }
}

// Storage supports future tracks/assets; the single-player engine must not silently omit them.
export function previewAudioSegments(segments: EditorAudioSegment[]) {
  if (new Set(segments.map(audioTrackId)).size > 1) throw new Error("Mehrspur-Audiovorschau wird noch nicht unterstützt.");
  return segments.map(segment => {
    const source = videoAudioSource(segment);
    if (!source) throw new Error("Audio-Asset-Vorschau wird noch nicht unterstützt.");
    return { ...segment, sourceVideoId: source.videoId };
  });
}

// Current geometry only, not linkage intent or permission to regenerate audio.
// The caller supplies the expected clip position; no audio speed is derived here.
export function audioGeometryMatchesClip(segment: EditorAudioSegment, clip: EditorClip, timelineStart: number): boolean {
  const sameTime = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6;
  const source = videoAudioSource(segment);
  return source?.clipId === clip.id && source.videoId === clip.sourceVideoId &&
    sameTime(segment.sourceStart, clip.start) && sameTime(segment.sourceEnd, clip.end) &&
    sameTime(segment.timelineStart, timelineStart);
}

export function effectiveAudioSpeed(segment: EditorAudioSegment, clips: EditorClip[]): number {
  const ownSpeed = readClipSpeed(segment.speed);
  if (segment.geometryLinked !== true) return ownSpeed;
  const clipId = videoAudioSource(segment)?.clipId;
  // A missing or ambiguous reference must never inherit a different source's rate.
  if (clips.filter(clip => clip.id === clipId).length !== 1) return 1;
  try {
    const item = layoutEditorClips(clips).find(item => item.clip.id === clipId)!;
    return audioGeometryMatchesClip(segment, item.clip, item.timelineStart) ? item.speed : 1;
  } catch {
    // Invalid clip speeds are rejected at editor load; fail closed for malformed internal input too.
    return 1;
  }
}

// A video-only split changes no timeline positions. Preserve independent and
// legacy audio verbatim; only replace explicitly linked audio of this clip.
export function splitLinkedAudioSegments(segments: EditorAudioSegment[], clip: EditorClip, timelineStart: number, left: EditorClip, right: EditorClip): EditorAudioSegment[] {
  const used = new Set(segments.map(segment => segment.id));
  return segments.flatMap(segment => {
    const source = videoAudioSource(segment);
    if (segment.geometryLinked !== true || source?.clipId !== clip.id) return [segment];
    if (!audioGeometryMatchesClip(segment, clip, timelineStart)) {
      throw new Error("Die gekoppelte Audiogeometrie stimmt nicht mit dem Videoclip überein.");
    }
    let rightId = `audio:${right.id}`;
    while (used.has(rightId)) rightId = `audio:${rightId}`;
    used.add(rightId);
    const withClip = (next: EditorClip) => segment.source?.kind === "video"
      ? { source: { ...segment.source, clipId: next.id } }
      : { sourceClipId: next.id };
    return [
      { ...segment, ...withClip(left), sourceEnd: left.end },
      { ...segment, ...withClip(right), id: rightId, sourceStart: right.start,
        timelineStart: segment.timelineStart + timelineDuration(left.start, left.end, left.speed) },
    ];
  });
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
    const matches = before.filter(item => item.clip.id === videoAudioSource(segment)?.clipId);
    const item = matches[0];
    if (segment.geometryLinked !== true || matches.length !== 1 ||
      !audioGeometryMatchesClip(segment, item.clip, item.timelineStart)) return segment;
    return { ...segment, timelineStart: after.find(next => next.clip.id === item.clip.id)!.timelineStart };
  });
  const duration = after.at(-1)?.timelineEnd ?? 0;
  if (duration < 1) throw new Error("Die Timeline muss mindestens eine Sekunde lang bleiben.");
  const ends = new Map<string, number>();
  for (const segment of [...nextAudio].sort((a, b) => a.timelineStart - b.timelineStart)) {
    const segmentEnd = segment.timelineStart + audioSegmentTimelineDuration(segment, nextClips);
    const track = audioTrackId(segment);
    if (segmentEnd > duration + 0.001 || segment.timelineStart < (ends.get(track) ?? 0) - 0.001) {
      throw new Error("Die Geschwindigkeit würde Audiosegmente überlappen lassen oder über das Videoende hinausschieben.");
    }
    ends.set(track, segmentEnd);
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
