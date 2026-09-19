import { EditorVoiceoverRecorder, type VoiceoverRecording, type VoiceoverRecordingState } from "./editorVoiceoverRecorder";

export interface VoiceoverTransport {
  /** The editor's global timeline clock, never raw source currentTime. */
  time(): number;
  /** Must resolve when playback has started; reject playback/source errors. */
  play(): void | Promise<void>;
  /** Pause both the muted video and all audio preview tracks. */
  pause(): void;
}

type Recorder = Pick<EditorVoiceoverRecorder, "prepare" | "start" | "pause" | "resume" | "stop" | "dispose" | "error">;
export type VoiceoverSessionState = VoiceoverRecordingState | "starting" | "pausing" | "resuming";
export interface VoiceoverSessionOptions {
  transport: VoiceoverTransport;
  createRecorder?: (changed: (state: VoiceoverRecordingState) => void) => Recorder;
  changed?: (state: VoiceoverSessionState) => void;
  finished?: (result: VoiceoverRecording) => void;
}

/** Technical transport binding, with no UI, upload or timeline mutation.
 * The editor adapter routes seek/edit actions through runEditorAction, forwards
 * global timeline end (not individual source ended) and playback failures here.
 * Each instance owns one take. Dispose on project change or modal close.
 */
export class EditorVoiceoverSession {
  private currentState: VoiceoverSessionState = "idle";
  private currentError: Error | null = null;
  private recorder: Recorder | null = null;
  private disposed = false;
  private generation = 0;
  private initialTime: number | undefined;
  private completion: Promise<VoiceoverRecording | null> | null = null;
  private waiter: { state: VoiceoverRecordingState; resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private options: VoiceoverSessionOptions) {}
  get state() { return this.currentState; }
  get error() { return this.currentError; }
  get timelineStart() { return this.initialTime; }
  get actionsLocked() {
    return ["preparing", "starting", "recording", "pausing", "paused", "resuming", "stopping"].includes(this.state);
  }

  /** Applies equally to seek/scrub, clip edits, audio, annotation edits and undo. */
  runEditorAction(action: () => void): boolean {
    if (this.disposed || this.actionsLocked) return false;
    action();
    return true;
  }

  private setState(state: VoiceoverSessionState) {
    this.currentState = state;
    try { this.options.changed?.(state); } catch { /* Observer must not break cleanup. */ }
  }

  private release() {
    const recorder = this.recorder;
    this.recorder = null;
    recorder?.dispose();
  }

  private fail(cause: unknown): Error {
    if (this.currentError) return this.currentError;
    const detail = cause instanceof Error || cause instanceof DOMException ? cause.message : "Unbekannter Aufnahmefehler";
    const error = new Error(`Voice-over-Aufnahme abgebrochen: ${detail}`, { cause });
    this.currentError = error;
    this.generation++;
    try { this.options.transport.pause(); } catch { /* Recorder must still be released. */ }
    this.release();
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
    this.setState("error");
    return error;
  }

  private recorderChanged = (state: VoiceoverRecordingState) => {
    if (this.disposed || !this.recorder || this.currentError) return;
    if (state === "error") { this.fail(this.recorder.error); return; }
    if (this.waiter?.state === state) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve();
    }
  };

  private require(state: VoiceoverSessionState) {
    if (this.disposed || this.state !== state) throw new Error(`Aufnahme ist nicht ${state}.`);
  }

  private check(generation: number) {
    if (generation !== this.generation || this.disposed) throw this.currentError ?? new DOMException("Aufnahme abgebrochen.", "AbortError");
  }

  async prepare(): Promise<void> {
    this.require("idle");
    const generation = this.generation;
    this.setState("preparing");
    try {
      this.options.transport.pause();
      this.recorder = (this.options.createRecorder ?? (changed => new EditorVoiceoverRecorder({}, changed)))(this.recorderChanged);
      await this.recorder.prepare();
      this.check(generation);
      this.setState("ready");
    } catch (error) {
      if (generation !== this.generation || this.disposed) throw error;
      throw this.fail(error);
    }
  }

  async start(): Promise<void> {
    this.require("ready");
    const generation = this.generation;
    this.setState("starting");
    try {
      const time = this.options.transport.time();
      if (!Number.isFinite(time) || time < 0) throw new Error("Ungültige Timelinezeit.");
      this.initialTime = time;
      this.recorder!.start(time);
      await this.options.transport.play();
      this.check(generation);
      this.setState("recording");
    } catch (error) {
      // A late play resolution must not restart a cancelled/failed take.
      if (generation !== this.generation || this.disposed) {
        try { this.options.transport.pause(); } catch { /* Already cancelled. */ }
        throw error;
      }
      throw this.fail(error);
    }
  }

  private acknowledged(state: VoiceoverRecordingState, command: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiter = { state, resolve, reject };
      try { command(); } catch (error) { this.fail(error); }
    });
  }

  async pause(): Promise<void> {
    this.require("recording");
    const generation = this.generation;
    this.setState("pausing");
    try {
      this.options.transport.pause();
      await this.acknowledged("paused", () => this.recorder!.pause());
      this.check(generation);
      this.setState("paused");
    } catch (error) {
      if (generation !== this.generation || this.disposed) throw error;
      throw this.fail(error);
    }
  }

  async resume(): Promise<void> {
    this.require("paused");
    const generation = this.generation;
    this.setState("resuming");
    try {
      await this.acknowledged("recording", () => this.recorder!.resume());
      this.check(generation);
      await this.options.transport.play();
      this.check(generation);
      this.setState("recording");
    } catch (error) {
      if (generation !== this.generation || this.disposed) {
        try { this.options.transport.pause(); } catch { /* Already cancelled. */ }
        throw error;
      }
      throw this.fail(error);
    }
  }

  stop(): Promise<VoiceoverRecording | null> {
    if (this.currentError) return Promise.reject(this.currentError);
    if (this.completion) return this.completion;
    if (this.disposed) return Promise.resolve(null);
    if (["idle", "preparing", "ready", "starting"].includes(this.state)) {
      this.dispose();
      return Promise.resolve(null);
    }
    const generation = ++this.generation;
    this.waiter?.reject(new DOMException("Aufnahme wird gestoppt.", "AbortError"));
    this.waiter = null;
    this.setState("stopping");
    // Defer work so repeated stop/end calls share the same promise, even with synchronous mocks.
    this.completion = Promise.resolve().then(async () => {
      try {
        this.check(generation);
        this.options.transport.pause();
        const result = await this.recorder!.stop();
        this.check(generation);
        if (!result || result.timelineStart !== this.initialTime) throw new Error("Unvollständiges Aufnahmeergebnis.");
        this.release();
        this.setState("finished");
        try { this.options.finished?.(result); } catch { /* Result remains available from stop(). */ }
        return result;
      } catch (error) {
        if (generation !== this.generation || this.disposed) throw error;
        throw this.fail(error);
      }
    });
    return this.completion;
  }

  /** Forward only the end of the entire timeline, not a source/clip boundary. */
  timelineEnded(): Promise<VoiceoverRecording | null> {
    return this.actionsLocked || this.state === "finished" ? this.stop() : Promise.resolve(null);
  }

  /** Includes preview playback errors and buffering interruptions during a take. */
  transportFailed(error: unknown) {
    if (!this.disposed && this.actionsLocked) this.fail(error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    try { this.options.transport.pause(); } catch { /* Always close microphone. */ }
    this.release();
    this.waiter?.reject(new DOMException("Aufnahme abgebrochen.", "AbortError"));
    this.waiter = null;
    this.setState("idle");
  }
}
