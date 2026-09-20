import { EditorAudioPreview, validAudioVolume } from "./editorAudioPreview";
import { audioSource, effectiveAudioSpeed, groupAudioSegments, validateAudioSegments, type EditorAudioSegment, type EditorAudioSource, type EditorAudioTrackId } from "./editorAudioGeometry";
import { audioSourceKey, createAudioSourceResolver } from "./editorAudioSources";
import { readClipSpeed, type EditorClip } from "./editorClipTime";
import { originalAudioDuckingGain } from "./editorAudioDucking";

interface Options {
  segments: () => EditorAudioSegment[];
  clips?: () => EditorClip[];
  time: () => number;
  resolver: ReturnType<typeof createAudioSourceResolver>;
  createAudio: (track: EditorAudioTrackId) => HTMLAudioElement;
  pause: () => void;
  error: (message: string | null) => void;
  canCheckDrift?: () => boolean;
  duckOriginalAudio?: () => boolean;
}

type PreparedSegment = EditorAudioSegment & { sourceVideoId: string; previewSpeed: number };
type Track = { segments: PreparedSegment[]; preview: EditorAudioPreview };

// Used for multitrack/assets; legacy original audio retains its single-player path.
// The caller owns the master clock and calls sync/checkDrift from its existing timer.
export class EditorMultitrackAudioPreview {
  private tracks = new Map<EditorAudioTrackId, Track>();
  private sources = new Map<string, EditorAudioSource>();
  private playing = false;
  private blocked = false;
  private disposed = false;
  private generation = 0;

  constructor(private options: Options) {}

  private release() {
    for (const track of this.tracks.values()) track.preview.dispose();
    this.tracks.clear();
    this.sources.clear();
  }

  private fail = (message: string | null) => {
    // A successful sibling must not clear a failure or restart the master.
    if (!message || this.disposed || this.blocked) return;
    this.blocked = true;
    this.playing = false;
    this.generation++;
    this.release();
    this.options.pause();
    this.options.error(message);
  };

  sync(playing: boolean, force = false) {
    if (this.disposed || (this.blocked && !force)) return;
    if (force) this.blocked = false;
    this.playing = playing;
    try {
      const segments = this.options.segments();
      const clips = this.options.clips?.() ?? [];
      validateAudioSegments(segments, clips);
      const sources = new Map<string, EditorAudioSource>();
      const groups = groupAudioSegments(segments).map(group => ({
        ...group,
        segments: group.segments.map(segment => {
          const source = audioSource(segment);
          if (source.kind === "audioAsset" && readClipSpeed(segment.speed) !== 1) throw new Error("Audio-Assets unterstützen nur Geschwindigkeit 1.");
          if (!validAudioVolume(segment.volume)) throw new Error("Ungültige Audio-Lautstärke.");
          const key = audioSourceKey(source);
          sources.set(key, source);
          return { ...segment, sourceVideoId: key, previewSpeed: effectiveAudioSpeed(segment, clips) };
        }),
      }));
      this.sources = sources;
      for (const [id, track] of this.tracks) {
        if (!groups.some(group => group.trackId === id)) {
          track.preview.dispose();
          this.tracks.delete(id);
        }
      }
      for (const group of groups) {
        if (this.blocked) break;
        let track = this.tracks.get(group.trackId);
        if (!track) {
          const entry = { segments: group.segments } as Track;
          entry.preview = new EditorAudioPreview(this.options.createAudio(group.trackId), {
            segments: () => entry.segments,
            time: this.options.time,
            url: key => {
              const source = this.sources.get(key);
              if (!source) throw new Error("Audioquelle fehlt.");
              return this.options.resolver.resolve(source);
            },
            speed: segment => entry.segments.find(item => item.id === segment.id)?.previewSpeed,
            volumeGain: group.trackId === "original" ? time => this.options.duckOriginalAudio?.() === true
              ? originalAudioDuckingGain(this.options.segments(), this.options.clips?.() ?? [], time)
              : 1 : undefined,
            error: this.fail,
            canCheckDrift: this.options.canCheckDrift,
          });
          track = entry;
          this.tracks.set(group.trackId, entry);
        }
        track.segments = group.segments;
        track.preview.sync(playing, force);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Audiovorschau konnte nicht gestartet werden.");
    }
  }

  play() { this.sync(true, true); }
  stop() { this.pause(); }
  updateVolume() { this.sync(this.playing); }
  setVolumeDraft(draft: { id: string; value: number } | null, apply = true) {
    for (const track of this.tracks.values()) track.preview.setVolumeDraft(draft, apply);
  }
  async refreshUrls() {
    const sources = new Map(this.options.segments().map(segment => {
      const source = audioSource(segment);
      return [audioSourceKey(source), source] as const;
    }));
    await Promise.all([...sources.values()].filter(source => source.kind === "audioAsset")
      .map(source => this.options.resolver.resolve(source, { refresh: true })));
  }
  pause() {
    this.playing = false;
    this.generation++;
    for (const track of this.tracks.values()) track.preview.stop();
  }
  // Master time must already have been updated by the caller.
  seek() { this.sync(this.playing, true); }
  checkDrift(now = performance.now()) {
    for (const track of this.tracks.values()) track.preview.checkDrift(now);
  }
  async refreshSource(source: EditorAudioSource) {
    if (this.disposed) return;
    const generation = this.generation;
    try {
      await this.options.resolver.resolve(source, { refresh: true });
      if (!this.disposed && generation === this.generation) this.sync(this.playing, true);
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.fail(error instanceof Error ? error.message : "Audioquelle konnte nicht geladen werden.");
    }
  }
  dispose() {
    this.disposed = true;
    this.playing = false;
    this.generation++;
    this.release();
  }
}
