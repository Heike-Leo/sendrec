import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorAudioPreview } from "./editorAudioPreview";

const first = { id: "a", sourceVideoId: "one", sourceStart: 3, sourceEnd: 5, timelineStart: 0 };
const second = { id: "b", sourceVideoId: "two", sourceStart: 10, sourceEnd: 12, timelineStart: 2 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("independent audio preview", () => {
  let audio: HTMLAudioElement;
  let preview: EditorAudioPreview;
  let time: number;
  let segments: (typeof first & { muted?: boolean; volume?: number; previewSpeed?: number })[];
  let url: ReturnType<typeof vi.fn<(id: string) => string | Promise<string>>>;
  let error: ReturnType<typeof vi.fn<(message: string | null) => void>>;
  function metadata() { audio.dispatchEvent(new Event("loadedmetadata")); }
  afterEach(() => preview.dispose());

  beforeEach(() => {
    time = 0;
    segments = [{ ...first }, { ...second }];
    audio = document.createElement("audio");
    Object.defineProperty(audio, "readyState", { configurable: true, get: () => 1 });
    vi.spyOn(audio, "pause").mockImplementation(() => {});
    vi.spyOn(audio, "load").mockImplementation(() => {});
    vi.spyOn(audio, "play").mockResolvedValue();
    url = vi.fn((id: string) => `https://media.example/${id}.mp4`);
    error = vi.fn();
    preview = new EditorAudioPreview(audio, { segments: () => segments, time: () => time, url, error,
      speed: segment => segments.find(item => item.id === segment.id)?.previewSpeed });
  });

  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])("prepares audio rate %s, seeks and respects the scaled end", speed => {
    segments = [{ ...first, sourceStart: 10, sourceEnd: 20, timelineStart: 3, previewSpeed: speed, volume: 0.4 }];
    Object.defineProperty(audio, "preservesPitch", { configurable: true, writable: true, value: false });
    time = 4;
    preview.sync(true); metadata();
    expect(audio.playbackRate).toBe(speed);
    expect(audio.currentTime).toBe(10 + speed);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.volume).toBe(0.4);
    time = 4.5;
    preview.sync(false, true);
    expect(audio.currentTime).toBe(10 + 1.5 * speed);
    time = 3 + 10 / speed;
    vi.mocked(audio.play).mockClear();
    preview.sync(true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });

  it("changes rate at a contiguous same-source boundary without reloading, seeking or restarting", () => {
    segments = [{ ...first, previewSpeed: 2 },
      { ...second, sourceVideoId: "one", sourceStart: 5, sourceEnd: 7, timelineStart: 1, previewSpeed: 0.5 }];
    preview.sync(true); metadata();
    expect(audio.playbackRate).toBe(2);
    const seek = vi.spyOn(audio, "currentTime", "set");
    time = 1;
    preview.sync(true);
    expect(audio.playbackRate).toBe(0.5);
    expect(seek).not.toHaveBeenCalled();
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("updates rate after an asynchronous source switch and ignores obsolete source requests", async () => {
    const pending = deferred<string>();
    url.mockReturnValueOnce(pending.promise);
    segments = [{ ...first, previewSpeed: 2 }, { ...second, timelineStart: 1, previewSpeed: 0.5 }];
    preview.sync(true);
    time = 2;
    preview.sync(true); metadata();
    pending.resolve("https://media.example/obsolete.mp4");
    await pending.promise;
    expect(audio.playbackRate).toBe(0.5);
    expect(audio.currentTime).toBe(10.5);
    expect(audio.src).toBe("https://media.example/two.mp4");
  });

  it("preserves mute and live volume independently of speed", () => {
    segments = [{ ...first, previewSpeed: 2, muted: true, volume: 0.3 }];
    preview.sync(true);
    expect(url).not.toHaveBeenCalled();
    segments[0].muted = false;
    preview.sync(true); metadata();
    const seek = vi.spyOn(audio, "currentTime", "set");
    preview.setVolumeDraft({ id: "a", value: 0.6 });
    expect(audio.volume).toBe(0.6);
    expect(audio.playbackRate).toBe(2);
    expect(seek).not.toHaveBeenCalled();
  });

  it("defaults to one without a speed adapter, regardless of extra source properties", () => {
    preview.dispose();
    segments = [{ ...first, previewSpeed: 2 }];
    preview = new EditorAudioPreview(audio, { segments: () => segments, time: () => time, url, error });
    time = 0.5;
    preview.sync(true); metadata();
    expect(audio.playbackRate).toBe(1);
    expect(audio.currentTime).toBe(3.5);
  });

  it("starts the segment source at sourceStart plus timeline offset", () => {
    time = 0.75;
    preview.sync(true, true);
    metadata();
    expect(audio.src).toBe("https://media.example/one.mp4");
    expect(audio.currentTime).toBe(3.75);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 1, 0.5, 0])("uses volume %s without changing transport on gain edits", volume => {
    segments[0] = { ...first, volume };
    preview.sync(true);
    metadata();
    expect(audio.volume).toBe(volume ?? 1);
    const seek = vi.spyOn(audio, "currentTime", "set");
    vi.mocked(audio.pause).mockClear(); vi.mocked(audio.play).mockClear(); vi.mocked(audio.load).mockClear();
    segments[0] = { ...segments[0], volume: 0.4 };
    preview.updateVolume();
    preview.sync(true);
    expect(audio.volume).toBe(0.4);
    expect(seek).not.toHaveBeenCalled();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
  });

  it("keeps a live draft tied to its ID across a seamless same-source transition and mute", () => {
    segments = [{ ...first, volume: 0.8 }, { ...second, sourceVideoId: "one", sourceStart: 5, sourceEnd: 7, volume: 0.3 }];
    preview.sync(true); metadata();
    preview.setVolumeDraft({ id: "a", value: 0.2 });
    expect(audio.volume).toBe(0.2);
    time = 2;
    preview.sync(true);
    expect(audio.volume).toBe(0.3);
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    preview.setVolumeDraft(null);
    segments[1] = { ...segments[1], muted: true };
    preview.sync(true, true);
    preview.setVolumeDraft({ id: "b", value: 0.1 });
    expect(audio.play).toHaveBeenCalledTimes(1);
    preview.setVolumeDraft(null);
    segments[1] = { ...segments[1], muted: false };
    preview.sync(true, true);
    expect(audio.volume).toBe(0.3);
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 1.1])("rejects invalid volume %s", volume => {
    segments[0] = { ...first, volume };
    preview.sync(true);
    metadata();
    expect(audio.play).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Ungültige Audio-Lautstärke.");
  });

  it.each([undefined, false, true])("handles muted=%s without loading a muted source", muted => {
    segments[0] = { ...first, muted };
    preview.sync(true, true);
    metadata();
    expect(audio.play).toHaveBeenCalledTimes(muted === true ? 0 : 1);
    expect(url).toHaveBeenCalledTimes(muted === true ? 0 : 1);
    expect(segments).toHaveLength(2);
  });

  it.each(["url", "metadata", "play"])("mute invalidates pending %s and the next audible same-source segment starts correctly", async stage => {
    const pendingUrl = deferred<string>();
    const pendingPlay = deferred<void>();
    if (stage === "url") url.mockReturnValueOnce(pendingUrl.promise);
    if (stage === "play") vi.mocked(audio.play).mockReturnValueOnce(pendingPlay.promise);
    segments[1] = { ...second, sourceVideoId: "one" };
    preview.sync(true);
    if (stage === "play") metadata();
    segments[0] = { ...first, muted: true };
    preview.sync(true, true);
    vi.mocked(audio.play).mockClear();
    vi.mocked(audio.pause).mockClear();
    pendingUrl.resolve("https://media.example/one.mp4");
    pendingPlay.resolve();
    await Promise.all([pendingUrl.promise, pendingPlay.promise]);
    metadata();
    audio.dispatchEvent(new Event("playing"));
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
    time = 2.5;
    preview.sync(true);
    metadata();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(10.5);
  });

  it("pause invalidates an outstanding URL request", async () => {
    const pending = deferred<string>();
    url.mockReturnValue(pending.promise);
    preview.sync(true);
    preview.stop();
    pending.resolve("https://media.example/one.mp4");
    await pending.promise;
    metadata();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("pause removes pending metadata callbacks", () => {
    preview.sync(true);
    preview.stop();
    metadata();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });

  it("late play completion after pause stays silent", async () => {
    const pending = deferred<void>();
    vi.mocked(audio.play).mockReturnValue(pending.promise);
    preview.sync(true);
    metadata();
    preview.stop();
    vi.mocked(audio.pause).mockClear();
    pending.resolve();
    await pending.promise;
    expect(audio.pause).toHaveBeenCalled();
  });

  it("seeks across sources and while paused without starting audio", () => {
    preview.sync(true);
    metadata();
    time = 2.5;
    preview.sync(false, true);
    metadata();
    expect(audio.src).toContain("two.mp4");
    expect(audio.currentTime).toBe(10.5);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("uses half-open intervals at a segment boundary", () => {
    preview.sync(true);
    metadata();
    time = 2;
    preview.sync(true);
    metadata();
    expect(audio.src).toContain("two.mp4");
    expect(audio.currentTime).toBe(10);
  });

  it("contiguous segments of one source continue without reload, seek or play", () => {
    segments[1] = { ...second, sourceVideoId: "one", sourceStart: 5, sourceEnd: 7 };
    preview.sync(true);
    metadata();
    audio.currentTime = 5.01;
    time = 2;
    preview.sync(true);
    expect(audio.currentTime).toBe(5.01);
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("repeated source with discontinuous source time seeks without reloading", () => {
    segments[1] = { ...second, sourceVideoId: "one" };
    preview.sync(true);
    metadata();
    time = 2.25;
    preview.sync(true);
    expect(audio.currentTime).toBe(10.25);
    expect(audio.load).toHaveBeenCalledTimes(1);
  });

  it("pauses in gaps and resumes at the next segment", () => {
    segments[1].timelineStart = 4;
    preview.sync(true);
    metadata();
    time = 3;
    preview.sync(true);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    time = 4.5;
    preview.sync(true);
    metadata();
    expect(audio.currentTime).toBe(10.5);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("an empty audio timeline never loads or plays a fallback", () => {
    segments = [];
    preview.sync(true, true);
    expect(url).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("a stale URL resolution cannot replace a more recent source", async () => {
    const pending = deferred<string>();
    url.mockImplementation((id) => id === "one" ? pending.promise : "https://media.example/two.mp4");
    preview.sync(true);
    time = 2.75;
    preview.sync(true, true);
    metadata();
    pending.resolve("https://media.example/one.mp4");
    await pending.promise;
    expect(audio.src).toContain("two.mp4");
    expect(audio.currentTime).toBe(10.75);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("uses the latest master time when metadata arrives late", () => {
    preview.sync(true);
    time = 1.2;
    metadata();
    expect(audio.currentTime).toBe(4.2);
  });

  it("does not start a segment that has ended while its source loaded", () => {
    preview.sync(true);
    time = 2.5;
    metadata();
    expect(audio.play).not.toHaveBeenCalled();
    metadata();
    expect(audio.currentTime).toBe(10.5);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("resynchronizes on resume but does not perform continuous drift correction", () => {
    preview.sync(true);
    metadata();
    time = 1;
    audio.currentTime = 3.8;
    preview.sync(true);
    expect(audio.currentTime).toBe(3.8);
    preview.stop();
    preview.sync(true, true);
    expect(audio.currentTime).toBe(4);
  });

  it("reports blocked autoplay once, with retry only after an explicit start", async () => {
    vi.mocked(audio.play).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    preview.sync(true);
    metadata();
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Browser blockiert"));
    preview.sync(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    preview.sync(true, true);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("does not restart an ended silent/short source until a transport event", () => {
    preview.sync(true);
    metadata();
    audio.dispatchEvent(new Event("ended"));
    time = 1;
    preview.sync(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("aligns once when playback actually starts after buffering, not on every playing event", () => {
    preview.sync(true);
    metadata();
    time = 0.5;
    audio.dispatchEvent(new Event("playing"));
    expect(audio.currentTime).toBe(3.5);
    time = 0.75;
    audio.dispatchEvent(new Event("playing"));
    expect(audio.currentTime).toBe(3.5);
  });

  it("dispose stops playback, releases the source and rejects all late events", () => {
    preview.sync(true);
    preview.dispose();
    metadata();
    preview.sync(true, true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
  });
});

describe("audio preview drift control", () => {
  let preview: EditorAudioPreview;
  let audio: HTMLAudioElement;
  let time: number;
  let segments: (typeof first & { muted?: boolean; volume?: number })[];
  let videoReady: boolean;
  let state: { paused: boolean; seeking: boolean; ended: boolean; readyState: number; currentSrc: string; error: MediaError | null };
  let hidden: ReturnType<typeof vi.fn<() => boolean>>;
  let writeTime: ReturnType<typeof vi.fn<(value: number) => void>>;
  let readTime: ReturnType<typeof vi.fn<() => number>>;

  function drift(value: number) {
    audio.currentTime = 10 + time + value;
    writeTime.mockClear();
  }
  function visibility(value: boolean) {
    hidden.mockReturnValue(value);
    document.dispatchEvent(new Event("visibilitychange"));
  }
  function restart() {
    preview.sync(true, true);
    audio.dispatchEvent(new Event("playing"));
    writeTime.mockClear();
  }

  beforeEach(() => {
    previewSpeed = undefined;
    hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    time = 1;
    videoReady = true;
    segments = [{ ...first, sourceStart: 10, sourceEnd: 40 }];
    state = { paused: false, seeking: false, ended: false, readyState: 4, currentSrc: "", error: null };
    audio = document.createElement("audio");
    for (const key of Object.keys(state) as Array<keyof typeof state>) {
      Object.defineProperty(audio, key, { configurable: true, get: () => state[key] });
    }
    vi.spyOn(audio, "pause").mockImplementation(() => {});
    vi.spyOn(audio, "load").mockImplementation(() => {});
    vi.spyOn(audio, "play").mockResolvedValue();
    readTime = vi.fn(() => time);
    preview = new EditorAudioPreview(audio, {
      segments: () => segments, time: readTime,
      url: (id) => `https://media.example/${id}.mp4`,
      error: vi.fn(), canCheckDrift: () => videoReady, speed: () => previewSpeed,
    });
    preview.sync(true, true);
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("playing"));
    writeTime = vi.spyOn(audio, "currentTime", "set");
  });
  afterEach(() => { preview.dispose(); vi.restoreAllMocks(); });

  let previewSpeed: number | undefined;
  it.each([0.5, 2])("measures tolerance and resync thresholds in timeline seconds at %s", speed => {
    previewSpeed = speed;
    preview.sync(true, true);
    audio.dispatchEvent(new Event("playing"));
    const target = 10 + time * speed;
    expect(audio.currentTime).toBe(target);
    audio.currentTime = target + 0.1 * speed;
    writeTime.mockClear();
    preview.checkDrift(0); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
    audio.currentTime = target + 0.15 * speed;
    writeTime.mockClear();
    preview.checkDrift(500);
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(750);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(target);
    audio.currentTime = target - 0.25 * speed;
    writeTime.mockClear();
    preview.checkDrift(1750);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(target);
  });

  it.each([0, 0.099, -0.099, 0.1, -0.1])("never seeks within tolerance (%s seconds)", (value) => {
    drift(value);
    preview.checkDrift(0);
    preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
  });

  it("ignores drift once the active segment is muted, even before transport sync", () => {
    drift(0.5);
    segments[0] = { ...segments[0], muted: true };
    preview.checkDrift(0);
    preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
  });

  it("preserves drift confirmation across pure volume changes", () => {
    drift(0.15); preview.checkDrift(0);
    segments[0] = { ...segments[0], volume: 0.5 };
    preview.updateVolume(); preview.sync(true);
    preview.checkDrift(250);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
  });

  it.each([0.15, -0.15])("requires two consecutive same-direction measurements (%s)", (value) => {
    drift(value);
    preview.checkDrift(0);
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(250);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
  });

  it.each([0.25, -0.25, 0.5, -0.5])("corrects large drift directly (%s)", (value) => {
    drift(value);
    preview.checkDrift(0);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
  });

  it("runs no drift measurements between the 250-ms checks", () => {
    drift(0.15);
    preview.checkDrift(0);
    readTime.mockClear();
    for (let now = 25; now < 250; now += 25) preview.checkDrift(now);
    expect(readTime).not.toHaveBeenCalled();
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(250);
    expect(writeTime).toHaveBeenCalledTimes(1);
  });

  it("does not confirm alternating directions or measurements inside tolerance", () => {
    drift(0.15); preview.checkDrift(0);
    drift(-0.15); preview.checkDrift(250);
    drift(0.05); preview.checkDrift(500);
    drift(-0.15); preview.checkDrift(750);
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(1000);
    expect(writeTime).toHaveBeenCalledTimes(1);
  });

  it("enforces the full one-second cooldown while explicit transport remains available", () => {
    drift(0.4); preview.checkDrift(0);
    drift(0.4);
    preview.checkDrift(250); preview.checkDrift(500); preview.checkDrift(750);
    expect(writeTime).not.toHaveBeenCalled();
    preview.sync(false, true); // Explicit seek/synchronization is not cooldown-limited.
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
    restart();
    drift(0.4); preview.checkDrift(1000);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
  });

  it.each(["play", "pause", "seek", "buffer", "segment", "source"])("discards prior confirmation on %s", (action) => {
    drift(0.15); preview.checkDrift(0);
    if (action === "pause") preview.stop();
    if (action === "seek") audio.dispatchEvent(new Event("seeking"));
    if (action === "buffer") {
      audio.dispatchEvent(new Event("waiting"));
      audio.dispatchEvent(new Event("playing"));
    }
    if (action === "segment" || action === "source") {
      segments = [{ ...segments[0], id: "new", sourceVideoId: action === "source" ? "two" : "one" }];
    }
    if (["play", "pause", "segment", "source"].includes(action)) {
      preview.sync(true, true);
      audio.dispatchEvent(new Event("loadedmetadata"));
      audio.dispatchEvent(new Event("playing"));
    }
    drift(0.15); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(500);
    expect(writeTime).toHaveBeenCalledTimes(1);
  });

  it.each(["video", "paused", "seeking", "ended", "unready", "error", "buffer", "gap", "empty", "ambiguous", "source", "currentSrc", "segment", "loading", "starting"])("blocks correction in invalid state: %s", (condition) => {
    if (condition === "video") videoReady = false;
    if (condition === "paused") state.paused = true;
    if (condition === "seeking") state.seeking = true;
    if (condition === "ended") state.ended = true;
    if (condition === "unready") state.readyState = 2;
    if (condition === "error") state.error = { code: 3 } as MediaError;
    if (condition === "buffer") audio.dispatchEvent(new Event("waiting"));
    if (condition === "gap") time = 31;
    if (condition === "empty") segments = [];
    if (condition === "ambiguous") segments.push({ ...segments[0], id: "duplicate" });
    if (condition === "source") audio.src = "https://media.example/wrong.mp4";
    if (condition === "currentSrc") state.currentSrc = "https://media.example/stale.mp4";
    if (condition === "segment") segments[0] = { ...segments[0], id: "next" };
    if (condition === "loading") {
      segments[0] = { ...segments[0], sourceVideoId: "two" };
      state.readyState = 0;
      preview.sync(true, true);
    }
    if (condition === "starting") preview.sync(true, true); // No playing event yet.
    drift(0.5);
    preview.checkDrift(0); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
  });

  it("blocked playback is not repaired or restarted by drift checks", async () => {
    vi.mocked(audio.play).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    preview.sync(true, true);
    await Promise.resolve(); await Promise.resolve();
    drift(0.5);
    const plays = vi.mocked(audio.play).mock.calls.length;
    preview.checkDrift(0); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(plays);
  });

  it("recalculates the target immediately before correction", () => {
    drift(0.5);
    readTime.mockReturnValueOnce(1).mockReturnValueOnce(1.02);
    preview.checkDrift(0);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11.02);
  });

  it("does not write if the fresh master time has crossed the segment boundary", () => {
    drift(0.5);
    readTime.mockReturnValueOnce(1).mockReturnValueOnce(30);
    preview.checkDrift(0);
    expect(writeTime).not.toHaveBeenCalled();
  });

  it("suspends hidden-tab checks and performs one resync on return even below tolerance", () => {
    visibility(true);
    drift(0.5); preview.checkDrift(0);
    expect(writeTime).not.toHaveBeenCalled();
    visibility(false);
    drift(0.02); preview.checkDrift(250);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
    preview.checkDrift(1250);
    document.dispatchEvent(new Event("visibilitychange")); // Still visible, not another return.
    preview.checkDrift(1500);
    expect(writeTime).toHaveBeenCalledTimes(1);
  });

  it("defers return resync through loading until the correct new segment is playing", () => {
    visibility(true); visibility(false);
    segments = [{ ...segments[0], id: "next", sourceVideoId: "two", sourceStart: 20, sourceEnd: 50 }];
    preview.sync(true, true);
    drift(0.5); preview.checkDrift(0);
    expect(writeTime).not.toHaveBeenCalled();
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("playing"));
    audio.currentTime = 21.02;
    writeTime.mockClear();
    preview.checkDrift(250);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(21);
  });

  it("return while paused neither resynchronizes nor starts playback", () => {
    preview.stop(); state.paused = true;
    visibility(true); visibility(false);
    drift(0.5);
    vi.mocked(audio.play).mockClear();
    preview.checkDrift(0); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("return resync also respects the correction cooldown", () => {
    drift(0.5); preview.checkDrift(0);
    visibility(true); visibility(false);
    drift(0.02); preview.checkDrift(250);
    expect(writeTime).not.toHaveBeenCalled();
    preview.checkDrift(1000);
    expect(writeTime).toHaveBeenCalledExactlyOnceWith(11);
  });

  it("correction does not change source, playbackRate, segments or call transport", () => {
    const snapshot = JSON.stringify(segments);
    const source = audio.src;
    vi.mocked(audio.load).mockClear(); vi.mocked(audio.pause).mockClear(); vi.mocked(audio.play).mockClear();
    drift(-0.5); preview.checkDrift(0);
    expect(audio.currentTime).toBe(11);
    expect(audio.src).toBe(source);
    expect(audio.playbackRate).toBe(1);
    expect(JSON.stringify(segments)).toBe(snapshot);
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("dispose removes the listener and makes late checks inert", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    visibility(true); visibility(false);
    preview.dispose();
    drift(0.5);
    visibility(true); visibility(false);
    preview.checkDrift(0); preview.checkDrift(1000);
    expect(writeTime).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
