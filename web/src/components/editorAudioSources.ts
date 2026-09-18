import { apiFetch } from "../api/client";
import { audioSource, type EditorAudioSource } from "./editorAudioGeometry";

// Clip identity affects segment geometry, not the underlying media resource.
export function audioSourceKey(source: EditorAudioSource): string {
  const checked = audioSource({ id: "", source, sourceStart: 0, sourceEnd: 0, timelineStart: 0 });
  return checked.kind === "video" ? `video:${checked.videoId}` : `audioAsset:${checked.assetId}`;
}

interface ResolverOptions {
  loadVideoUrl: (id: string) => string | Promise<string>;
  now?: () => number;
}

// One resolver per editor/user/workspace session. Owns URL state only, never peaks.
// Video URL caching remains owned by the existing loadVideoUrl implementation.
export function createAudioSourceResolver({ loadVideoUrl, now = Date.now }: ResolverOptions) {
  const urls = new Map<string, { url: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    resolve(source: EditorAudioSource, options: { refresh?: boolean } = {}): Promise<string> {
      const key = audioSourceKey(source);
      if (source.kind === "video") return Promise.resolve(loadVideoUrl(source.videoId));
      if (options.refresh) {
        urls.delete(key);
        pending.delete(key);
      }
      const cached = urls.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.url);
      const existing = pending.get(key);
      if (existing) return existing;
      // Start TTL before the request and leave 30 seconds for request/playback latency.
      const expiresAt = now() + (5 * 60 - 30) * 1000;
      const request = apiFetch<{ url: string }>(`/api/audio-assets/${encodeURIComponent(source.assetId)}`)
        .then(response => {
          if (!response?.url || typeof response.url !== "string") throw new Error("Audioquelle konnte nicht geladen werden.");
          if (pending.get(key) === request) urls.set(key, { url: response.url, expiresAt });
          return response.url;
        }).finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
  };
}
