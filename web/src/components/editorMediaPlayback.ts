import { readClipSpeed, sourceTimeToTimelineOffset, timelineOffsetToSourceTime } from "./editorClipTime";

// Shared by both media engines. Never reloads, plays or pauses a source.
export function applyMediaPlaybackSpeed(media: HTMLMediaElement, speed?: number): void {
  const rate = readClipSpeed(speed);
  if (media.playbackRate !== rate) media.playbackRate = rate;
  if ("preservesPitch" in media) media.preservesPitch = true;
}

export function seekMediaTimelineOffset(media: HTMLMediaElement, sourceStart: number, offset: number, speed?: number): void {
  applyMediaPlaybackSpeed(media, speed);
  media.currentTime = timelineOffsetToSourceTime(offset, sourceStart, speed);
}

export function mediaDriftInTimelineSeconds(actualSourceTime: number, expectedSourceTime: number, speed?: number): number {
  return sourceTimeToTimelineOffset(actualSourceTime, expectedSourceTime, speed);
}
