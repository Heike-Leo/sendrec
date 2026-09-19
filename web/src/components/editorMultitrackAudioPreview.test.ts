import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorMultitrackAudioPreview } from "./editorMultitrackAudioPreview";
import { createAudioSourceResolver } from "./editorAudioSources";
import { type EditorAudioSegment, type EditorAudioTrackId } from "./editorAudioGeometry";
import { apiFetch } from "../api/client";
import type { EditorClip } from "./editorClipTime";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const original: EditorAudioSegment = { id: "o", sourceVideoId: "same", sourceClipId: "c", sourceStart: 2, sourceEnd: 12, timelineStart: 0 };
const voice: EditorAudioSegment = { id: "v", trackId: "voiceover-1", source: { kind: "audioAsset", assetId: "same" }, geometryLinked: false, speed: 1, sourceStart: 0, sourceEnd: 10, timelineStart: 0 };

describe("multitrack preview engine (not yet enabled in editor)", () => {
  let time: number;
  let segments: EditorAudioSegment[];
  let clips: EditorClip[];
  let preview: EditorMultitrackAudioPreview;
  let elements: Map<EditorAudioTrackId, HTMLAudioElement>;
  let pause: ReturnType<typeof vi.fn<() => void>>;
  let error: ReturnType<typeof vi.fn<(message: string | null) => void>>;
  let loadVideoUrl: ReturnType<typeof vi.fn<(id: string) => string | Promise<string>>>;
  let createAudio: ReturnType<typeof vi.fn<(track: EditorAudioTrackId) => HTMLAudioElement>>;
  beforeEach(() => {
    vi.clearAllMocks();
    time = 0;
    segments = [{ ...original }];
    clips = [];
    elements = new Map();
    pause = vi.fn(); error = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue({ url: "https://media.test/voice.m4a" });
    loadVideoUrl = vi.fn(() => "https://media.test/video.mp4");
    createAudio = vi.fn((track: EditorAudioTrackId) => {
      const audio = document.createElement("audio");
      let paused = true;
      Object.defineProperties(audio, {
        readyState: { configurable: true, get: () => 4 },
        paused: { get: () => paused },
        preservesPitch: { writable: true, value: false },
      });
      vi.spyOn(audio, "pause").mockImplementation(() => { paused = true; });
      vi.spyOn(audio, "load").mockImplementation(() => {});
      vi.spyOn(audio, "play").mockImplementation(async () => {
        paused = false;
        audio.dispatchEvent(new Event("playing"));
      });
      elements.set(track, audio);
      return audio;
    });
    preview = new EditorMultitrackAudioPreview({ segments: () => segments, clips: () => clips, time: () => time,
      resolver: createAudioSourceResolver({ loadVideoUrl }), createAudio, pause, error,
      canCheckDrift: () => true });
  });
  afterEach(() => preview.dispose());
  async function ready() {
    // Drain the resolver's promise chain, then deliver actual media readiness.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    for (const audio of elements.values()) audio.dispatchEvent(new Event("loadedmetadata"));
    await Promise.resolve();
  }
  const audio = (track: EditorAudioTrackId = "original") => elements.get(track)!;

  it("creates only the legacy original player and reuses it across sync/pause/seek", async () => {
    preview.play(); await ready();
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(createAudio).toHaveBeenCalledWith("original");
    expect(loadVideoUrl).toHaveBeenCalledWith("same");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(audio().currentTime).toBe(2);
    expect(audio().playbackRate).toBe(1);
    preview.sync(true); expect(audio().play).toHaveBeenCalledTimes(1);
    preview.pause(); expect(audio().paused).toBe(true);
    time = 3; preview.seek(); await ready();
    expect(audio().currentTime).toBe(5);
    expect(audio().paused).toBe(true);
  });

  it("plays both sources with colliding UUIDs, independent gain and one master clock", async () => {
    segments = [{ ...original, speed: 2, volume: .3 }, { ...voice, volume: .7 }];
    time = 1; preview.play(); await ready();
    expect(createAudio).toHaveBeenCalledTimes(2);
    expect(audio().src).toBe("https://media.test/video.mp4");
    expect(audio("voiceover-1").src).toBe("https://media.test/voice.m4a");
    expect(audio().currentTime).toBe(4);
    expect(audio("voiceover-1").currentTime).toBe(1);
    expect(audio().playbackRate).toBe(2);
    expect(audio("voiceover-1").playbackRate).toBe(1);
    expect(audio().preservesPitch).toBe(true);
    expect(audio().volume).toBe(.3); expect(audio("voiceover-1").volume).toBe(.7);
    time = 2; preview.seek(); await ready();
    expect(audio().currentTime).toBe(6); expect(audio("voiceover-1").currentTime).toBe(2);
    preview.pause(); expect(audio().paused).toBe(true); expect(audio("voiceover-1").paused).toBe(true);
  });

  it("handles per-track gaps and source changes without restarting original", async () => {
    segments = [original, { ...voice, sourceEnd: 1 }, { ...voice, id: "v2", source: { kind: "audioAsset", assetId: "next" }, timelineStart: 3, sourceEnd: 2 }];
    preview.play(); await ready();
    time = 2; preview.sync(true);
    expect(audio("voiceover-1").paused).toBe(true);
    expect(audio().paused).toBe(false);
    time = 3; preview.sync(true); await ready();
    expect(apiFetch).toHaveBeenCalledWith("/api/audio-assets/next");
    expect(audio("voiceover-1").paused).toBe(false);
    expect(audio().play).toHaveBeenCalledTimes(1);
  });

  it("uses coupled clip speed exactly once, and restores speed/source time on state change", async () => {
    clips = [{ id: "c", sourceVideoId: "same", start: 2, end: 12, speed: 2 }];
    segments = [{ ...original, geometryLinked: true, speed: .5 }, voice];
    time = 1; preview.play(); await ready();
    expect(audio().playbackRate).toBe(2); expect(audio().currentTime).toBe(4);
    expect(audio("voiceover-1").playbackRate).toBe(1);
    clips = [{ ...clips[0], speed: 1 }]; preview.sync(true, true); await ready();
    expect(audio().playbackRate).toBe(1); expect(audio().currentTime).toBe(3);
  });

  it("keeps sub-tolerance drift and an empty project silent without allocating players", async () => {
    segments = []; preview.play(); expect(createAudio).not.toHaveBeenCalled();
    segments = [original, voice]; preview.sync(true); await ready();
    time = 1; audio().currentTime = 3.05; audio("voiceover-1").currentTime = 1.05;
    preview.checkDrift(0); preview.checkDrift(250);
    expect(audio().currentTime).toBe(3.05); expect(audio("voiceover-1").currentTime).toBe(1.05);
  });

  it("updates gain live and mutes only the selected track", async () => {
    segments = [original, voice]; preview.play(); await ready();
    segments = [original, { ...voice, volume: .2 }]; preview.sync(true);
    expect(audio("voiceover-1").volume).toBe(.2);
    expect(audio("voiceover-1").play).toHaveBeenCalledTimes(1);
    segments = [original, { ...voice, muted: true }]; preview.sync(true);
    expect(audio("voiceover-1").paused).toBe(true); expect(audio().paused).toBe(false);
    segments = [{ ...original, muted: true }, voice]; preview.sync(true); await ready();
    expect(audio().paused).toBe(true); expect(audio("voiceover-1").paused).toBe(false);
  });

  it("refreshes asset URLs through the shared resolver without any peak cache", async () => {
    segments = [voice]; preview.play(); await ready();
    vi.mocked(apiFetch).mockResolvedValue({ url: "https://media.test/renewed.m4a" });
    await preview.refreshSource(voice.source!); await ready();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(audio("voiceover-1").src).toBe("https://media.test/renewed.m4a");
  });

  it("reuses separate 250-ms drift checks against the same timeline", async () => {
    segments = [original, voice]; preview.play(); await ready();
    time = 1; audio().currentTime = 2.5; audio("voiceover-1").currentTime = 1;
    preview.checkDrift(0);
    expect(audio().currentTime).toBe(3); expect(audio("voiceover-1").currentTime).toBe(1);
    audio("voiceover-1").currentTime = .5; preview.checkDrift(100);
    expect(audio("voiceover-1").currentTime).toBe(.5);
    preview.checkDrift(250); expect(audio("voiceover-1").currentTime).toBe(1);
  });

  it.each(["resolver", "play", "media"])("pauses the master and cleans both tracks on %s failure", async failure => {
    segments = [original, voice];
    if (failure === "resolver") vi.mocked(apiFetch).mockRejectedValue(new Error("forbidden"));
    preview.play();
    if (failure === "play") vi.mocked(audio("voiceover-1").play).mockRejectedValue(new Error("blocked"));
    await ready(); await ready();
    if (failure === "media") audio("voiceover-1").dispatchEvent(new Event("error"));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String));
    for (const element of elements.values()) {
      expect(element.paused).toBe(true); expect(element.hasAttribute("src")).toBe(false);
    }
    preview.sync(true); expect(createAudio).toHaveBeenCalledTimes(2);
  });

  it("releases removed tracks on Undo, recreates on restoration and disposes listeners", async () => {
    segments = [original, voice]; preview.play(); await ready();
    const removed = audio("voiceover-1");
    const remove = vi.spyOn(removed, "removeEventListener");
    segments = [original]; preview.sync(true);
    expect(removed.hasAttribute("src")).toBe(false);
    expect(remove).toHaveBeenCalledWith("error", expect.any(Function));
    removed.dispatchEvent(new Event("error")); expect(error).not.toHaveBeenCalled();
    segments = [original, voice]; preview.sync(true); await ready();
    expect(createAudio).toHaveBeenCalledTimes(3);
    expect(audio("voiceover-1")).not.toBe(removed);
    preview.dispose(); preview.play();
    for (const element of elements.values()) expect(element.hasAttribute("src")).toBe(false);
    expect(createAudio).toHaveBeenCalledTimes(3);
  });

  it("ignores a late resolver result after modal/project disposal", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise(yes => { resolve = yes; }));
    segments = [voice]; preview.play(); preview.dispose();
    resolve({ url: "https://media.test/stale.m4a" }); await ready();
    expect(audio("voiceover-1").hasAttribute("src")).toBe(false);
    expect(audio("voiceover-1").play).not.toHaveBeenCalled();
  });

  it.each(["overlap", "track", "speed"])("rejects invalid %s before starting any player", kind => {
    segments = kind === "overlap" ? [voice, { ...voice, id: "duplicate" }]
      : [{ ...voice, ...(kind === "track" ? { trackId: "third" } : { speed: 2 }) }];
    preview.play(); expect(createAudio).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalledOnce();
  });
});
