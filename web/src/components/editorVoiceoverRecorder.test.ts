import { describe, expect, it, vi } from "vitest";
import { EditorVoiceoverRecorder } from "./editorVoiceoverRecorder";

class Track extends EventTarget {
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
}
class Recorder extends EventTarget {
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  start = vi.fn(() => { this.state = "recording"; });
  pause = vi.fn(() => { this.state = "paused"; this.dispatchEvent(new Event("pause")); });
  resume = vi.fn(() => { this.state = "recording"; this.dispatchEvent(new Event("resume")); });
  stop = vi.fn(() => { this.state = "inactive"; });
  data(text: string, type = this.mimeType) {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", { value: new Blob([text], { type }) });
    this.dispatchEvent(event);
  }
  finish() { this.dispatchEvent(new Event("stop")); }
}

function setup(supported = ["audio/webm;codecs=opus"]) {
  let clock = 100;
  const track = new Track();
  const rawStream = new EventTarget();
  const stream = Object.assign(rawStream, { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) as unknown as MediaStream;
  const recorder = new Recorder();
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  const isTypeSupported = vi.fn((mime: string) => supported.includes(mime));
  const createRecorder = vi.fn((_stream: MediaStream, options: MediaRecorderOptions) => {
    recorder.mimeType = options.mimeType!;
    return recorder as unknown as MediaRecorder;
  });
  const changed = vi.fn();
  const controller = new EditorVoiceoverRecorder({ getUserMedia, isTypeSupported, createRecorder, now: () => clock }, changed);
  return { controller, recorder, stream, track, getUserMedia, isTypeSupported, createRecorder, changed, time: (value: number) => { clock = value; } };
}

describe("isolated voiceover recorder", () => {
  it("prepares microphone only before timeline start and prefers Opus", async () => {
    const s = setup();
    expect(s.controller.state).toBe("idle");
    const preparing = s.controller.prepare();
    expect(s.controller.state).toBe("preparing");
    expect(() => s.controller.start()).toThrow();
    await preparing;
    expect(s.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(s.createRecorder).toHaveBeenCalledWith(s.stream, { mimeType: "audio/webm;codecs=opus" });
    expect(s.controller.state).toBe("ready");
    expect(s.recorder.start).not.toHaveBeenCalled();
    s.time(2000);
    expect(s.controller.start(2)).toBe(2000);
    expect(s.controller.state).toBe("recording");
    s.controller.dispose();
  });

  it.each(["audio/mp4;codecs=mp4a.40.2", "audio/mp4"])("falls back to supported %s and reports actual recorder MIME", async mime => {
    const s = setup([mime]);
    await s.controller.prepare();
    expect(s.createRecorder).toHaveBeenCalledWith(s.stream, { mimeType: mime });
    s.recorder.mimeType = "audio/mp4";
    s.controller.start();
    const done = s.controller.stop();
    s.recorder.data("aac"); s.recorder.finish();
    const result = await done;
    expect(result?.mimeType).toBe("audio/mp4");
    expect(result?.blob.type).toBe("audio/mp4");
  });

  it("measures active time, excludes pauses, waits for final data and reuses recorder", async () => {
    const s = setup();
    await s.controller.prepare();
    const added = vi.spyOn(s.recorder, "addEventListener");
    const removed = vi.spyOn(s.recorder, "removeEventListener");
    s.controller.start(2);
    s.recorder.data("first");
    s.time(1100); s.controller.pause();
    expect(s.controller.state).toBe("paused");
    s.time(9100); s.controller.resume();
    expect(s.controller.state).toBe("recording");
    s.time(11100);
    const done = s.controller.stop();
    expect(s.controller.stop()).toBe(done);
    expect(s.controller.state).toBe("stopping");
    let settled = false;
    void done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    s.time(15000); // Encoding/stop-event delay must not count as recording time.
    s.recorder.data("last");
    expect(s.controller.state).toBe("stopping");
    s.recorder.finish();
    const result = await done;
    expect(result).toMatchObject({ duration: 3, startTimestamp: 100, timelineStart: 2, byteSize: 9 });
    expect(result?.blob.size).toBe(9);
    expect(s.controller.state).toBe("finished");
    expect(s.createRecorder).toHaveBeenCalledTimes(1);
    expect(s.recorder.pause).toHaveBeenCalledTimes(1);
    expect(s.recorder.resume).toHaveBeenCalledTimes(1);
    expect(s.track.stop).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(["dataavailable", "error", "pause", "resume", "stop"]);
    expect(added).not.toHaveBeenCalled();
    s.track.dispatchEvent(new Event("ended"));
    s.recorder.dispatchEvent(new Event("error"));
    expect(s.controller.state).toBe("finished");
  });

  it("stops from paused without counting the pause", async () => {
    const s = setup(); await s.controller.prepare(); s.controller.start();
    s.time(600); s.controller.pause(); s.time(50000);
    const done = s.controller.stop(); s.recorder.data("x"); s.recorder.finish();
    expect((await done)?.duration).toBe(.5);
    expect(s.recorder.resume).not.toHaveBeenCalled();
  });

  it.each(["NotAllowedError", "NotFoundError", "NotReadableError"])("reports %s without holding resources", async name => {
    const s = setup(); const error = new DOMException("microphone", name);
    s.getUserMedia.mockRejectedValueOnce(error);
    await expect(s.controller.prepare()).rejects.toBe(error);
    expect(s.controller.state).toBe("error");
    expect(s.controller.error).toBe(error);
    expect(s.createRecorder).not.toHaveBeenCalled();
  });

  it("rejects unsupported formats before requesting microphone permission", async () => {
    const s = setup([]);
    await expect(s.controller.prepare()).rejects.toThrow("Aufnahmeformat");
    expect(s.getUserMedia).not.toHaveBeenCalled();
    expect(s.controller.state).toBe("error");
  });

  it.each(["create", "start", "pause", "resume", "stop"])("cleans up after recorder %s failure", async operation => {
    const s = setup(); const error = new Error("recorder failed");
    if (operation === "create") s.createRecorder.mockImplementationOnce(() => { throw error; });
    if (operation === "create") await expect(s.controller.prepare()).rejects.toBe(error);
    else {
      await s.controller.prepare();
      if (operation !== "start") s.controller.start();
      if (operation === "resume") s.controller.pause();
      s.recorder[operation as "start" | "pause" | "resume" | "stop"].mockImplementationOnce(() => { throw error; });
      if (operation === "stop") await expect(s.controller.stop()).rejects.toBe(error);
      else expect(() => s.controller[operation as "start" | "pause" | "resume"]()).toThrow(error);
    }
    expect(s.controller.state).toBe("error");
    expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["ended", "mute", "inactive", "error", "stop"])("fails and releases on unexpected %s", async event => {
    const s = setup(); await s.controller.prepare(); s.controller.start();
    const target = event === "ended" || event === "mute" ? s.track : event === "inactive" ? s.stream : s.recorder;
    target.dispatchEvent(new Event(event));
    expect(s.controller.state).toBe("error");
    expect(s.controller.error).toBeInstanceOf(Error);
    expect(s.track.stop).toHaveBeenCalledTimes(1);
    expect(s.recorder.state).toBe("inactive");
    await expect(s.controller.stop()).rejects.toBe(s.controller.error);
  });

  it("rejects pending completion on recorder error, never returning a partial blob", async () => {
    const s = setup(); await s.controller.prepare(); s.controller.start(); s.recorder.data("partial");
    const done = s.controller.stop();
    const assertion = expect(done).rejects.toThrow();
    s.recorder.dispatchEvent(new Event("error"));
    await assertion;
    s.recorder.finish(); expect(s.controller.state).toBe("error");
  });

  it("rejects double prepare/start without disturbing the active take", async () => {
    const s = setup(); const first = s.controller.prepare();
    await expect(s.controller.prepare()).rejects.toThrow(); await first;
    expect(() => s.controller.start(-1)).toThrow();
    s.controller.start(); expect(() => s.controller.start()).toThrow();
    expect(s.recorder.start).toHaveBeenCalledTimes(1);
    expect(s.controller.state).toBe("recording"); s.controller.dispose();
  });

  it.each(["stop", "dispose"] as const)("handles %s while permission is pending and releases the late stream", async operation => {
    const s = setup(); let grant!: (stream: MediaStream) => void;
    s.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    const preparing = s.controller.prepare();
    const assertion = expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    await s.controller[operation]();
    expect(s.controller.state).toBe("idle");
    grant(s.stream); await assertion;
    expect(s.track.stop).toHaveBeenCalledTimes(1);
    expect(s.createRecorder).not.toHaveBeenCalled();
  });

  it.each(["ready", "recording", "paused", "stopping"])("dispose in %s removes listeners, stops tracks and discards chunks", async state => {
    const s = setup();
    const removed = vi.spyOn(s.track, "removeEventListener");
    await s.controller.prepare();
    if (state !== "ready") { s.controller.start(); s.recorder.data("discard"); }
    if (state === "paused") s.controller.pause();
    const pending = state === "stopping" ? s.controller.stop() : null;
    s.controller.dispose(); s.controller.dispose();
    if (pending) expect(await pending).toBeNull();
    expect(s.track.stop).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("ended", expect.any(Function));
    s.recorder.data("late"); s.recorder.finish(); s.track.dispatchEvent(new Event("ended"));
    expect(s.controller.state).toBe("idle");
    expect(() => s.controller.start()).toThrow();
    await expect(s.controller.prepare()).rejects.toThrow();
  });

  it("rejects empty results rather than inventing a recording", async () => {
    const s = setup(); await s.controller.prepare(); s.controller.start();
    const done = s.controller.stop(); const assertion = expect(done).rejects.toThrow("Keine Audiodaten");
    s.recorder.data(""); s.recorder.finish(); await assertion;
    expect(s.controller.state).toBe("error"); expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for asynchronous pause/resume acknowledgement and prevents conflicting commands", async () => {
    const s = setup(); await s.controller.prepare(); s.controller.start();
    s.recorder.pause.mockImplementationOnce(() => undefined);
    s.controller.pause();
    expect(s.controller.state).toBe("recording");
    expect(() => s.controller.resume()).toThrow();
    expect(() => s.controller.pause()).toThrow();
    s.recorder.dispatchEvent(new Event("pause"));
    expect(s.controller.state).toBe("paused");
    s.recorder.resume.mockImplementationOnce(() => undefined);
    s.controller.resume();
    expect(s.controller.state).toBe("paused");
    expect(() => s.controller.resume()).toThrow();
    const done = s.controller.stop();
    s.recorder.dispatchEvent(new Event("resume"));
    expect(s.controller.state).toBe("stopping");
    s.recorder.data("final"); s.recorder.finish();
    expect((await done)?.byteSize).toBe(5);
  });

  it("falls back to the actual chunk MIME if recorder does not expose it", async () => {
    const s = setup(); await s.controller.prepare(); s.recorder.mimeType = ""; s.controller.start();
    const done = s.controller.stop(); s.recorder.data("data", "audio/webm;codecs=opus"); s.recorder.finish();
    expect((await done)?.mimeType).toBe("audio/webm;codecs=opus");
  });
});
