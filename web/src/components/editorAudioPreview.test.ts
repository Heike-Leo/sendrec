import { beforeEach, describe, expect, it, vi } from "vitest";
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
  let segments: typeof first[];
  let url: ReturnType<typeof vi.fn<(id: string) => string | Promise<string>>>;
  let error: ReturnType<typeof vi.fn<(message: string | null) => void>>;
  function metadata() { audio.dispatchEvent(new Event("loadedmetadata")); }

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
    preview = new EditorAudioPreview(audio, { segments: () => segments, time: () => time, url, error });
  });

  it("starts the segment source at sourceStart plus timeline offset", () => {
    time = 0.75;
    preview.sync(true, true);
    metadata();
    expect(audio.src).toBe("https://media.example/one.mp4");
    expect(audio.currentTime).toBe(3.75);
    expect(audio.play).toHaveBeenCalledTimes(1);
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
