import { describe, expect, it, vi } from "vitest";
import { EditorVoiceoverSession } from "./editorVoiceoverSession";
import { EditorVoiceoverRecorder, type VoiceoverRecording, type VoiceoverRecordingState } from "./editorVoiceoverRecorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  let changed!: (state: VoiceoverRecordingState) => void;
  let time = 2;
  const result: VoiceoverRecording = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", byteSize: 5,
    duration: 3, startTimestamp: 123, timelineStart: 2 };
  const recorder = {
    error: null as Error | null,
    prepare: vi.fn(async () => { changed("ready"); }),
    start: vi.fn(() => { changed("recording"); return 123; }),
    pause: vi.fn(() => changed("paused")),
    resume: vi.fn(() => changed("recording")),
    stop: vi.fn(async () => { changed("finished"); return result; }),
    dispose: vi.fn(() => changed("idle")),
  };
  const transport = { time: vi.fn(() => time), play: vi.fn<() => void | Promise<void>>(() => Promise.resolve()), pause: vi.fn() };
  const finished = vi.fn();
  const createRecorder = vi.fn((callback: (state: VoiceoverRecordingState) => void) => { changed = callback; return recorder; });
  const session = new EditorVoiceoverSession({ transport, createRecorder, finished });
  return { session, transport, recorder, result, finished, createRecorder, setTime: (value: number) => { time = value; },
    emit: (state: VoiceoverRecordingState) => changed(state) };
}

describe("voiceover timeline transport session", () => {
  it("prepares while timeline stays paused, then captures start once", async () => {
    const s = setup(); const permission = deferred<void>();
    s.recorder.prepare.mockReturnValueOnce(permission.promise);
    const prepared = s.session.prepare();
    expect(s.session.state).toBe("preparing");
    expect(s.transport.pause).toHaveBeenCalledTimes(1);
    expect(s.transport.play).not.toHaveBeenCalled();
    expect(s.transport.time).not.toHaveBeenCalled();
    await expect(s.session.start()).rejects.toThrow();
    permission.resolve(); await prepared;
    expect(s.session.state).toBe("ready");
    s.setTime(4.25); await s.session.start();
    expect(s.session.timelineStart).toBe(4.25);
    expect(s.recorder.start).toHaveBeenCalledWith(4.25);
    expect(s.transport.play).toHaveBeenCalledTimes(1);
    expect(s.recorder.start.mock.invocationCallOrder[0]).toBeLessThan(s.transport.play.mock.invocationCallOrder[0]);
    await expect(s.session.start()).rejects.toThrow();
    expect(s.recorder.start).toHaveBeenCalledTimes(1);
    s.session.dispose();
  });

  it("pauses both and resumes only after recorder acknowledgement, preserving start", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    s.recorder.pause.mockImplementationOnce(() => undefined);
    const paused = s.session.pause();
    expect(s.session.state).toBe("pausing");
    expect(s.transport.pause).toHaveBeenCalledTimes(2);
    await expect(s.session.resume()).rejects.toThrow();
    s.emit("paused"); await paused;
    expect(s.session.state).toBe("paused");
    s.recorder.resume.mockImplementationOnce(() => undefined);
    const resumed = s.session.resume();
    expect(s.transport.play).toHaveBeenCalledTimes(1);
    s.emit("recording"); await resumed;
    expect(s.session.state).toBe("recording");
    expect(s.transport.play).toHaveBeenCalledTimes(2);
    expect(s.transport.time).toHaveBeenCalledTimes(1);
    expect(s.session.timelineStart).toBe(2);
    expect(s.createRecorder).toHaveBeenCalledTimes(1);
    s.session.dispose();
  });

  it.each([false, true])("stops once, awaits final data and preserves result (paused=%s)", async paused => {
    const s = setup(); await s.session.prepare(); await s.session.start(); if (paused) await s.session.pause();
    const final = deferred<VoiceoverRecording>(); s.recorder.stop.mockReturnValueOnce(final.promise);
    const stopped = s.session.stop();
    expect(s.session.stop()).toBe(stopped);
    expect(s.session.timelineEnded()).toBe(stopped);
    await Promise.resolve();
    expect(s.recorder.stop).toHaveBeenCalledTimes(1);
    expect(s.session.state).toBe("stopping"); expect(s.finished).not.toHaveBeenCalled();
    final.resolve(s.result); expect(await stopped).toBe(s.result);
    expect(s.session.state).toBe("finished");
    expect(s.finished).toHaveBeenCalledExactlyOnceWith(s.result);
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    expect(await s.session.stop()).toBe(s.result);
  });

  it("automatically completes at global timeline end", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    expect(await s.session.timelineEnded()).toBe(s.result);
    expect(s.transport.pause).toHaveBeenCalledTimes(2);
    expect(s.recorder.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["seek", "scrub", "split", "clip move", "clip resize", "insert", "audio", "annotation", "undo"])("blocks %s while recording and paused", async () => {
    const s = setup(); const edit = vi.fn();
    expect(s.session.runEditorAction(edit)).toBe(true);
    await s.session.prepare(); await s.session.start();
    expect(s.session.runEditorAction(edit)).toBe(false);
    await s.session.pause(); expect(s.session.runEditorAction(edit)).toBe(false);
    const stop = s.session.stop(); expect(s.session.runEditorAction(edit)).toBe(false); await stop;
    expect(s.session.runEditorAction(edit)).toBe(true);
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("recorder failure pauses transport and rejects any partial result", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    s.recorder.error = new Error("device removed"); s.emit("error");
    expect(s.session.state).toBe("error");
    expect(s.session.error?.message).toContain("device removed");
    expect(s.transport.pause).toHaveBeenCalledTimes(2);
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    await expect(s.session.stop()).rejects.toThrow("device removed");
    expect(s.finished).not.toHaveBeenCalled();
  });

  it.each(["start", "resume", "pause", "stop"])("cleans up on transport %s failure", async operation => {
    const s = setup(); await s.session.prepare();
    if (operation !== "start") await s.session.start();
    if (operation === "resume") await s.session.pause();
    if (operation === "start" || operation === "resume") s.transport.play.mockRejectedValueOnce(new Error("play denied"));
    else s.transport.pause.mockImplementationOnce(() => { throw new Error("pause failed"); });
    await expect(s.session[operation as "start" | "pause" | "resume" | "stop"]()).rejects.toThrow();
    expect(s.session.state).toBe("error"); expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    expect(s.finished).not.toHaveBeenCalled();
  });

  it("forwards playback/device/source failures during recording", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    s.session.transportFailed(new Error("source unavailable"));
    expect(s.session.state).toBe("error"); expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    expect(s.transport.pause).toHaveBeenCalledTimes(2);
  });

  it.each(["preparing", "ready", "starting"])("cancels from %s without producing a recording", async state => {
    const s = setup(); const pending = deferred<void>();
    let operation: Promise<void> | undefined;
    if (state === "preparing") { s.recorder.prepare.mockReturnValueOnce(pending.promise); operation = s.session.prepare(); }
    else {
      await s.session.prepare();
      if (state === "starting") { s.transport.play.mockReturnValueOnce(pending.promise); operation = s.session.start(); }
    }
    const assertion = operation ? expect(operation).rejects.toThrow() : null;
    expect(await s.session.stop()).toBeNull();
    pending.resolve(); if (assertion) await assertion;
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1); expect(s.finished).not.toHaveBeenCalled();
    expect(s.session.state).toBe("idle");
  });

  it("stop supersedes pending pause acknowledgement", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    s.recorder.pause.mockImplementationOnce(() => undefined);
    const pausing = s.session.pause(); const cancelled = expect(pausing).rejects.toThrow();
    expect(await s.session.stop()).toBe(s.result); await cancelled;
    s.emit("paused"); expect(s.session.state).toBe("finished");
  });

  it("transport failure while stopping cannot deliver success", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    const pending = deferred<VoiceoverRecording>(); s.recorder.stop.mockReturnValueOnce(pending.promise);
    const stop = s.session.stop(); const failed = expect(stop).rejects.toThrow("failed"); await Promise.resolve();
    s.session.transportFailed(new Error("failed")); pending.resolve(s.result); await failed;
    expect(s.finished).not.toHaveBeenCalled();
  });

  it("preparation failure keeps timeline paused and disposes recorder", async () => {
    const s = setup(); s.recorder.prepare.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(s.session.prepare()).rejects.toThrow("Permission denied");
    expect(s.transport.play).not.toHaveBeenCalled();
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    expect(s.session.state).toBe("error");
  });

  it("rejects invalid start time without starting either engine", async () => {
    const s = setup(); await s.session.prepare(); s.setTime(NaN);
    await expect(s.session.start()).rejects.toThrow("Timelinezeit");
    expect(s.recorder.start).not.toHaveBeenCalled(); expect(s.transport.play).not.toHaveBeenCalled();
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects finalization failure without delivering finished", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    s.recorder.stop.mockRejectedValueOnce(new Error("encoding failed"));
    await expect(s.session.stop()).rejects.toThrow("encoding failed");
    expect(s.session.state).toBe("error"); expect(s.finished).not.toHaveBeenCalled();
  });

  it("dispose immediately after stop cancels deferred completion safely", async () => {
    const s = setup(); await s.session.prepare(); await s.session.start();
    const done = s.session.stop(); const assertion = expect(done).rejects.toMatchObject({ name: "AbortError" });
    s.session.dispose(); await assertion;
    expect(s.recorder.dispose).toHaveBeenCalledTimes(1);
    expect(s.finished).not.toHaveBeenCalled();
  });

  it("uses real recorder timing, excludes pauses and releases the real stream on finish", async () => {
    let time = 0;
    const track = Object.assign(new EventTarget(), { readyState: "live", stop: vi.fn() });
    const stream = Object.assign(new EventTarget(), { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) as unknown as MediaStream;
    const events = new EventTarget();
    const media = Object.assign(events, {
      state: "inactive" as RecordingState, mimeType: "audio/webm;codecs=opus",
      start() { this.state = "recording"; },
      pause() { this.state = "paused"; events.dispatchEvent(new Event("pause")); },
      resume() { this.state = "recording"; events.dispatchEvent(new Event("resume")); },
      stop() { this.state = "inactive"; },
    });
    const transport = { time: () => 2.75, play: vi.fn(), pause: vi.fn() };
    const session = new EditorVoiceoverSession({ transport,
      createRecorder: changed => new EditorVoiceoverRecorder({ getUserMedia: async () => stream, isTypeSupported: () => true,
        createRecorder: () => media as unknown as MediaRecorder, now: () => time }, changed) });
    await session.prepare(); time = 10000; await session.start();
    time = 11000; await session.pause(); time = 21000; await session.resume();
    time = 23000; const stop = session.stop(); await Promise.resolve();
    const data = new Event("dataavailable"); Object.defineProperty(data, "data", { value: new Blob(["last"]) });
    media.dispatchEvent(data); media.dispatchEvent(new Event("stop"));
    expect(await stop).toMatchObject({ timelineStart: 2.75, duration: 3, byteSize: 4, startTimestamp: 10000 });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
