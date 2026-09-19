import { useEffect, useRef, useState } from "react";
import { loadAudioWaveformPeaks, sourceTimeToPeakRange, type AudioWaveformPeaks } from "./editorAudioWaveform";

// Owned by one editor instance; promises also deduplicate concurrent requests.
export type AudioWaveformCache = Map<string, Promise<AudioWaveformPeaks>>;

interface Props {
  sourceKey: string;
  sourceStart: number;
  sourceEnd: number;
  zoom: number;
  cache: AudioWaveformCache;
  loadUrl: (id: string) => string | Promise<string>;
}

export function AudioSegmentWaveform({ sourceKey, sourceStart, sourceEnd, zoom, cache, loadUrl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loaderRef = useRef(loadUrl);
  loaderRef.current = loadUrl;
  const [result, setResult] = useState<{ id: string; peaks: AudioWaveformPeaks } | null>(null);
  const nonempty = Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart;
  useEffect(() => {
    if (!nonempty) return;
    let active = true;
    let pending = cache.get(sourceKey);
    if (!pending) {
      pending = Promise.resolve().then(() => loaderRef.current(sourceKey)).then(url => loadAudioWaveformPeaks(url));
      cache.set(sourceKey, pending);
    }
    // Retain failures in this session too: ordinary rerenders must not retry forever.
    pending.then(peaks => { if (active) setResult({ id: sourceKey, peaks }); },
      () => { if (active) setResult(null); });
    return () => { active = false; };
  }, [cache, sourceKey, nonempty]);

  const peaks = result?.id === sourceKey ? result.peaks : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || !nonempty) return;
    const draw = () => {
      try {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(0, Math.round(rect.width * dpr));
        canvas.height = Math.max(0, Math.round(rect.height * dpr));
        if (!canvas.width || !canvas.height) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#F7C2D2";
        const middle = canvas.height / 2;
        const amplitude = Math.max(0, middle - 2 * dpr);
        for (let x = 0; x < canvas.width; x++) {
          const start = sourceStart + (sourceEnd - sourceStart) * x / canvas.width;
          const end = sourceStart + (sourceEnd - sourceStart) * (x + 1) / canvas.width;
          const range = sourceTimeToPeakRange(peaks, start, end);
          if (range.end <= range.start) continue;
          let min = Infinity, max = -Infinity;
          for (let i = range.start; i < range.end; i++) {
            min = Math.min(min, peaks.min[i]); max = Math.max(max, peaks.max[i]);
          }
          // Fixed amplitude scale: no per-segment or per-zoom normalization.
          ctx.fillRect(x, middle - max * amplitude, 1, Math.max(1, (max - min) * amplitude));
        }
      } catch { /* Visualization must never interrupt editor interaction. */ }
    };
    draw();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(canvas);
    window.addEventListener("resize", draw);
    return () => { observer?.disconnect(); window.removeEventListener("resize", draw); };
  }, [peaks, nonempty, sourceStart, sourceEnd, zoom]);

  if (!nonempty || !peaks) return null;
  return <canvas ref={canvasRef} data-testid="audio-waveform" aria-hidden="true"
    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}
