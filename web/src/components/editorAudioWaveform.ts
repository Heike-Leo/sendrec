/** Requested analysis resolution; rounded to at least one whole source sample. */
export const DEFAULT_PEAK_WINDOW_SECONDS = 0.001;

export class AudioWaveformLoadError extends Error {
  constructor(
    public readonly code: "fetch" | "http" | "context" | "decode" | "no-audio",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AudioWaveformLoadError";
  }
}

/** Analyze an already resolved URL. No playback, URL lookup or shared cache. */
export async function loadAudioWaveformPeaks(
  url: string,
  windowSeconds = DEFAULT_PEAK_WINDOW_SECONDS,
): Promise<AudioWaveformPeaks> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new AudioWaveformLoadError("fetch", "Waveform-Quelle konnte nicht geladen werden (Netzwerk/CORS).", cause);
  }
  if (!response.ok) {
    throw new AudioWaveformLoadError("http", `Waveform-Quelle konnte nicht geladen werden (HTTP ${response.status}).`);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (cause) {
    throw new AudioWaveformLoadError("fetch", "Waveform-Quelldaten konnten nicht gelesen werden.", cause);
  }
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch (cause) {
    throw new AudioWaveformLoadError("context", "Audioanalyse ist in diesem Browser nicht verfügbar.", cause);
  }
  try {
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (cause) {
      // Browsers do not reliably distinguish missing audio from unsupported/corrupt media.
      throw new AudioWaveformLoadError("decode", "Quelle enthält keine decodierbare Audiospur oder ein nicht unterstütztes/beschädigtes Format.", cause);
    }
    if (buffer.numberOfChannels === 0 || buffer.length === 0) {
      throw new AudioWaveformLoadError("no-audio", "Quelle enthält keine auswertbaren Audiosamples.");
    }
    return createAudioWaveformPeaks(buffer, windowSeconds);
  } finally {
    try { await context.close(); } catch { /* Cleanup must not replace results/errors. */ }
  }
}

export interface AudioWaveformPeaks {
  min: Float32Array;
  max: Float32Array;
  sampleRate: number;
  sampleCount: number;
  samplesPerPeak: number;
}

/** Only the read-only AudioBuffer surface needed by the analysis. */
type WaveformAudioBuffer = Pick<AudioBuffer, "sampleRate" | "length" | "numberOfChannels" | "getChannelData">;

export function createAudioWaveformPeaks(
  buffer: WaveformAudioBuffer,
  windowSeconds = DEFAULT_PEAK_WINDOW_SECONDS,
): AudioWaveformPeaks {
  if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 ||
      !Number.isFinite(windowSeconds) || windowSeconds <= 0 ||
      !Number.isFinite(buffer.sampleRate * windowSeconds)) {
    throw new RangeError("Sample rate and peak window must be finite and positive");
  }
  const samplesPerPeak = Math.max(1, Math.round(buffer.sampleRate * windowSeconds));
  const count = Math.ceil(buffer.length / samplesPerPeak);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  if (buffer.numberOfChannels > 0) {
    min.fill(Infinity);
    max.fill(-Infinity);
    // Preserve extrema across channels, never mix/average channels or normalize.
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let peak = 0; peak < count; peak++) {
        const end = Math.min(buffer.length, (peak + 1) * samplesPerPeak);
        for (let sample = peak * samplesPerPeak; sample < end; sample++) {
          min[peak] = Math.min(min[peak], samples[sample]);
          max[peak] = Math.max(max[peak], samples[sample]);
        }
      }
    }
  }
  return { min, max, sampleRate: buffer.sampleRate, sampleCount: buffer.length, samplesPerPeak };
}

/** Peak indices intersecting [sourceStart, sourceEnd), with an exclusive end.
 * Times are clamped to the source. Empty/reversed intervals select no peaks.
 * Uses the actual sample-aligned window, not the requested resolution.
 */
export function sourceTimeToPeakRange(
  peaks: AudioWaveformPeaks,
  sourceStart: number,
  sourceEnd: number,
): { start: number; end: number } {
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) {
    throw new RangeError("Source times must be finite");
  }
  const duration = peaks.sampleCount / peaks.sampleRate;
  const startTime = Math.max(0, Math.min(duration, sourceStart));
  const endTime = Math.max(0, Math.min(duration, sourceEnd));
  // Remove arithmetic noise at exact bin boundaries without rounding real times.
  const bin = (time: number) => {
    const value = time * peaks.sampleRate / peaks.samplesPerPeak;
    const integer = Math.round(value);
    return Math.abs(value - integer) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8
      ? integer : value;
  };
  const start = startTime >= duration ? peaks.min.length : Math.floor(bin(startTime));
  return { start, end: endTime <= startTime ? start : Math.min(peaks.min.length, Math.ceil(bin(endTime))) };
}
