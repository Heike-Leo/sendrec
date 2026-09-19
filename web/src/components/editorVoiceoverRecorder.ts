export type VoiceoverRecordingState = "idle" | "preparing" | "ready" | "recording" | "paused" | "stopping" | "finished" | "error";

export interface VoiceoverRecording {
  blob: Blob;
  mimeType: string;
  byteSize: number;
  /** Locally measured active seconds, not authoritative encoded media duration. */
  duration: number;
  /** Monotonic milliseconds at the successful start call, not wall-clock time. */
  startTimestamp: number;
  timelineStart: number | undefined;
}

interface Dependencies {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  isTypeSupported: (mime: string) => boolean;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  now: () => number;
}

const formats = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];

/** One take per controller. No upload, monitoring, video clock or object URLs. */
export class EditorVoiceoverRecorder {
  private currentState: VoiceoverRecordingState = "idle";
  private lastError: Error | null = null;
  get state() { return this.currentState; }
  get error() { return this.lastError; }
  private disposed = false;
  private generation = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private removeListeners: Array<() => void> = [];
  private activeSince: number | null = null;
  private elapsed = 0;
  private started = 0;
  private timelineStart: number | undefined;
  private pendingTransport: "pause" | "resume" | null = null;
  private stopPromise: Promise<VoiceoverRecording | null> | null = null;
  private resolveStop: ((result: VoiceoverRecording | null) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private readonly deps: Dependencies;

  constructor(dependencies: Partial<Dependencies> = {}, private onStateChange?: (state: VoiceoverRecordingState) => void) {
    this.deps = {
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
      isTypeSupported: mime => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
      createRecorder: (stream, options) => new MediaRecorder(stream, options),
      now: () => performance.now(),
      ...dependencies,
    };
  }

  private transition(state: VoiceoverRecordingState) {
    this.currentState = state;
    // Consumer callbacks must not prevent microphone cleanup.
    try { this.onStateChange?.(state); } catch { /* Consumer owns its notification errors. */ }
  }

  private listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.removeListeners.push(() => target.removeEventListener(type, listener));
  }

  private release() {
    this.removeListeners.splice(0).forEach(remove => remove());
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* Still release the microphone. */ }
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.chunks = [];
    this.activeSince = null;
    this.pendingTransport = null;
  }

  private fail(cause: unknown): Error {
    const error = cause instanceof Error || cause instanceof DOMException ? cause : new Error("Mikrofonaufnahme fehlgeschlagen.");
    this.lastError = error;
    this.generation++;
    this.release();
    const reject = this.rejectStop;
    this.resolveStop = this.rejectStop = null;
    this.stopPromise = null;
    this.transition("error");
    reject?.(error);
    return error;
  }

  /** Await permission and construction before starting the editor timeline. */
  async prepare(): Promise<void> {
    if (this.disposed || this.state !== "idle") throw new Error("Aufnahme kann nicht vorbereitet werden.");
    const generation = ++this.generation;
    this.transition("preparing");
    try {
      const mimeType = formats.find(mime => this.deps.isTypeSupported(mime));
      if (!mimeType) throw new Error("Kein unterstütztes Audio-Aufnahmeformat verfügbar.");
      const stream = await this.deps.getUserMedia({ audio: true });
      if (this.disposed || generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        throw new DOMException("Aufnahmevorbereitung abgebrochen.", "AbortError");
      }
      this.stream = stream;
      if (!stream.getAudioTracks().length || stream.getVideoTracks().length || stream.getAudioTracks().some(track => track.readyState === "ended")) {
        throw new Error("Kein aktiver reiner Mikrofonstream verfügbar.");
      }
      const recorder = this.deps.createRecorder(stream, { mimeType });
      this.recorder = recorder;
      this.listen(recorder, "dataavailable", event => {
        const data = (event as BlobEvent).data;
        if (data.size > 0) this.chunks.push(data);
      });
      this.listen(recorder, "error", event => this.fail((event as Event & { error?: DOMException }).error));
      this.listen(recorder, "pause", () => {
        if (this.pendingTransport === "pause" && this.state === "recording") {
          this.pendingTransport = null;
          this.transition("paused");
        }
      });
      this.listen(recorder, "resume", () => {
        if (this.pendingTransport === "resume" && this.state === "paused") {
          this.pendingTransport = null;
          this.transition("recording");
        }
      });
      this.listen(recorder, "stop", () => {
        if (this.state !== "stopping") { this.fail(new Error("Mikrofonaufnahme wurde unerwartet beendet.")); return; }
        // MediaRecorder queues its final dataavailable before stop.
        const mimeType = recorder.mimeType || this.chunks.find(chunk => chunk.type)?.type;
        if (!mimeType || !this.chunks.length) { this.fail(new Error("Keine Audiodaten aufgenommen.")); return; }
        const blob = new Blob(this.chunks, { type: mimeType });
        const result: VoiceoverRecording = { blob, mimeType, byteSize: blob.size, duration: this.elapsed / 1000,
          startTimestamp: this.started, timelineStart: this.timelineStart };
        const resolve = this.resolveStop;
        this.resolveStop = this.rejectStop = null;
        this.stopPromise = null;
        this.release();
        this.transition("finished");
        resolve?.(result);
      });
      this.listen(stream, "inactive", () => this.fail(new Error("Das Mikrofon ist nicht mehr verfügbar.")));
      stream.getAudioTracks().forEach(track => {
        this.listen(track, "ended", () => this.fail(new Error("Das Mikrofon wurde getrennt.")));
        this.listen(track, "mute", () => this.fail(new Error("Das Mikrofon liefert kein Audiosignal mehr.")));
      });
      this.transition("ready");
    } catch (error) {
      if (generation !== this.generation || this.disposed) throw error;
      throw this.fail(error);
    }
  }

  start(timelineStart?: number): number {
    if (this.disposed || this.state !== "ready") throw new Error("Aufnahme ist nicht startbereit.");
    if (timelineStart !== undefined && (!Number.isFinite(timelineStart) || timelineStart < 0)) throw new Error("Ungültige Timeline-Startzeit.");
    try {
      this.recorder!.start();
      this.started = this.deps.now();
      this.activeSince = this.started;
      this.timelineStart = timelineStart;
      this.transition("recording");
      return this.started;
    } catch (error) { throw this.fail(error); }
  }

  private endActiveInterval() {
    if (this.activeSince !== null) {
      this.elapsed += Math.max(0, this.deps.now() - this.activeSince);
      this.activeSince = null;
    }
  }

  pause() {
    if (this.disposed || this.state !== "recording" || this.pendingTransport) throw new Error("Aufnahme kann gerade nicht pausiert werden.");
    try {
      this.pendingTransport = "pause";
      this.endActiveInterval();
      this.recorder!.pause();
    }
    catch (error) { throw this.fail(error); }
  }

  resume() {
    if (this.disposed || this.state !== "paused" || this.pendingTransport) throw new Error("Aufnahme kann gerade nicht fortgesetzt werden.");
    try {
      this.pendingTransport = "resume";
      this.activeSince = this.deps.now();
      this.recorder!.resume();
    }
    catch (error) { throw this.fail(error); }
  }

  /** null means cancelled before start; errors reject. Duplicate stop shares completion. */
  stop(): Promise<VoiceoverRecording | null> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "error") return Promise.reject(this.error);
    if (this.state !== "recording" && this.state !== "paused") {
      this.generation++;
      this.release();
      if (!this.disposed && this.state !== "finished") this.transition("idle");
      return Promise.resolve(null);
    }
    this.endActiveInterval();
    this.pendingTransport = null;
    const pending = new Promise<VoiceoverRecording | null>((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject; });
    this.stopPromise = pending;
    this.transition("stopping");
    try { this.recorder!.stop(); } catch (error) { this.fail(error); }
    return pending;
  }

  /** Discards the take, including a pending final chunk. Safe to call repeatedly. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    const resolve = this.resolveStop;
    this.resolveStop = this.rejectStop = null;
    this.stopPromise = null;
    this.release();
    this.transition("idle");
    this.onStateChange = undefined;
    resolve?.(null);
  }
}
