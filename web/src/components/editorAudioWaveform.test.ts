import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioWaveformPeaks, DEFAULT_PEAK_WINDOW_SECONDS, loadAudioWaveformPeaks, sourceTimeToPeakRange } from "./editorAudioWaveform";

// No AudioContext/decoder required: supply the same read-only PCM API as AudioBuffer.
function buffer(channels: number[][], sampleRate = 1000) {
  const data = channels.map(channel => new Float32Array(channel));
  return { sampleRate, length: data[0]?.length ?? 0, numberOfChannels: data.length,
    getChannelData: (channel: number) => data[channel] };
}

describe("waveform URL loading", () => {
  const bytes = new ArrayBuffer(8);
  let fetchMock: ReturnType<typeof vi.fn>;
  let decode: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let context: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: vi.fn().mockResolvedValue(bytes) });
    decode = vi.fn().mockResolvedValue(buffer([[0, 0.75, -0.5, 0]], 2000));
    close = vi.fn().mockResolvedValue(undefined);
    context = vi.fn(function () { return { decodeAudioData: decode, close }; });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("AudioContext", context);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the supplied URL and analyzes the decoded buffer", async () => {
    const peaks = await loadAudioWaveformPeaks("https://media.example/source.mp4");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://media.example/source.mp4");
    expect(decode).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(peaks).toEqual(createAudioWaveformPeaks(buffer([[0, 0.75, -0.5, 0]], 2000)));
    expect(context).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes configurable resolution through to peak generation", async () => {
    const peaks = await loadAudioWaveformPeaks("source", 0.002);
    expect(peaks.samplesPerPeak).toBe(4);
    expect([...peaks.min]).toEqual([-0.5]);
    expect([...peaks.max]).toEqual([0.75]);
  });

  it("rejects HTTP errors without creating a context", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "http", message: expect.stringContaining("403") });
    expect(context).not.toHaveBeenCalled();
  });

  it("preserves network errors without a fake result", async () => {
    const cause = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(cause);
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "fetch", cause });
    expect(context).not.toHaveBeenCalled();
  });

  it("reports response-body failures", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: vi.fn().mockRejectedValue(new Error("read")) });
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "fetch" });
    expect(context).not.toHaveBeenCalled();
  });

  it("preserves decoder errors and closes the context", async () => {
    const cause = new DOMException("Cannot decode", "EncodingError");
    decode.mockRejectedValue(cause);
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "decode", cause });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([buffer([]), buffer([[]])])("rejects missing/empty decoded audio", async decoded => {
    decode.mockResolvedValue(decoded);
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "no-audio" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("accepts genuinely silent audio instead of treating it as missing", async () => {
    decode.mockResolvedValue(buffer([[0, 0]]));
    expect([...(await loadAudioWaveformPeaks("source")).max]).toEqual([0, 0]);
  });

  it("ignores close failures after successful analysis", async () => {
    close.mockRejectedValue(new Error("close"));
    await expect(loadAudioWaveformPeaks("source")).resolves.toHaveProperty("sampleRate", 2000);
  });

  it("does not mask a decoding failure with a synchronous close failure", async () => {
    decode.mockRejectedValue(new Error("decode"));
    close.mockImplementation(() => { throw new Error("close"); });
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "decode" });
  });

  it("closes the context even if peak generation fails", async () => {
    await expect(loadAudioWaveformPeaks("source", 0)).rejects.toThrow(RangeError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable AudioContext support", async () => {
    context.mockImplementation(() => { throw new Error("unavailable"); });
    await expect(loadAudioWaveformPeaks("source")).rejects.toMatchObject({ code: "context" });
  });

  it("creates and closes a separate context per call without caching", async () => {
    await loadAudioWaveformPeaks("source");
    await loadAudioWaveformPeaks("source");
    expect(context).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("audio waveform peaks", () => {
  it("keeps silence at zero", () => {
    const peaks = createAudioWaveformPeaks(buffer([[0, 0, 0, 0]]), 0.002);
    expect([...peaks.min]).toEqual([0, 0]);
    expect([...peaks.max]).toEqual([0, 0]);
  });

  it.each([1, -1])("preserves a one-sample impulse of %s", impulse => {
    const samples = Array(100).fill(0); samples[49] = impulse;
    const peaks = createAudioWaveformPeaks(buffer([samples]), 0.05);
    expect([...peaks.min]).toEqual([Math.min(0, impulse), 0]);
    expect([...peaks.max]).toEqual([Math.max(0, impulse), 0]);
  });

  it("records exact extrema including a partial last window, without normalization", () => {
    const peaks = createAudioWaveformPeaks(buffer([[0.25, 0.5, -0.75, -0.25, 0.125]]), 0.002);
    expect([...peaks.min]).toEqual([0.25, -0.75, 0.125]);
    expect([...peaks.max]).toEqual([0.5, -0.25, 0.125]);
  });

  it("does not cancel opposite-phase stereo channels", () => {
    const peaks = createAudioWaveformPeaks(buffer([[0, 0.75, 0], [0, -0.75, 0]]), 0.003);
    expect([...peaks.min]).toEqual([-0.75]);
    expect([...peaks.max]).toEqual([0.75]);
  });

  it.each([44100, 48000, 96000])("uses the actual %s Hz sample rate", sampleRate => {
    const peaks = createAudioWaveformPeaks(buffer([Array(sampleRate / 100).fill(0)], sampleRate));
    expect(peaks.sampleRate).toBe(sampleRate);
    expect(peaks.samplesPerPeak).toBe(Math.round(sampleRate * DEFAULT_PEAK_WINDOW_SECONDS));
    const boundary = peaks.samplesPerPeak / sampleRate;
    expect(sourceTimeToPeakRange(peaks, boundary, boundary * 2)).toEqual({ start: 1, end: 2 });
  });

  it("allows a different resolution and preserves the same impulse", () => {
    const source = buffer([[0, 0, 0.5, 0]]);
    const fine = createAudioWaveformPeaks(source, 0.001);
    const coarse = createAudioWaveformPeaks(source, 0.004);
    expect(fine.max.length).toBe(4);
    expect(coarse.max.length).toBe(1);
    expect(Math.max(...fine.max)).toBe(coarse.max[0]);
  });

  it("handles empty and sub-window buffers", () => {
    for (const source of [buffer([]), buffer([[]])]) {
      const peaks = createAudioWaveformPeaks(source);
      expect(peaks.min.length).toBe(0);
      expect(sourceTimeToPeakRange(peaks, 0, 1)).toEqual({ start: 0, end: 0 });
    }
    const peaks = createAudioWaveformPeaks(buffer([[0.5]], 48000));
    expect([...peaks.min]).toEqual([0.5]);
    expect([...peaks.max]).toEqual([0.5]);
    expect(sourceTimeToPeakRange(peaks, 0, 1)).toEqual({ start: 0, end: 1 });
  });

  it("uses at least one sample per peak", () => {
    expect(createAudioWaveformPeaks(buffer([[0, 1]]), 0.000001).samplesPerPeak).toBe(1);
  });

  it("maps half-open source ranges and clamps both source edges", () => {
    const peaks = createAudioWaveformPeaks(buffer([Array(11).fill(0)]), 0.002);
    expect(sourceTimeToPeakRange(peaks, 0.002, 0.006)).toEqual({ start: 1, end: 3 });
    expect(sourceTimeToPeakRange(peaks, 0.0025, 0.0065)).toEqual({ start: 1, end: 4 });
    expect(sourceTimeToPeakRange(peaks, -1, 1)).toEqual({ start: 0, end: 6 });
    expect(sourceTimeToPeakRange(peaks, -1, 0)).toEqual({ start: 0, end: 0 });
    expect(sourceTimeToPeakRange(peaks, 0.01, 0.011)).toEqual({ start: 5, end: 6 });
    expect(sourceTimeToPeakRange(peaks, 0.011, 1)).toEqual({ start: 6, end: 6 });
    expect(sourceTimeToPeakRange(peaks, 0.003, 0.003)).toEqual({ start: 1, end: 1 });
    expect(sourceTimeToPeakRange(peaks, 0.006, 0.002)).toEqual({ start: 3, end: 3 });
  });

  it("rejects invalid resolution and non-finite source times", () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => createAudioWaveformPeaks(buffer([[0]]), value)).toThrow(RangeError);
    }
    const peaks = createAudioWaveformPeaks(buffer([[0]]));
    expect(() => sourceTimeToPeakRange(peaks, NaN, 1)).toThrow(RangeError);
    expect(() => sourceTimeToPeakRange(peaks, 0, Infinity)).toThrow(RangeError);
  });
});
