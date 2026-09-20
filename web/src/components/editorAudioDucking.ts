import { audioSegmentTimelineDuration, audioTrackId, type EditorAudioSegment } from "./editorAudioGeometry";
import type { EditorClip } from "./editorClipTime";

export const ORIGINAL_AUDIO_DUCKING_GAIN = 0.25;
export const AUDIO_DUCKING_FADE_SECONDS = 0.2;

// Pure preparation only: not connected to preview, persistence or render.
// Returns a multiplier for the original segment's volume, not a replacement.
// Call with the editor's validated segments and current clip geometry.
export function originalAudioDuckingGain(
  segments: readonly EditorAudioSegment[],
  clips: EditorClip[],
  timelineTime: number,
): number {
  if (!Number.isFinite(timelineTime)) return 1;

  const windows = segments
    .filter(segment => audioTrackId(segment) === "voiceover-1" && segment.muted !== true)
    .map(segment => ({
      start: segment.timelineStart,
      end: segment.timelineStart + audioSegmentTimelineDuration(segment, clips),
    }))
    .filter(window => window.end > window.start)
    .sort((a, b) => a.start - b.start);

  // Merge touching/overlapping windows before fading: splits must not cause a
  // volume bump, and simultaneous voice-overs must never multiply attenuation.
  const merged: typeof windows = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  const active = merged.find(window => timelineTime >= window.start && timelineTime < window.end);
  if (!active) return 1;

  // Both fades stay inside the active range; before/after it gain is exactly 1.
  // Short windows shorten both fades equally and reach the target at midpoint.
  const fade = Math.min(AUDIO_DUCKING_FADE_SECONDS, (active.end - active.start) / 2);
  const depth = Math.min(1, (timelineTime - active.start) / fade, (active.end - timelineTime) / fade);
  return 1 - (1 - ORIGINAL_AUDIO_DUCKING_GAIN) * depth;
}
