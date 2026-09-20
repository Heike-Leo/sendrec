import { describe, expect, it } from "vitest";
import { originalAudioDuckingGain, ORIGINAL_AUDIO_DUCKING_GAIN, AUDIO_DUCKING_FADE_SECONDS } from "./editorAudioDucking";
import type { EditorAudioSegment } from "./editorAudioGeometry";

const voice: EditorAudioSegment = {
  id: "voice", trackId: "voiceover-1", source: { kind: "audioAsset", assetId: "asset" },
  geometryLinked: false, speed: 1, sourceStart: 0, sourceEnd: 4, timelineStart: 2,
};
const gain = (time: number, segments: readonly EditorAudioSegment[] = [voice]) =>
  originalAudioDuckingGain(segments, [], time);

describe("prepared original audio ducking", () => {
  it("defines the V1 factor and transition centrally", () => {
    expect(ORIGINAL_AUDIO_DUCKING_GAIN).toBe(0.25);
    expect(AUDIO_DUCKING_FADE_SECONDS).toBe(0.2);
  });

  it.each([-1, 0, 1.999, 6, 7])("does not attenuate outside the voice-over at %s", time => {
    expect(gain(time)).toBe(1);
  });

  it("attenuates active voice-over once", () => {
    expect(gain(3)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
  });

  it("ignores muted voice-over, including its transitions", () => {
    for (const time of [2, 2.1, 3, 5.9, 6]) expect(gain(time, [{ ...voice, muted: true }])).toBe(1);
  });

  it.each([undefined, "original"])("does not trigger from the original track (%s)", trackId => {
    expect(gain(3, [{ ...voice, trackId }])).toBe(1);
  });

  it("handles no segments and zero-length segments", () => {
    expect(gain(3, [])).toBe(1);
    expect(gain(2, [{ ...voice, sourceEnd: 0 }])).toBe(1);
  });

  it("uses trimmed source duration rather than absolute source timestamps", () => {
    const trimmed = [{ ...voice, sourceStart: 10, sourceEnd: 12 }];
    expect(gain(1.9, trimmed)).toBe(1);
    expect(gain(3, trimmed)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
    expect(gain(3.9, trimmed)).toBeCloseTo(0.625);
    expect(gain(4, trimmed)).toBe(1);
  });

  it("moves both transition boundaries with timelineStart", () => {
    const moved = [{ ...voice, timelineStart: 8 }];
    expect(gain(3, moved)).toBe(1);
    expect(gain(8.1, moved)).toBeCloseTo(0.625);
    expect(gain(10, moved)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
    expect(gain(12, moved)).toBe(1);
  });

  it("uses existing effective-speed geometry for a linked video-source voice-over", () => {
    const clip = { id: "clip", sourceVideoId: "video", start: 10, end: 14, speed: 2 };
    const linked: EditorAudioSegment = { ...voice, source: { kind: "video", videoId: "video", clipId: "clip" },
      sourceStart: 10, sourceEnd: 14, timelineStart: 0, geometryLinked: true };
    expect(originalAudioDuckingGain([linked], [clip], 1)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
    expect(originalAudioDuckingGain([linked], [clip], 1.9)).toBeCloseTo(0.625);
    expect(originalAudioDuckingGain([linked], [clip], 2)).toBe(1);
  });

  it("merges unordered overlaps without stacking gain or fading at internal boundaries", () => {
    const overlap = [{ ...voice, id: "second", timelineStart: 4 }, voice, { ...voice, id: "duplicate" }];
    for (const time of [3, 4, 5.9, 6, 7]) expect(gain(time, overlap)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
    expect(gain(7.9, overlap)).toBeCloseTo(0.625);
    expect(gain(8, overlap)).toBe(1);
  });

  it("does not raise volume at the boundary of contiguous split segments", () => {
    const split = [{ ...voice, sourceEnd: 2 }, { ...voice, id: "right", sourceStart: 2, timelineStart: 4 }];
    for (const time of [3.9, 4, 4.1]) expect(gain(time, split)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
  });

  it("leaves a gap at normal gain and does not bridge it through muted segments", () => {
    const segments = [voice, { ...voice, id: "muted", timelineStart: 5, muted: true },
      { ...voice, id: "later", timelineStart: 8 }];
    expect(gain(5.9, segments)).toBeCloseTo(0.625);
    for (const time of [6, 7, 8]) expect(gain(time, segments)).toBe(1);
    expect(gain(8.1, segments)).toBeCloseTo(0.625);
  });

  it.each([[2, 1], [2.1, 0.625], [2.2, 0.25], [5.8, 0.25], [5.9, 0.625], [6, 1]])(
    "has continuous fade boundaries at %s seconds", (time, expected) => {
      expect(gain(time)).toBeCloseTo(expected);
    },
  );

  it("shortens fades for short segments without a jump or attenuation outside them", () => {
    const short = [{ ...voice, sourceEnd: 0.1 }];
    for (const [time, expected] of [[2, 1], [2.025, 0.625], [2.05, 0.25], [2.075, 0.625], [2.1, 1]]) {
      expect(gain(time, short)).toBeCloseTo(expected);
    }
  });

  it("is deterministic for arbitrary seeks and never modifies stored properties", () => {
    const segments = Object.freeze([Object.freeze({ ...voice, volume: 0.4 }), Object.freeze({ ...voice, id: "other", timelineStart: 8 })]);
    const before = JSON.stringify(segments);
    for (const [time, expected] of [[10, 0.25], [1, 1], [3, 0.25], [7, 1], [2.1, 0.625], [3, 0.25]]) {
      expect(gain(time, segments)).toBeCloseTo(expected);
    }
    expect(JSON.stringify(segments)).toBe(before);
    expect(gain(3, segments)).toBe(ORIGINAL_AUDIO_DUCKING_GAIN);
  });

  it.each([NaN, Infinity, -Infinity])("does not attenuate for invalid timeline time %s", time => {
    expect(gain(time)).toBe(1);
  });
});
