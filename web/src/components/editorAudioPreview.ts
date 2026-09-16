import { readClipSpeed, timelineDuration, timelineOffsetToSourceTime } from "./editorClipTime";
import { applyMediaPlaybackSpeed, mediaDriftInTimelineSeconds, seekMediaTimelineOffset } from "./editorMediaPlayback";

// Playback-only view of the existing persisted segments. No separate timeline state.
interface AudioSegment {
  volume?: number;
  muted?: boolean;
  id: string;
  sourceVideoId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
}

export function validAudioVolume(volume: number | undefined): boolean {
  return volume === undefined || (Number.isFinite(volume) && volume >= 0 && volume <= 1);
}

// Gain is not transport state: changing it must never reload or seek media.
export function audioTransportKey(segments: readonly AudioSegment[]): string {
  return JSON.stringify(segments.map(({ volume: _volume, ...segment }) => segment));
}

interface PreviewOptions {
  segments: () => readonly AudioSegment[];
  time: () => number;
  url: (sourceId: string) => string | Promise<string>;
  error: (message: string | null) => void;
  canCheckDrift?: () => boolean;
  // Effective segment rate supplied by the editor; never multiply by video playbackRate.
  speed?: (segment: AudioSegment) => number | undefined;
}

type PlaybackSegment = AudioSegment & { speed: number };
const segmentEnd = (segment: PlaybackSegment) => segment.timelineStart +
  timelineDuration(segment.sourceStart, segment.sourceEnd, segment.speed);
const sourceAt = (segment: PlaybackSegment, time: number) =>
  timelineOffsetToSourceTime(time - segment.timelineStart, segment.sourceStart, segment.speed);

export class EditorAudioPreview {
  private generation = 0;
  private playing = false;
  private disposed = false;
  private segment: PlaybackSegment | null = null;
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
  private volumeDraft: { id: string; value: number } | null = null;

  private playbackSegments(): PlaybackSegment[] | null {
    try {
      return this.options.segments().map(segment => ({ ...segment, speed: readClipSpeed(this.options.speed?.(segment)) }));
    } catch { return null; }
  }

  setVolumeDraft(draft: { id: string; value: number } | null, apply = true) {
    this.volumeDraft = draft;
    if (apply) this.updateVolume();
  }

  updateVolume() {
    if (this.disposed) return;
    const time = this.options.time();
    const active = this.playbackSegments()?.find(item => time >= item.timelineStart && time < segmentEnd(item));
    if (!active || active.muted === true) return;
    const value = this.volumeDraft?.id === active.id ? this.volumeDraft.value : active.volume;
    if (!validAudioVolume(value)) return;
    if (this.audio.volume !== (value ?? 1)) this.audio.volume = value ?? 1;
  }

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
    const active = (this.playbackSegments() ?? []).filter((item) =>
      item.sourceEnd > item.sourceStart && time >= item.timelineStart &&
      time < segmentEnd(item),
    );
    if (active.length !== 1 || active[0].muted === true || active[0].sourceVideoId !== this.source ||
      audioTransportKey([active[0]]) !== audioTransportKey([this.segment])) return null;
    const target = sourceAt(active[0], time);
    return Number.isFinite(target) && Number.isFinite(this.audio.currentTime)
      ? { sourceTime: target, speed: active[0].speed } : null;
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
    const drift = mediaDriftInTimelineSeconds(this.audio.currentTime, target.sourceTime, target.speed);
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
    const freshDrift = mediaDriftInTimelineSeconds(this.audio.currentTime, freshTarget.sourceTime, freshTarget.speed);
    if (!this.visibilityResyncPending &&
      (Math.abs(freshDrift) <= 0.1 + 1e-9 || Math.sign(freshDrift) !== direction)) return;
    this.visibilityResyncPending = false;
    this.correctionUntil = now + 1000;
    try {
      this.audio.currentTime = freshTarget.sourceTime;
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
      if (time < segment.timelineStart || time >= segmentEnd(segment)) {
        this.sync(true, true);
      } else {
        seekMediaTimelineOffset(this.audio, segment.sourceStart, time - segment.timelineStart, segment.speed);
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
    const segments = this.playbackSegments();
    if (!segments) {
      this.stop();
      this.options.error("Ungültige Audio-Geschwindigkeit.");
      return;
    }
    const segment = segments.find((item) =>
      item.sourceEnd > item.sourceStart && time >= item.timelineStart &&
      time < segmentEnd(item),
    ) ?? null;
    const previous = this.segment;
    const wasPlaying = this.playing;
    this.playing = playing;
    if (!segment || segment.muted === true) {
      this.stop();
      return;
    }
    if (!validAudioVolume(segment.volume)) {
      this.stop();
      this.options.error("Ungültige Audio-Lautstärke.");
      return;
    }
    this.updateVolume();
    if (!force && wasPlaying === playing && previous &&
      audioTransportKey([previous]) === audioTransportKey([segment])) return;

    this.resetDriftConfirmation();

    // A split with contiguous source times needs neither a reload nor a seek.
    if (!force && playing && wasPlaying && !this.pending && previous &&
      this.source === segment.sourceVideoId && previous.id !== segment.id &&
      Math.abs(previous.sourceEnd - segment.sourceStart) < 1e-7 &&
      Math.abs(segmentEnd(previous) - segment.timelineStart) < 1e-7) {
      applyMediaPlaybackSpeed(this.audio, segment.speed);
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
      if (now < segment.timelineStart || now >= segmentEnd(segment)) {
        this.sync(this.playing, true);
        return;
      }
      try {
        seekMediaTimelineOffset(this.audio, segment.sourceStart, now - segment.timelineStart, segment.speed);
        this.pending = false;
        if (this.playing) {
          this.updateVolume();
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
