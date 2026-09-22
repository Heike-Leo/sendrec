import { useEffect, useMemo, useRef, useState } from "react";

const frameCache = new Map<string, string>();

export function filmstripSampleTimes(start: number, end: number, count: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || count <= 0) return [];
  const n = Math.max(1, Math.floor(count));
  const span = end - start;
  return Array.from({ length: n }, (_, index) => start + span * ((index + 0.5) / n));
}

interface VideoClipFilmstripProps {
  sourceKey: string;
  sourceStart: number;
  sourceEnd: number;
  loadUrl: () => string | Promise<string>;
}

export function VideoClipFilmstrip({ sourceKey, sourceStart, sourceEnd, loadUrl }: VideoClipFilmstripProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [frames, setFrames] = useState<string[]>([]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setWidth(root.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const count = useMemo(() => width > 40 ? Math.max(2, Math.min(14, Math.ceil(width / 96))) : 0, [width]);
  const times = useMemo(() => filmstripSampleTimes(sourceStart, sourceEnd, count), [sourceStart, sourceEnd, count]);
  const timeKey = times.map(value => value.toFixed(3)).join(",");

  useEffect(() => {
    if (times.length === 0) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    const keys = times.map(time => `${sourceKey}:${time.toFixed(3)}`);
    const cached = keys.map(key => frameCache.get(key));
    if (cached.every(Boolean)) {
      setFrames(cached as string[]);
      return;
    }

    void (async () => {
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";

      const waitFor = (event: "loadedmetadata" | "seeked") => new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("filmstrip video load failed")); };
        const cleanup = () => {
          video.removeEventListener(event, done);
          video.removeEventListener("error", failed);
        };
        video.addEventListener(event, done, { once: true });
        video.addEventListener("error", failed, { once: true });
      });

      try {
        video.src = await loadUrl();
        if (video.readyState < 1) await waitFor("loadedmetadata");
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const next: string[] = [];
        for (let index = 0; index < times.length; index++) {
          if (cancelled) return;
          const key = keys[index];
          const existing = frameCache.get(key);
          if (existing) {
            next.push(existing);
            continue;
          }
          const duration = Number.isFinite(video.duration) ? video.duration : sourceEnd;
          const target = Math.max(0, Math.min(times[index], Math.max(0, duration - 0.04)));
          if (Math.abs(video.currentTime - target) > 0.025) {
            video.currentTime = target;
            await waitFor("seeked");
          }
          const vw = video.videoWidth || 16;
          const vh = video.videoHeight || 9;
          const scale = Math.max(canvas.width / vw, canvas.height / vh);
          const dw = vw * scale, dh = vh * scale;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
          const data = canvas.toDataURL("image/jpeg", 0.62);
          frameCache.set(key, data);
          next.push(data);
        }
        if (!cancelled) setFrames(next);
      } catch {
        if (!cancelled) setFrames([]);
      } finally {
        video.removeAttribute("src");
        video.load();
      }
    })();

    return () => { cancelled = true; };
  }, [sourceKey, sourceStart, sourceEnd, timeKey]);

  return (
    <div ref={rootRef} className="video-editor-filmstrip" data-testid="video-editor-filmstrip" aria-hidden="true">
      {frames.map((src, index) => <img key={index} src={src} alt="" draggable={false} />)}
    </div>
  );
}
