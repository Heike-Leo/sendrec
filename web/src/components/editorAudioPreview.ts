// Playback-only view of the existing persisted segments. No separate timeline state.
interface AudioSegment {
  id: string;
  sourceVideoId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
}

interface PreviewOptions {
  segments: () => readonly AudioSegment[];
  time: () => number;
  url: (sourceId: string) => string | Promise<string>;
  error: (message: string | null) => void;
  canCheckDrift?: () => boolean;
}

export class EditorAudioPreview {
  private generation = 0;
  private playing = false;
  private disposed = false;
  private segment: AudioSegment | null = null;
  private source: string | null = null;
  private sourceUrl: string | null = null;
  private pending = false;
  private blocked = false;
  private alignOnPlaying = false;
  private cancelLoad: (() => void) | null = null;
  private buffering = false;
  private lastDriftCheck = -Infinity;
  private correctionUntil = -Infinity;
  private driftDirection = 0;
  private wasHidden = document.hidden;
  private visibilityResyncPending = false;

  constructor(private audio: HTMLAudioElement, private options: PreviewOptions) {
    audio.addEventListener("playing", this.guardPlayback);
    audio.addEventListener("error", this.mediaError);
    audio.addEventListener("waiting", this.audioWaiting);
    for (const event of ["seeking", "pause", "ended"]) audio.addEventListener(event, this.resetDriftConfirmation);
    document.addEventListener("visibilitychange", this.visibilityChanged);
  }

  private resetDriftConfirmation = () => { this.driftDirection = 0; };

  private audioWaiting = () => {
    this.buffering = true;
    this.resetDriftConfirmation();
  };

  private visibilityChanged = () => {
    if (this.disposed) return;
    if (this.wasHidden && !document.hidden) this.visibilityResyncPending = true;
    this.wasHidden = document.hidden;
    this.resetDriftConfirmation();
  };

  private driftTarget() {
    if (document.hidden || !this.options.canCheckDrift?.() || !this.playing ||
      this.pending || this.blocked || this.alignOnPlaying || this.buffering ||
      this.audio.paused || this.audio.seeking || this.audio.ended || this.audio.error ||
      this.audio.readyState < 3 || !this.segment || !this.sourceUrl ||
      this.audio.src !== this.sourceUrl ||
      (this.audio.currentSrc && this.audio.currentSrc !== this.sourceUrl)) return null;
    const time = this.options.time();
    const active = this.options.segments().filter((item) =>
      item.sourceEnd > item.sourceStart && time >= item.timelineStart &&
      time < item.timelineStart + item.sourceEnd - item.sourceStart,
    );
    if (active.length !== 1 || active[0].sourceVideoId !== this.source ||
      JSON.stringify(active[0]) !== JSON.stringify(this.segment)) return null;
    const target = active[0].sourceStart + time - active[0].timelineStart;
    return Number.isFinite(target) && Number.isFinite(this.audio.currentTime) ? target : null;
  }

  // Called by the existing preview timer. This method never controls transport.
  checkDrift(now = performance.now()) {
    if (this.disposed || now - this.lastDriftCheck < 250) return;
    this.lastDriftCheck = now;
    const target = this.driftTarget();
    if (target === null || now < this.correctionUntil) {
      this.resetDriftConfirmation();
      return;
    }
    const drift = this.audio.currentTime - target;
    const magnitude = Math.abs(drift);
    const direction = Math.sign(drift);
    // Epsilon keeps exact 100/250-ms boundaries stable in floating-point seconds.
    if (!this.visibilityResyncPending) {
      if (magnitude <= 0.1 + 1e-9) {
        this.resetDriftConfirmation();
        return;
      }
      if (magnitude < 0.25 - 1e-9 && this.driftDirection !== direction) {
        this.driftDirection = direction;
        return;
      }
    }
    // Re-read master time and revalidate the source/segment immediately before seeking.
    const freshTarget = this.driftTarget();
    this.resetDriftConfirmation();
    if (freshTarget === null) return;
    const freshDrift = this.audio.currentTime - freshTarget;
    if (!this.visibilityResyncPending &&
      (Math.abs(freshDrift) <= 0.1 + 1e-9 || Math.sign(freshDrift) !== direction)) return;
    this.visibilityResyncPending = false;
    this.correctionUntil = now + 1000;
    try {
      this.audio.currentTime = freshTarget;
    } catch {
      // A media source may become unseekable; leave recovery to existing transport paths.
    }
  }

  private guardPlayback = () => {
    this.buffering = false;
    if (!this.playing || this.disposed || this.pending) {
      this.audio.pause();
      return;
    }
    // Loading/buffering may have taken time after play() was requested.
    if (this.alignOnPlaying && this.segment) {
      this.alignOnPlaying = false;
      const time = this.options.time();
      const segment = this.segment;
      if (time < segment.timelineStart || time >= segment.timelineStart + segment.sourceEnd - segment.sourceStart) {
        this.sync(true, true);
      } else {
        this.audio.currentTime = segment.sourceStart + time - segment.timelineStart;
      }
    }
  };

  private mediaError = () => {
    if (!this.disposed && this.segment) {
      this.stop();
      this.blocked = true;
      this.options.error("Audiovorschau konnte nicht geladen werden.");
    }
  };

  stop() {
    this.resetDriftConfirmation();
    this.playing = false;
    this.generation++;
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.pending = false;
    this.alignOnPlaying = false;
    this.segment = null;
    this.audio.pause();
  }

  sync(playing: boolean, force = false) {
    if (this.disposed) return;
    if (this.blocked && !force) return;
    if (force) this.blocked = false;
    const time = this.options.time();
    const segment = this.options.segments().find((item) =>
      item.sourceEnd > item.sourceStart && time >= item.timelineStart &&
      time < item.timelineStart + item.sourceEnd - item.sourceStart,
    ) ?? null;
    const previous = this.segment;
    const wasPlaying = this.playing;
    this.playing = playing;
    if (!segment) {
      this.stop();
      return;
    }
    if (!force && wasPlaying === playing && previous &&
      JSON.stringify(previous) === JSON.stringify(segment)) return;

    this.resetDriftConfirmation();

    // A split with contiguous source times needs neither a reload nor a seek.
    if (!force && playing && wasPlaying && !this.pending && previous &&
      this.source === segment.sourceVideoId && previous.id !== segment.id &&
      Math.abs(previous.sourceEnd - segment.sourceStart) < 1e-7 &&
      Math.abs(previous.timelineStart + previous.sourceEnd - previous.sourceStart - segment.timelineStart) < 1e-7) {
      this.segment = { ...segment };
      return;
    }

    const generation = ++this.generation;
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.audio.pause();
    this.segment = { ...segment };
    this.pending = true;
    const valid = () => !this.disposed && generation === this.generation;
    const fail = (error: unknown) => {
      if (!valid()) return;
      this.pending = false;
      this.blocked = true;
      this.playing = false;
      this.audio.pause();
      this.options.error(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Audiostart vom Browser blockiert. Bitte die Wiedergabe erneut starten."
        : "Audiovorschau konnte nicht gestartet werden.");
    };
    const ready = () => {
      if (!valid()) return;
      const now = this.options.time();
      if (now < segment.timelineStart || now >= segment.timelineStart + segment.sourceEnd - segment.sourceStart) {
        this.sync(this.playing, true);
        return;
      }
      try {
        this.audio.currentTime = segment.sourceStart + now - segment.timelineStart;
        this.pending = false;
        if (this.playing) {
          this.alignOnPlaying = true;
          // Called synchronously for a ready, cached source (important for user activation).
          void this.audio.play().then(() => {
            if (this.disposed || !this.playing) this.audio.pause();
            else if (valid()) this.options.error(null);
          }).catch(fail);
        }
      } catch (error) { fail(error); }
    };
    const load = (url: string) => {
      if (!valid()) return;
      const sameSource = this.source === segment.sourceVideoId && this.audio.src === url;
      this.source = segment.sourceVideoId;
      this.sourceUrl = url;
      if (sameSource && this.audio.readyState >= 1) {
        ready();
        return;
      }
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", loaded);
        if (this.cancelLoad === cleanup) this.cancelLoad = null;
      };
      const loaded = () => { cleanup(); ready(); };
      this.cancelLoad = cleanup;
      this.audio.addEventListener("loadedmetadata", loaded);
      if (!sameSource) {
        this.audio.src = url;
        this.audio.load();
      }
    };
    try {
      const url = this.options.url(segment.sourceVideoId);
      if (typeof url === "string") load(url);
      else void url.then(load).catch(fail);
    } catch (error) { fail(error); }
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.visibilityResyncPending = false;
    this.lastDriftCheck = -Infinity;
    this.correctionUntil = -Infinity;
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.audio.removeEventListener("waiting", this.audioWaiting);
    for (const event of ["seeking", "pause", "ended"]) this.audio.removeEventListener(event, this.resetDriftConfirmation);
    this.audio.removeEventListener("playing", this.guardPlayback);
    this.audio.removeEventListener("error", this.mediaError);
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
