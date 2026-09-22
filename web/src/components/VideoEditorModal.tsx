import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { useI18n } from "../i18n/I18nContext";
import { PromptDialog } from "./PromptDialog";
import { formatDuration } from "../utils/format";
import type { Video } from "../types/video";
import { EditorAudioPreview, audioTransportKey, validAudioVolume } from "./editorAudioPreview";
import { EditorMultitrackAudioPreview } from "./editorMultitrackAudioPreview";
import { EditorVoiceoverSession } from "./editorVoiceoverSession";
import { finishVoiceoverToTimeline } from "./editorVoiceoverTimeline";
import { audioSourceKey, createAudioSourceResolver } from "./editorAudioSources";
import { audioSource, groupAudioSegments, validateAudioSegments } from "./editorAudioGeometry";
import { AudioSegmentWaveform, type AudioWaveformCache } from "./AudioSegmentWaveform";
import { clipFromStored, clipToStored, requireSupportedClipSpeed, layoutEditorClips, timelineClipPosition, clipSourceToTimelineTime, splitEditorClip, timelineDuration as clipTimelineDuration, type EditorClip, type StoredEditorClip } from "./editorClipTime";
import { applyMediaPlaybackSpeed } from "./editorMediaPlayback";
import { canContinueClipSource, EDITOR_CLIP_SPEEDS, readClipSpeed } from "./editorClipTime";
import { changeClipSpeed, audioTrackId, audioTrackNeighbours, videoAudioSource, previewAudioSegments, cloneAudioSegment, splitLinkedAudioSegments } from "./editorAudioGeometry";
import { requirePreviewAnnotations, validateTextAnnotation, type EditorAnnotation, type EditorAnnotation as StoredAnnotation } from "./editorAnnotations";
import { TEXT_FONTS, textTypography, type TextTypography } from "./editorTextTypography";
import { ARROW_SHAFT_WIDTHS, arrowShaftWidth, arrowPolygonPoints, LINE_STROKE_WIDTHS, lineStrokeWidth, linePreviewStrokeWidth, CIRCLE_STROKE_WIDTHS, circleStrokeWidth, circlePreviewStrokeWidth } from "./editorAnnotations";
import { TEXT_LAYOUT, textPreviewGeometry, textBoxToPixels, scaledTextFontSize } from "./editorTextGeometry";
import { effectiveAudioSpeed, audioSegmentTimelineDuration, audioGeometryDraft, commitAudioGeometry, requireSupportedAudioSpeed, type EditorAudioSegment } from "./editorAudioGeometry";

export function coupledAudio(clips: EditorClip[], previous: EditorAudioSegment[] = []): EditorAudioSegment[] {
  const used = new Set(previous.map((segment) => segment.id));
  return layoutEditorClips(clips).map(({ clip, timelineStart }) => {
    const existing = previous.find((segment) => videoAudioSource(segment)?.clipId === clip.id);
    let id = existing?.id ?? `audio:${clip.id}`;
    if (!existing) {
      while (used.has(id)) id = `audio:${id}`;
    }
    used.add(id);
    const segment = { ...(existing ? { geometryLinked: existing.geometryLinked, speed: existing.speed, ...(existing.trackId !== undefined ? { trackId: existing.trackId } : {}) } : { geometryLinked: true }),
      id, sourceClipId: clip.id, sourceVideoId: clip.sourceVideoId,
      sourceStart: clip.start, sourceEnd: clip.end, timelineStart };
    if (existing?.source) return { ...segment, sourceClipId: undefined, sourceVideoId: undefined, source: { ...existing.source } };
    return segment;
  });
}

export function isAudioStillCoupled(clips: EditorClip[], audioSegments: EditorAudioSegment[]): boolean {
  const expected = coupledAudio(clips);
  if (expected.length !== audioSegments.length) return false;
  if (audioSegments.some(segment => audioTrackId(segment) !== "original" || !videoAudioSource(segment))) return false;
  const byClip = new Map(audioSegments.map((segment) => [videoAudioSource(segment)?.clipId, segment]));
  if (byClip.size !== audioSegments.length) return false;
  // One microsecond tolerates arithmetic noise, not meaningful audio edits.
  const sameTime = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.000001;
  return expected.every((segment) => {
    const actual = byClip.get(segment.sourceClipId);
    return actual !== undefined && actual.muted !== true && validAudioVolume(actual.volume) &&
      Math.abs((actual.volume ?? 1) - 1) <= 1e-6 && videoAudioSource(actual)?.videoId === segment.sourceVideoId &&
      sameTime(actual.sourceStart, segment.sourceStart) &&
      sameTime(actual.sourceEnd, segment.sourceEnd) &&
      sameTime(actual.timelineStart, segment.timelineStart);
  });
}

interface EditorCoverOverlay {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  mode?: "cover" | "blur";
  color?: string;
  opacity?: number;
  text?: string;
}

const annotationSymbols = ["check", "cross", "warning", "info", "star", "pointer", "plus", "question"] as const;
type AnnotationSymbol = typeof annotationSymbols[number];
const symbolLabelKeys: Record<AnnotationSymbol, string> = {
  check: "editor.symbolCheck", cross: "editor.symbolCross", warning: "editor.symbolWarning", info: "editor.symbolInfo",
  star: "editor.symbolStar", pointer: "editor.symbolPointer", plus: "editor.symbolPlus", question: "editor.symbolQuestion",
};

function SymbolShape({ symbol }: { symbol: AnnotationSymbol }) {
  const paths = {
    check: <path d="m3 8 3 3 7-7" />,
    cross: <path d="m3 3 10 10M13 3 3 13" />,
    warning: <><path d="M8 2 14 13H2ZM8 6v3" /><circle cx="8" cy="11" r=".4" fill="currentColor" /></>,
    info: <><circle cx="8" cy="8" r="6" /><path d="M8 7v4" /><circle cx="8" cy="5" r=".4" fill="currentColor" /></>,
    star: <path d="m8 2 1.8 3.8L14 6.4l-3 3 .7 4.2L8 11.6l-3.7 2 .7-4.2-3-3 4.2-.6Z" />,
    pointer: <path d="M6 8V3a1 1 0 0 1 2 0v4-1a1 1 0 0 1 2 0v1a1 1 0 0 1 2 0v1a1 1 0 0 1 2 0v2c0 2-2 4-4 4H8c-2 0-3-2-4-3L2 9a1 1 0 0 1 1.5-1.3L6 10" />,
    plus: <path d="M8 3v10M3 8h10" />,
    question: <><circle cx="8" cy="8" r="6" /><path d="M6 6a2 2 0 1 1 3 1.7C8 8.2 8 8.5 8 9" /><circle cx="8" cy="11" r=".4" fill="currentColor" /></>,
  };
  return <g data-symbol={symbol} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{paths[symbol]}</g>;
}

interface EditorHistoryEntry {
  duckOriginalAudio: boolean;
  clips: EditorClip[];
  audioSegments: EditorAudioSegment[];
  coverOverlays: EditorCoverOverlay[];
  annotations: EditorAnnotation[];
}

interface StoredEditorState {
  timeline: {
    duckOriginalAudio?: boolean;
    version: number;
    clips: StoredEditorClip[];
    overlays?: EditorCoverOverlay[];
    audioSegments?: EditorAudioSegment[];
    annotations?: StoredAnnotation[];
  };
  renderStatus: "none" | "processing" | "ready" | "failed";
  renderError: string | null;
  renderedVideoId: string | null;
}

interface VideoEditorModalProps {
  videoId: string;
  videoTitle?: string;
  duration: number;
  onClose: () => void;
  onTrimStarted?: () => void;
}

const TIMELINE_ZOOM_LEVELS = [1, 2, 5, 10] as const;
const TIMELINE_TICK_STEPS = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const OVERLAY_SAVE_DEBOUNCE_MS = 400;
const INDEPENDENT_AUDIO_WARNING = "Die Tonspur wurde unabhängig vom Video bearbeitet. Änderungen an der Videostruktur würden diese Audiobearbeitung überschreiben.";
// Preserve guard comparisons and persisted/backend messages; localize editor-owned
// errors only at display time so an open message responds to language changes.
const editorErrorKeys: Record<string, string> = {
  "Video konnte nicht geladen werden.": "editor.videoLoadError",
  "Quellenwechsel wurde ersetzt.": "editor.sourceSwitchReplaced",
  "Audio-Assets unterstützen nur Geschwindigkeit 1.": "editor.assetSpeedError",
  "Ungültige Audio-Lautstärke.": "editor.invalidAudioVolume",
  "Editorstand konnte nicht geladen werden.": "editor.stateLoadError",
  "Rendern fehlgeschlagen.": "editor.renderError",
  "Renderstatus konnte nicht geladen werden.": "editor.renderStatusError",
  "Voice-over-Aufnahme wurde abgebrochen.": "editor.recordingAborted",
  "Voice-over-Aufnahme konnte nicht gestartet werden.": "editor.recordingStartError",
  "Editor wurde geschlossen.": "editor.editorClosed",
  "Voice-over konnte nicht gespeichert werden.": "editor.voiceoverSaveError",
  "Editorstand konnte nicht gespeichert werden.": "editor.stateSaveError",
  "Videobibliothek konnte nicht geladen werden.": "editor.libraryLoadError",
  "Bitte zuerst ein Video auswählen.": "editor.selectVideo",
  "Die Geschwindigkeit würde bestehende Overlays oder Annotationen über das Videoende hinausschieben.": "editor.speedOverlayError",
  "Geschwindigkeit konnte nicht geändert werden.": "editor.speedChangeError",
  "Zum Teilen muss der Abspielkopf innerhalb eines Clips stehen.": "editor.splitPositionError",
  "Clip konnte nicht geteilt werden.": "editor.splitError",
  "Bitte zuerst eine Abdeckung auswählen.": "editor.selectCover",
  "Es ist keine Abdeckung zum Einfügen kopiert.": "editor.noCopiedCover",
  "Bitte zuerst einen Clip auswählen.": "editor.selectClip",
  "Der letzte verbleibende Clip kann nicht gelöscht werden.": "editor.lastClipError",
  "Der verbleibende Bereich muss mindestens 1 Sekunde lang sein.": "editor.minTrimError",
  "Trimmen fehlgeschlagen.": "editor.trimError",
  "Die Timeline muss mindestens eine Sekunde lang sein.": "editor.minTimelineError",
  "Rendern konnte nicht gestartet werden.": "editor.renderStartError",
  "Audioquelle konnte nicht geladen werden.": "editor.audioLoadError",
  "Wiedergabe konnte nicht gestartet werden.": "editor.playbackError",
  "Video-Vorschau fehlgeschlagen.": "editor.videoPreviewError",
  "Video-Vorschau ist nicht verfügbar.": "editor.videoUnavailable",
  "Video-Wiedergabe wurde während der Aufnahme unterbrochen.": "editor.playbackInterrupted",
  "Seek während der Voice-over-Aufnahme ist nicht erlaubt.": "editor.seekRecordingError",
  "Ungültige Audiospur: erlaubt sind original und voiceover-1.": "editor.invalidAudioTrack",
  "Mehrdeutige Audioquelle.": "editor.ambiguousAudioSource",
  "Ungültige Audioquelle.": "editor.invalidAudioSource",
  "Audioquelle fehlt.": "editor.missingAudioSource",
  "Ungültige Audiosegment-ID.": "editor.invalidAudioId",
  "Ungültige Audiozeiten.": "editor.invalidAudioTimes",
  "Audiosegmente derselben Spur dürfen sich nicht überlappen.": "editor.overlappingAudio",
  "Mehrspur-Audiovorschau wird noch nicht unterstützt.": "editor.multitrackUnavailable",
  "Audio-Asset-Vorschau wird noch nicht unterstützt.": "editor.assetPreviewUnavailable",
  "Die gekoppelte Audiogeometrie stimmt nicht mit dem Videoclip überein.": "editor.linkedAudioMismatch",
  "Die Timeline muss mindestens eine Sekunde lang bleiben.": "editor.minTimelineRemain",
  "Die Geschwindigkeit würde Audiosegmente überlappen lassen oder über das Videoende hinausschieben.": "editor.speedAudioError",
  "Voice-over-Aufnahme hat keine gültige Timeline-Startposition.": "editor.recordingStartTimeError",
  "Voice-over-Aufnahme ist leer oder unvollständig.": "editor.recordingEmpty",
  "Nicht unterstütztes Voice-over-Aufnahmeformat.": "editor.recordingFormatError",
  "Audio-Asset-Upload lieferte kein gültiges Ergebnis.": "editor.assetUploadError",
  "Ungültige Timelinezeit.": "editor.invalidTimelineTime",
  "Unvollständiges Aufnahmeergebnis.": "editor.incompleteRecording",
  "Mikrofonaufnahme fehlgeschlagen.": "editor.microphoneError",
  "Aufnahme kann nicht vorbereitet werden.": "editor.prepareError",
  "Kein unterstütztes Audio-Aufnahmeformat verfügbar.": "editor.noRecordingFormat",
  "Kein aktiver reiner Mikrofonstream verfügbar.": "editor.noMicrophoneStream",
  "Mikrofonaufnahme wurde unerwartet beendet.": "editor.recordingEnded",
  "Keine Audiodaten aufgenommen.": "editor.noAudioData",
  "Das Mikrofon ist nicht mehr verfügbar.": "editor.microphoneUnavailable",
  "Das Mikrofon wurde getrennt.": "editor.microphoneDisconnected",
  "Das Mikrofon liefert kein Audiosignal mehr.": "editor.microphoneMuted",
  "Aufnahme ist nicht startbereit.": "editor.recordingNotReady",
  "Ungültige Timeline-Startzeit.": "editor.invalidStartTime",
  "Aufnahme kann gerade nicht pausiert werden.": "editor.pauseRecordingError",
  "Aufnahme kann gerade nicht fortgesetzt werden.": "editor.resumeRecordingError",
  "Voice-over liegt außerhalb der Videotimeline.": "editor.voiceoverOutsideTimeline",
};
const VISIBLE_OVERLAY_TRACKS = 4;
const OVERLAY_TRACK_HEIGHT = 38;
const OVERLAY_TRACK_GAP = 4;

export function serializeTimeline(clips: EditorClip[], overlays: EditorCoverOverlay[], annotations: StoredAnnotation[] = [], audioSegments?: EditorAudioSegment[], duckOriginalAudio?: boolean) {
  return JSON.stringify({
    version: 1,
    clips: clips.map(clipToStored),
    overlays,
    annotations,
    audioSegments,
    duckOriginalAudio: duckOriginalAudio || undefined,
  });
}

function EditorToolIcon({ name }: { name: "trim" | "split" | "cover" | "insert" | "undo" | "fit" | "minus" | "plus" | "copy" | "paste" | "delete" | "arrow" | "circle" | "symbol" | "line" | "microphone" | "stop" }) {
  const paths = {
    arrow: <path d="M2 13 13 2M5 2h8v8" />,
    circle: <circle cx="8" cy="8" r="5.5" />,
    symbol: <SymbolShape symbol="star" />,
    line: <path d="M2 12 14 4" />,
    microphone: <><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M4 7a4 4 0 0 0 8 0M8 11v3M5.5 14h5" /></>,
    stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
    trim: <><circle cx="3.5" cy="4" r="1.5" /><circle cx="3.5" cy="12" r="1.5" /><path d="m4.8 5 7.7 6.5M4.8 11l7.7-6.5" /></>,
    split: <><rect x="1.5" y="3" width="5" height="10" rx="1" /><rect x="9.5" y="3" width="5" height="10" rx="1" /><path d="M8 2.5v11" /></>,
    cover: <rect x="2" y="3" width="12" height="10" rx="1.5" />,
    insert: <><rect x="1.5" y="3.5" width="9" height="9" rx="1.25" /><path d="m10.5 6.5 4-1.7v6.4l-4-1.7M4 8h4M6 6v4" /></>,
    undo: <><path d="M6 4 2.5 7.5 6 11" /><path d="M3 7.5h6a4 4 0 0 1 4 4" /></>,
    fit: <><path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></>,
    minus: <path d="M3 8h10" />,
    plus: <path d="M8 3v10M3 8h10" />,
    copy: <><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" /></>,
    paste: <><path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v8A1.5 1.5 0 0 1 11 14.5H5A1.5 1.5 0 0 1 3.5 13V5A1.5 1.5 0 0 1 5 3.5Z" /><path d="M6 3.5V2.25h4V3.5M6 7h4M6 10h4" /></>,
    delete: <><path d="M3 4.5h10M6 2h4l.5 2.5M4.5 4.5l.75 9h5.5l.75-9M6.5 7v4M9.5 7v4" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      data-testid={`video-editor-tool-icon-${name}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function VideoEditorModal({
  videoId,
  videoTitle = "Video",
  duration,
  onClose,
  onTrimStarted,
}: VideoEditorModalProps) {
  const { language, t } = useI18n();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [timelinePlayheadTime, setTimelinePlayheadTime] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [showInsertPicker, setShowInsertPicker] = useState(false);
  const [libraryVideos, setLibraryVideos] = useState<Video[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedInsertVideo, setSelectedInsertVideo] = useState<Video | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [clipSpeedBlocked, setClipSpeedBlocked] = useState(false);
  const [trimEnd, setTrimEnd] = useState(duration);
  const [trimming, setTrimming] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [showRenderName, setShowRenderName] = useState(false);
  const [renderStatus, setRenderStatus] = useState<StoredEditorState["renderStatus"]>("none");
  const [renderedVideoId, setRenderedVideoId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editorHistory, setEditorHistory] = useState<EditorHistoryEntry[]>([]);
  const [coverOverlays, setCoverOverlays] = useState<EditorCoverOverlay[]>([]);
  const [selectedCoverOverlayId, setCoverSelection] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<EditorAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [copiedAnnotation, setCopiedAnnotation] = useState<EditorAnnotation | null>(null);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const symbolPickerButtonRef = useRef<HTMLButtonElement>(null);
  const annotationFrameRef = useRef<HTMLDivElement>(null);
  const arrowFrameRef = useRef<HTMLDivElement>(null);
  const textFrameRef = useRef<HTMLDivElement>(null);
  const [textFrameRect, setTextFrameRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const hasTextAnnotations = annotations.some(item => item.type === "text");
  const hasCanonicalAnnotations = hasTextAnnotations || annotations.some(item => item.type === "arrow" || item.type === "line" || item.type === "circle" || item.type === "symbol");
  const textAnnotationEditRef = useRef<string | null>(null);
  const [textAnnotationDraft, setTextAnnotationDraft] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    textAnnotationEditRef.current = null;
    setTextAnnotationDraft(null);
  }, [selectedAnnotationId, videoId]);
  const cancelAnnotationDragRef = useRef<(() => void) | null>(null);
  function setSelectedCoverOverlayId(id: string | null) {
    setCoverSelection(id);
    setSelectedAnnotationId(null);
  }
  function selectAnnotation(id: string) {
    setCoverSelection(null);
    setSelectedAnnotationId(id);
  }
  const [copiedCoverOverlay, setCopiedCoverOverlay] = useState<EditorCoverOverlay | null>(null);
  const [videoFrameRect, setVideoFrameRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [clips, setClips] = useState<EditorClip[]>([
    {
      id: "clip-1",
      sourceVideoId: videoId,
      start: 0,
      end: duration,
    },
  ]);
  const [audioSegments, setAudioSegments] = useState<EditorAudioSegment[]>([]);
  const [duckOriginalAudio, setDuckOriginalAudio] = useState(false);
  const voiceoverSessionRef = useRef<EditorVoiceoverSession | null>(null);
  const voiceoverGenerationRef = useRef(0);
  const voiceoverFinishingRef = useRef(false);
  const [voiceoverState, setVoiceoverState] = useState<"idle" | "preparing" | "recording" | "stopping">("idle");
  const voiceoverTimeRef = useRef(timelinePlayheadTime);
  voiceoverTimeRef.current = timelinePlayheadTime;
  const waveformCacheRef = useRef<AudioWaveformCache>(new Map());
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [audioResizeDraft, setAudioResizeDraft] = useState<EditorAudioSegment | null>(null);
  const [movingAudioId, setMovingAudioId] = useState<string | null>(null);
  const [audioGestureActive, setAudioGestureActive] = useState(false);
  const cancelAudioResizeRef = useRef<(() => void) | null>(null);
  const [audioVolumeDraft, setAudioVolumeDraft] = useState<{ id: string; value: number } | null>(null);
  const volumeGestureRef = useRef<{ change: (value: number) => void; finish: () => void; cancel: () => void } | null>(null);

  function updateCoupledClips(update: (previous: EditorClip[]) => EditorClip[]) {
    const next = update(clips);
    setClips(next);
    setAudioSegments(audioSegments.length === 0 ? [] : coupledAudio(next, audioSegments));
  }
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioPreviewRef = useRef<EditorAudioPreview | EditorMultitrackAudioPreview | null>(null);
  const previewPlayingRef = useRef(false);
  const videoSwitchPendingRef = useRef(false);
  const videoBufferingRef = useRef(false);
  const internalPauseRef = useRef(false);
  const [audioPreviewError, setAudioPreviewError] = useState<string | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const nextClipIdRef = useRef(2);
  const timelineRef = useRef<HTMLDivElement>(null);
  const draggingTrimRef = useRef<"start" | "end" | null>(null);
  const videoUrlsRef = useRef<Record<string, string>>({});
  const videoUrlRequestsRef = useRef<Record<string, Promise<string>>>({});
  const activeSourceVideoIdRef = useRef(videoId);
  const activeClipIdRef = useRef("clip-1");
  const sourceSwitchGenerationRef = useRef(0);
  const sourceTransitionPendingRef = useRef(false);
  const cancelPendingSourceLoadRef = useRef<(() => void) | null>(null);
  const pendingRestoredPreviewRef = useRef<EditorClip | null>(null);
  const editorStateLoadedRef = useRef(false);
  const overlaySaveTimerRef = useRef<number | null>(null);
  const latestTimelinePayloadRef = useRef<string | null>(null);
  const lastSavedTimelinePayloadRef = useRef<string | null>(null);
  const timelineSavePendingRef = useRef(false);
  const textEditOverlayRef = useRef<string | null>(null);

  function updateVisibleVideoFrame() {
    const video = videoRef.current;
    const container = previewContainerRef.current;
    if (!video || !container) return;

    const videoRect = video.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (videoRect.width <= 0 || videoRect.height <= 0) return;

    const intrinsicWidth = video.videoWidth;
    const intrinsicHeight = video.videoHeight;
    const canonical = textPreviewGeometry(videoRect.width, videoRect.height, intrinsicWidth || 1920, intrinsicHeight || 1080).frame;
    const textRect = { ...canonical, left: canonical.left + videoRect.left - containerRect.left,
      top: canonical.top + videoRect.top - containerRect.top };
    setTextFrameRect(current => Object.keys(textRect).every(key => current[key as keyof typeof current] === textRect[key as keyof typeof textRect]) ? current : textRect);
    const scale =
      intrinsicWidth > 0 && intrinsicHeight > 0
        ? Math.min(videoRect.width / intrinsicWidth, videoRect.height / intrinsicHeight)
        : 1;
    const width = intrinsicWidth > 0 ? intrinsicWidth * scale : videoRect.width;
    const height = intrinsicHeight > 0 ? intrinsicHeight * scale : videoRect.height;
    const normalizeZero = (value: number) => Math.abs(value) < 1e-9 ? 0 : value;
    const nextRect = {
      left: normalizeZero(videoRect.left - containerRect.left + (videoRect.width - width) / 2),
      top: normalizeZero(videoRect.top - containerRect.top + (videoRect.height - height) / 2),
      width,
      height,
    };

    setVideoFrameRect((current) =>
      current.left === nextRect.left &&
      current.top === nextRect.top &&
      current.width === nextRect.width &&
      current.height === nextRect.height
        ? current
        : nextRect,
    );
  }

  function loadVideoUrl(sourceVideoId: string): string | Promise<string> {
    if (videoUrlsRef.current[sourceVideoId]) {
      return videoUrlsRef.current[sourceVideoId];
    }

    if (!videoUrlRequestsRef.current[sourceVideoId]) {
      videoUrlRequestsRef.current[sourceVideoId] = apiFetch<{ downloadUrl: string }>(`/api/videos/${sourceVideoId}/download`)
        .then((res) => {
          if (!res?.downloadUrl) throw new Error("Video konnte nicht geladen werden.");
          videoUrlsRef.current[sourceVideoId] = res.downloadUrl;
          return res.downloadUrl;
        }).finally(() => { delete videoUrlRequestsRef.current[sourceVideoId]; });
    }
    return videoUrlRequestsRef.current[sourceVideoId];
  }

  function previewTimelineTime() {
    const clip = clips.find((item) => item.id === activeClipIdRef.current);
    const offset = clip ? timelineStartForClip(clip.id) : null;
    if (!clip || offset === null || !videoRef.current) return timelinePlayheadTime;
    return clipSourceToTimelineTime(clip, offset, videoRef.current.currentTime);
  }

  function applyActiveVideoSpeed() {
    const video = videoRef.current;
    if (video && !clipSpeedBlocked) {
      applyMediaPlaybackSpeed(video, clips.find(clip => clip.id === activeClipIdRef.current)?.speed);
    }
  }

  useEffect(() => { applyActiveVideoSpeed(); }, [clips, videoUrl, clipSpeedBlocked]);

  function tickAudioPreview() {
    const video = videoRef.current;
    const clip = clips.find((item) => item.id === activeClipIdRef.current);
    if (video && !video.paused && clip && video.currentTime >= clip.end) {
      advancePreviewToNextClip();
      return;
    }
    audioPreviewRef.current?.sync(true);
  }

  const audioInputsRef = useRef({ clips, audioSegments, duckOriginalAudio, previewTimelineTime, loadVideoUrl, tickAudioPreview });
  audioInputsRef.current = { clips, audioSegments, duckOriginalAudio, previewTimelineTime, loadVideoUrl, tickAudioPreview };
  const audioSourceResolver = useMemo(() => createAudioSourceResolver({
    loadVideoUrl: id => audioInputsRef.current.loadVideoUrl(id),
  }), [videoId]);
  const multitrackPreview = audioSegments.some(segment => audioTrackId(segment) !== "original" || audioSource(segment).kind === "audioAsset");
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const canCheckDrift = () => {
      const video = videoRef.current;
      return !!video && previewPlayingRef.current && !videoSwitchPendingRef.current &&
        !sourceTransitionPendingRef.current && !videoBufferingRef.current &&
        !video.paused && !video.seeking && !video.ended && !video.error && video.readyState >= 3;
    };
    const preview = multitrackPreview ? new EditorMultitrackAudioPreview({
      duckOriginalAudio: () => audioInputsRef.current.duckOriginalAudio,
      segments: () => audioInputsRef.current.audioSegments,
      clips: () => audioInputsRef.current.clips,
      time: () => audioInputsRef.current.previewTimelineTime(),
      resolver: audioSourceResolver,
      createAudio: () => {
        const element = document.createElement("audio");
        element.preload = "auto";
        return element;
      },
      pause: () => { pausePreview(); videoRef.current?.pause(); },
      error: setAudioPreviewError,
      canCheckDrift,
    }) : new EditorAudioPreview(audio, {
      segments: () => previewAudioSegments(audioInputsRef.current.audioSegments),
      speed: segment => {
        const inputs = audioInputsRef.current;
        const original = inputs.audioSegments.find(item => item.id === segment.id);
        return original ? effectiveAudioSpeed(original, inputs.clips) : 1;
      },
      time: () => audioInputsRef.current.previewTimelineTime(),
      url: (id) => audioInputsRef.current.loadVideoUrl(id),
      error: setAudioPreviewError,
      canCheckDrift: () => {
        const video = videoRef.current;
        return !!video && previewPlayingRef.current && !videoSwitchPendingRef.current &&
          !sourceTransitionPendingRef.current && !videoBufferingRef.current &&
          !video.paused && !video.seeking && !video.ended && !video.error && video.readyState >= 3;
      },
    });
    audioPreviewRef.current = preview;
    // Keep the existing boundary timer; the controller throttles drift checks to 250 ms.
    const timer = window.setInterval(() => {
      if (previewPlayingRef.current && !videoSwitchPendingRef.current && !videoBufferingRef.current && !videoRef.current?.seeking) {
        audioInputsRef.current.tickAudioPreview();
      }
      preview.checkDrift();
    }, 25);
    return () => {
      window.clearInterval(timer);
      preview.dispose();
      audioPreviewRef.current = null;
    };
  }, [multitrackPreview, videoId, audioSourceResolver]);

  const audioTransport = JSON.stringify([audioTransportKey(audioSegments), audioSegments.map(segment => effectiveAudioSpeed(segment, clips))]);
  useEffect(() => {
    if (!videoSwitchPendingRef.current) audioPreviewRef.current?.sync(previewPlayingRef.current, true);
  }, [audioTransport, videoUrl, multitrackPreview, videoId]);
  useEffect(() => { audioPreviewRef.current?.updateVolume(); }, [audioSegments, duckOriginalAudio]);

  function pausePreview() {
    previewPlayingRef.current = false;
    videoBufferingRef.current = false;
    audioPreviewRef.current?.stop();
    ++sourceSwitchGenerationRef.current;
    cancelPendingSourceLoadRef.current?.();
    videoSwitchPendingRef.current = false;
    sourceTransitionPendingRef.current = false;
  }

  function closeEditor() {
    voiceoverGenerationRef.current++;
    voiceoverSessionRef.current?.dispose();
    voiceoverSessionRef.current = null;
    volumeGestureRef.current?.cancel();
    cancelAudioResizeRef.current?.();
    pausePreview();
    videoRef.current?.pause();
    onClose();
  }

  async function switchPreviewSource(
    sourceVideoId: string,
    sourceTime: number,
    clipId?: string,
    resumePlayback?: boolean,
    continuousTransition = false,
  ) {
    const video = videoRef.current;
    if (!video) return;

    const generation = ++sourceSwitchGenerationRef.current;
    cancelPendingSourceLoadRef.current?.();
    cancelPendingSourceLoadRef.current = null;
    const shouldResume = resumePlayback ?? !video.paused;
    const preservePlayback = continuousTransition && !video.paused && activeSourceVideoIdRef.current === sourceVideoId;
    previewPlayingRef.current = shouldResume;
    videoSwitchPendingRef.current = true;
    if (!preservePlayback) audioPreviewRef.current?.stop();

    try {
      const url = await loadVideoUrl(sourceVideoId);
      if (generation !== sourceSwitchGenerationRef.current) return;

      if (clipId) activeClipIdRef.current = clipId;
      applyActiveVideoSpeed();

      if (activeSourceVideoIdRef.current === sourceVideoId && video.src === url) {
        if (!preservePlayback) video.currentTime = sourceTime;
        if (!preservePlayback && shouldResume && previewPlayingRef.current) await video.play();
        if (generation !== sourceSwitchGenerationRef.current) return;
        videoSwitchPendingRef.current = false;
        audioPreviewRef.current?.sync(previewPlayingRef.current, !preservePlayback);
        sourceTransitionPendingRef.current = false;
        return;
      }

      if (!video.paused) internalPauseRef.current = true;
      video.pause();
      activeSourceVideoIdRef.current = sourceVideoId;
      setVideoUrl(url);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const handleLoadedMetadata = () => {
          settled = true;
          cleanup();
          if (generation !== sourceSwitchGenerationRef.current) {
            resolve();
            return;
          }
          video.currentTime = Math.max(0, Math.min(sourceTime, video.duration || sourceTime));
          applyActiveVideoSpeed();
          resolve();
        };
        const handleError = () => {
          settled = true;
          cleanup();
          reject(new Error("Video konnte nicht geladen werden."));
        };
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", handleLoadedMetadata);
          video.removeEventListener("error", handleError);
          if (cancelPendingSourceLoadRef.current === cancel) {
            cancelPendingSourceLoadRef.current = null;
          }
        };
        const cancel = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Quellenwechsel wurde ersetzt."));
        };

        cancelPendingSourceLoadRef.current = cancel;

        video.addEventListener("loadedmetadata", handleLoadedMetadata);
        video.addEventListener("error", handleError);
        video.src = url;
        video.load();
      });

      if (generation !== sourceSwitchGenerationRef.current) return;
      if (shouldResume && previewPlayingRef.current) await video.play();
      if (generation !== sourceSwitchGenerationRef.current) return;
      videoSwitchPendingRef.current = false;
      audioPreviewRef.current?.sync(previewPlayingRef.current, true);
      sourceTransitionPendingRef.current = false;
      setError(null);
    } catch (err) {
      if (generation !== sourceSwitchGenerationRef.current) return;
      videoSwitchPendingRef.current = false;
      previewPlayingRef.current = false;
      audioPreviewRef.current?.stop();
      sourceTransitionPendingRef.current = false;
      setError(
        err instanceof Error ? err.message : "Video konnte nicht geladen werden.",
      );
    }
  }



  useEffect(() => {
    let cancelled = false;
    Promise.resolve(loadVideoUrl(videoId))
      .then((url) => {
        if (cancelled) return;
        setVideoUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError("Video konnte nicht geladen werden.");
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl || video.src === videoUrl) return;
    video.src = videoUrl;
    video.load();
    const restoredClip = pendingRestoredPreviewRef.current;
    if (restoredClip) {
      pendingRestoredPreviewRef.current = null;
      void switchPreviewSource(
        restoredClip.sourceVideoId,
        restoredClip.start,
        restoredClip.id,
        false,
      );
    }
  }, [videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    updateVisibleVideoFrame();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateVisibleVideoFrame);
    observer.observe(video);
    return () => observer.disconnect();
  }, [videoUrl, hasCanonicalAnnotations]);

  useEffect(() => {
    editorStateLoadedRef.current = false;
    setClipSpeedBlocked(false);
    latestTimelinePayloadRef.current = null;
    lastSavedTimelinePayloadRef.current = null;
    timelineSavePendingRef.current = false;
    if (overlaySaveTimerRef.current !== null) {
      window.clearTimeout(overlaySaveTimerRef.current);
      overlaySaveTimerRef.current = null;
    }
    setTrimEnd(duration);
    setClips([
      {
        id: "clip-1",
        sourceVideoId: videoId,
        start: 0,
        end: duration,
      },
    ]);
    nextClipIdRef.current = 2;
    setSelectedClipId(null);
    setEditorHistory([]);
    setCoverOverlays([]);
    setAnnotations([]);
    setAudioSegments([]);
    setDuckOriginalAudio(false);
    setCopiedAnnotation(null);
    setSelectedCoverOverlayId(null);
    setTimelinePlayheadTime(0);
    activeSourceVideoIdRef.current = videoId;
    activeClipIdRef.current = "clip-1";
    sourceSwitchGenerationRef.current += 1;
    sourceTransitionPendingRef.current = false;
  }, [duration, videoId]);

  useEffect(() => {
    let cancelled = false;

    async function loadEditorState() {
      try {
        const state = await apiFetch<StoredEditorState>(`/api/videos/${videoId}/editor`);
        if (cancelled || !state) return;

        setRenderStatus(state.renderStatus);
        setRendering(state.renderStatus === "processing");
        setRenderedVideoId(state.renderedVideoId);
        if (state.renderStatus === "failed" && state.renderError) {
          setError(state.renderError);
        }

        let restoredClips: EditorClip[] = [{
          id: "clip-1",
          sourceVideoId: videoId,
          start: 0,
          end: duration,
        }];
        let restoredOverlays: EditorCoverOverlay[] = [];
        let restoredAnnotations: EditorAnnotation[] = [];
        if (state.timeline?.version === 1 && state.timeline.clips.length > 0) {
          try {
            restoredClips = state.timeline.clips.map(clipFromStored);
            restoredClips.forEach(clip => requireSupportedClipSpeed(clip.speed));
            restoredAnnotations = requirePreviewAnnotations(state.timeline.annotations ?? []);
          } catch (err) {
            pausePreview();
            videoRef.current?.pause();
            setClipSpeedBlocked(true);
            throw err;
          }
          setClips(restoredClips);
          restoredOverlays = (state.timeline.overlays ?? []).map((overlay) => ({
            ...overlay,
            mode: overlay.mode === "blur" ? "blur" : "cover",
          }));
          setCoverOverlays(restoredOverlays);
          setAnnotations(restoredAnnotations);
          setSelectedCoverOverlayId(null);
          activeClipIdRef.current = restoredClips[0].id;
          activeSourceVideoIdRef.current = restoredClips[0].sourceVideoId;
          const maxClipNumber = restoredClips.reduce((max, clip) => {
            const match = /^clip-(\d+)$/.exec(clip.id);
            return match ? Math.max(max, Number(match[1])) : max;
          }, 0);
          nextClipIdRef.current = maxClipNumber + 1;
          setTimelinePlayheadTime(0);
          setCurrentTime(restoredClips[0].start);
          if (videoRef.current) {
            void switchPreviewSource(
              restoredClips[0].sourceVideoId,
              restoredClips[0].start,
              restoredClips[0].id,
              false,
            );
          } else {
            pendingRestoredPreviewRef.current = restoredClips[0];
          }
        }
        const restoredAudio = state.timeline?.audioSegments ?? coupledAudio(restoredClips);
        try {
          restoredAudio.forEach(segment => {
            requireSupportedAudioSpeed(segment);
            if (audioSource(segment).kind === "audioAsset" && readClipSpeed(segment.speed) !== 1) throw new Error("Audio-Assets unterstützen nur Geschwindigkeit 1.");
          });
          if (restoredAudio.some(segment => audioTrackId(segment) !== "original" || audioSource(segment).kind === "audioAsset")) {
            validateAudioSegments(restoredAudio, restoredClips);
          }
        }
        catch (err) { pausePreview(); videoRef.current?.pause(); setClipSpeedBlocked(true); throw err; }
        if (restoredAudio.some(segment => !validAudioVolume(segment.volume))) throw new Error("Ungültige Audio-Lautstärke.");
        setAudioSegments(restoredAudio);
        const restoredDucking = state.timeline?.duckOriginalAudio === true;
        setDuckOriginalAudio(restoredDucking);
        const restoredPayload = serializeTimeline(restoredClips, restoredOverlays, restoredAnnotations, restoredAudio, restoredDucking);
        latestTimelinePayloadRef.current = restoredPayload;
        lastSavedTimelinePayloadRef.current = restoredPayload;
        editorStateLoadedRef.current = true;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Editorstand konnte nicht geladen werden.");
        }
      }
    }

    void loadEditorState();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  useEffect(() => {
    if (!rendering) return;
    const interval = window.setInterval(async () => {
      try {
        const state = await apiFetch<StoredEditorState>(`/api/videos/${videoId}/editor`);
        if (!state) return;
        setRenderStatus(state.renderStatus);
        setRenderedVideoId(state.renderedVideoId);
        if (state.renderStatus !== "processing") {
          setRendering(false);
          if (state.renderStatus === "failed") {
            setError(state.renderError || "Rendern fehlgeschlagen.");
          }
        }
      } catch (err) {
        setRendering(false);
        setError(err instanceof Error ? err.message : "Renderstatus konnte nicht geladen werden.");
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [rendering, videoId]);

  useEffect(() => () => {
    sourceSwitchGenerationRef.current += 1;
    cancelPendingSourceLoadRef.current?.();
  }, []);

  useEffect(() => {
    voiceoverFinishingRef.current = false;
    setVoiceoverState("idle");
    return () => {
      voiceoverGenerationRef.current++;
      voiceoverSessionRef.current?.dispose();
      voiceoverSessionRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    if (audioPreviewError && voiceoverSessionRef.current?.state === "recording") {
      voiceoverSessionRef.current.transportFailed(new Error(audioPreviewError));
    }
  }, [audioPreviewError]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !showRenderName) closeEditor();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, showRenderName]);

  const clipLayout = layoutEditorClips(clips);
  const timelineDuration = clipLayout.at(-1)?.timelineEnd ?? 0;

  async function startVoiceover() {
    if (voiceoverSessionRef.current || voiceoverFinishingRef.current || clipSpeedBlocked ||
      !videoRef.current || timelinePlayheadTime >= timelineDuration) return;
    const generation = ++voiceoverGenerationRef.current;
    const session = new EditorVoiceoverSession({
      transport: {
        time: () => voiceoverTimeRef.current,
        play: async () => {
          const video = videoRef.current;
          if (!video) throw new Error("Video-Vorschau ist nicht verfügbar.");
          await video.play();
          previewPlayingRef.current = true;
          audioPreviewRef.current?.sync(true, true);
        },
        pause: () => { pausePreview(); videoRef.current?.pause(); },
      },
      changed: state => {
        if (state !== "error" || voiceoverSessionRef.current !== session) return;
        voiceoverGenerationRef.current++;
        voiceoverSessionRef.current = null;
        voiceoverFinishingRef.current = false;
        setVoiceoverState("idle");
        setError(session.error?.message ?? "Voice-over-Aufnahme wurde abgebrochen.");
        session.dispose();
      },
    });
    voiceoverSessionRef.current = session;
    setVoiceoverState("preparing");
    setError(null);
    try {
      await session.prepare();
      if (generation !== voiceoverGenerationRef.current) return;
      await session.start();
      if (generation === voiceoverGenerationRef.current) setVoiceoverState("recording");
    } catch (cause) {
      if (generation === voiceoverGenerationRef.current) {
        session.dispose();
        voiceoverSessionRef.current = null;
        setVoiceoverState("idle");
        setError(cause instanceof Error ? cause.message : "Voice-over-Aufnahme konnte nicht gestartet werden.");
      }
    }
  }

  async function stopVoiceover() {
    const session = voiceoverSessionRef.current;
    if (!session || voiceoverFinishingRef.current || !["recording", "paused"].includes(session.state)) return;
    voiceoverFinishingRef.current = true;
    setVoiceoverState("stopping");
    const generation = voiceoverGenerationRef.current;
    try {
      const inputs = audioResizeInputsRef.current;
      const inserted = await finishVoiceoverToTimeline(session, inputs.clips, inputs.audioSegments, {
        rememberEditorState: () => {
          if (generation !== voiceoverGenerationRef.current) throw new Error("Editor wurde geschlossen.");
          inputs.rememberEditorState();
        },
        setAudioSegments: next => {
          setAudioSegments(next);
          setSelectedAudioId(next.at(-1)?.id ?? null);
        },
      });
      if (generation === voiceoverGenerationRef.current && inserted) setError(null);
    } catch (cause) {
      if (generation === voiceoverGenerationRef.current) {
        setError(cause instanceof Error ? cause.message : "Voice-over konnte nicht gespeichert werden.");
      }
    } finally {
      session.dispose();
      if (generation === voiceoverGenerationRef.current) {
        voiceoverSessionRef.current = null;
        voiceoverFinishingRef.current = false;
        setVoiceoverState("idle");
      }
    }
  }

  const voiceoverBusy = voiceoverState !== "idle";
  function blockDuringVoiceover(event: React.SyntheticEvent) {
    if (!voiceoverBusy || (event.target as Element).closest("[data-voiceover-control]")) return;
    if (voiceoverSessionRef.current?.runEditorAction(() => {}) === false || voiceoverFinishingRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const audioResizeInputsRef = useRef({ clips, audioSegments, timelineZoom, coverOverlays, annotations, editorHistory, rememberEditorState });
  audioResizeInputsRef.current = { clips, audioSegments, timelineZoom, coverOverlays, annotations, editorHistory, rememberEditorState };
  useEffect(() => {
    cancelAudioResizeRef.current?.();
  }, [clips, audioSegments, timelineZoom]);
  useEffect(() => () => cancelAudioResizeRef.current?.(), []);
  useEffect(() => { volumeGestureRef.current?.cancel(); }, [selectedAudioId, clips, audioSegments, coverOverlays, annotations, editorHistory]);
  useEffect(() => () => volumeGestureRef.current?.cancel(), []);
  useEffect(() => {
    if (movingAudioId !== null) cancelAudioResizeRef.current?.();
  }, [coverOverlays, annotations, editorHistory]);

  function handleAudioResize(e: React.PointerEvent<HTMLElement>, segment: EditorAudioSegment, edge: "start" | "end" | "move") {
    e.preventDefault();
    e.stopPropagation();
    if (volumeGestureRef.current) return;
    if (edge === "move" && (e.target as Element).closest("[data-audio-resize-handle]")) return;
    cancelAudioResizeRef.current?.();
    setSelectedAudioId(segment.id);
    const track = e.currentTarget.closest<HTMLElement>("[data-audio-track]");
    const scroller = track?.parentElement;
    const rect = track?.getBoundingClientRect();
    const frozenSpeed = effectiveAudioSpeed(segment, clips);
    const segmentDuration = audioSegmentTimelineDuration(segment, clips);
    if (!track || !scroller || !rect || !Number.isFinite(rect.width) || rect.width <= 0 || timelineDuration <= 0 ||
      (edge === "move" ? !Number.isFinite(segmentDuration) || segmentDuration <= 0 : segmentDuration < 0.1)) return;
    let minimum = 0;
    let maximum = timelineDuration - segmentDuration;
    if (edge === "move") {
      if (![rect.left, rect.top, timelineDuration, e.clientX, scroller.scrollLeft].every(Number.isFinite)) return;
      // Freeze temporal neighbours, without reordering persisted segments.
      const ordered = audioTrackNeighbours(audioSegments, segment);
      const index = ordered.findIndex(item => item.id === segment.id);
      if (index < 0 || new Set(ordered.map(item => item.id)).size !== ordered.length) return;
      let previousEnd = 0;
      for (const item of ordered) {
        const end = item.timelineStart + audioSegmentTimelineDuration(item, clips);
        if (![item.timelineStart, item.sourceStart, item.sourceEnd, end].every(Number.isFinite) ||
          item.sourceStart < 0 || item.sourceEnd < item.sourceStart || item.timelineStart < previousEnd ||
          item.timelineStart < 0 || end > timelineDuration) return;
        previousEnd = end;
      }
      const previous = ordered[index - 1];
      const next = ordered[index + 1];
      minimum = Math.max(0, previous ? previous.timelineStart + audioSegmentTimelineDuration(previous, clips) : 0);
      maximum = Math.min(maximum, next ? next.timelineStart - segmentDuration : maximum);
      if (minimum > maximum || segment.timelineStart < minimum || segment.timelineStart > maximum) return;
      if (maximum - minimum <= 0.000001) return;
      setMovingAudioId(segment.id);
    }
    setAudioGestureActive(true);
    pausePreview();
    videoRef.current?.pause();
    const initial = { ...segment };
    const inputs = audioResizeInputsRef.current;
    const startX = e.clientX;
    const startScroll = scroller.scrollLeft;
    const pointerId = e.pointerId;
    let pointerX = startX;
    let draft = initial;
    let ended = false;
    const valid = () => {
      const current = audioResizeInputsRef.current;
      const bounds = track.getBoundingClientRect();
      return current.clips === inputs.clips && current.audioSegments === inputs.audioSegments &&
        (edge !== "move" || (current.coverOverlays === inputs.coverOverlays && current.annotations === inputs.annotations && current.editorHistory === inputs.editorHistory)) &&
        current.timelineZoom === inputs.timelineZoom && track.isConnected &&
        Math.abs(bounds.width - rect.width) < 0.01 &&
        Math.abs(bounds.left + scroller.scrollLeft - rect.left - startScroll) < 0.01 &&
        Math.abs(bounds.top - rect.top) < 0.01;
    };
    const cleanup = () => {
      ended = true;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancelPointer);
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      observer?.disconnect();
      cancelAudioResizeRef.current = null;
      setAudioResizeDraft(null);
      setMovingAudioId(null);
      setAudioGestureActive(false);
    };
    const cancel = () => { if (!ended) cleanup(); };
    const update = () => {
      if (ended) return;
      if (!valid()) { cancel(); return; }
      const deltaTime = (pointerX - startX + scroller.scrollLeft - startScroll) / rect.width * timelineDuration;
      draft = audioGeometryDraft(initial, edge, deltaTime, frozenSpeed, minimum, maximum);
      setAudioResizeDraft(draft);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerX = event.clientX;
      update();
    };
    const cancelPointer = (event: PointerEvent) => { if (event.pointerId === pointerId) cancel(); };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || ended) return;
      if (!valid()) { cancel(); return; }
      const committed = commitAudioGeometry(initial, draft, frozenSpeed);
      cleanup();
      if (committed === initial) return;
      audioResizeInputsRef.current.rememberEditorState();
      setAudioSegments(previous => previous.map(item => item.id === initial.id ? committed : item));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (!valid()) cancel(); });
    observer?.observe(track);
    cancelAudioResizeRef.current = cancel;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancelPointer);
    scroller.addEventListener("scroll", update);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
  }

  useEffect(() => {
    const payload = serializeTimeline(clips, coverOverlays, annotations, audioSegments, duckOriginalAudio);
    latestTimelinePayloadRef.current = payload;

    if (!editorStateLoadedRef.current) return;
    if (overlaySaveTimerRef.current !== null) {
      window.clearTimeout(overlaySaveTimerRef.current);
      overlaySaveTimerRef.current = null;
    }
    if (payload === lastSavedTimelinePayloadRef.current) {
      timelineSavePendingRef.current = false;
      return;
    }

    timelineSavePendingRef.current = true;
    overlaySaveTimerRef.current = window.setTimeout(() => {
      overlaySaveTimerRef.current = null;
      void apiFetch(`/api/videos/${videoId}/editor`, {
        method: "PUT",
        body: payload,
      }).then(() => {
        lastSavedTimelinePayloadRef.current = payload;
        timelineSavePendingRef.current = latestTimelinePayloadRef.current !== payload;
      }).catch((err) => {
        setError(err instanceof Error ? err.message : "Editorstand konnte nicht gespeichert werden.");
      });
    }, OVERLAY_SAVE_DEBOUNCE_MS);
  }, [clips, coverOverlays, annotations, audioSegments, duckOriginalAudio, videoId]);

  useEffect(() => () => {
    cancelAnnotationDragRef.current?.();
    if (overlaySaveTimerRef.current !== null) {
      window.clearTimeout(overlaySaveTimerRef.current);
    }
    const payload = latestTimelinePayloadRef.current;
    if (timelineSavePendingRef.current && payload) {
      void apiFetch(`/api/videos/${videoId}/editor`, {
        method: "PUT",
        body: payload,
        keepalive: true,
      });
    }
  }, [videoId]);

  const selectedCoverOverlay =
    coverOverlays.find((overlay) => overlay.id === selectedCoverOverlayId) ?? null;

  const visibleTimelineDuration =
    timelineDuration / Math.max(1, timelineZoom);
  const desiredTimelineTickStep = visibleTimelineDuration / 10;
  const timelineTickStep =
    TIMELINE_TICK_STEPS.find((step) => step >= desiredTimelineTickStep) ?? 600;

  function formatTimelineTick(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const secondsInMinute = seconds % 60;

    if (timelineTickStep >= 1) {
      return `${minutes}:${String(Math.floor(secondsInMinute)).padStart(2, "0")}`;
    }

    const decimals = 1;
    const formattedSeconds = secondsInMinute.toFixed(decimals);
    return `${minutes}:${formattedSeconds.padStart(3 + decimals, "0")}`;
  }


  function timelineTimeToClipPosition(timelineTime: number) {
    if (clipSpeedBlocked) return null;
    return timelineClipPosition(clips, timelineTime);
  }

  function timelineStartForClip(clipId: string) {
    return clipLayout.find(({ clip }) => clip.id === clipId)?.timelineStart ?? null;
  }

  function sourceClipAtTime(sourceVideoId: string, sourceTime: number) {
    return clips.find(
      (clip) =>
        clip.sourceVideoId === sourceVideoId &&
        sourceTime >= clip.start - 0.001 &&
        sourceTime <= clip.end + 0.001,
    );
  }

  function advancePreviewToNextClip() {
    if (sourceTransitionPendingRef.current) return;
    const currentIndex = clips.findIndex((clip) => clip.id === activeClipIdRef.current);
    if (currentIndex < 0) return;
    if (currentIndex >= clips.length - 1) {
      if (voiceoverSessionRef.current?.state === "recording") void stopVoiceover();
      pausePreview();
      videoRef.current?.pause();
      setTimelinePlayheadTime(timelineDuration);
      return;
    }

    const nextClip = clips[currentIndex + 1];
    const nextTimelineStart = timelineStartForClip(nextClip.id);
    if (nextTimelineStart === null) return;

    sourceTransitionPendingRef.current = true;
    setTimelinePlayheadTime(nextTimelineStart);
    setCurrentTime(nextClip.start);
    setSelectedClipId(nextClip.id);
    void switchPreviewSource(
      nextClip.sourceVideoId,
      nextClip.start,
      nextClip.id,
      true,
      canContinueClipSource(clips[currentIndex], nextClip),
    );
  }

  function timeFromClientX(clientX: number) {
    const timeline = timelineRef.current;
    if (!timeline || !duration) return 0;

    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return (x / rect.width) * duration;
  }

  function handleTrimPointerDown(handle: "start" | "end") {
    return (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingTrimRef.current = handle;

      const fixedStart = trimStart;
      const fixedEnd = trimEnd;
      const minimumGap = 1;

      function onMove(ev: MouseEvent | TouchEvent) {
        const point = "touches" in ev ? ev.touches[0] : ev;
        if (!point) return;

        const rawTime = timeFromClientX(point.clientX);

        let nextTime = rawTime;

        if (handle === "start") {
          nextTime = Math.max(
            0,
            Math.min(rawTime, fixedEnd - minimumGap)
          );
          setTrimStart(nextTime);
        } else {
          nextTime = Math.min(
            duration,
            Math.max(rawTime, fixedStart + minimumGap)
          );
          setTrimEnd(nextTime);
        }

        setCurrentTime(nextTime);

        if (videoRef.current && activeSourceVideoIdRef.current === videoId) {
          videoRef.current.currentTime = nextTime;
        } else {
          void switchPreviewSource(
            videoId,
            nextTime,
            sourceClipAtTime(videoId, nextTime)?.id,
          );
        }
      }

      function onUp() {
        draggingTrimRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    };
  }

  function handleTimelineClick(e: React.MouseEvent<HTMLDivElement>) {
    if (voiceoverSessionRef.current?.actionsLocked || voiceoverFinishingRef.current) return;
    if (!timelineDuration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));

    const timelineTime =
      (x / rect.width) * timelineDuration;

    const position =
      timelineTimeToClipPosition(timelineTime);

    if (!position) return;

    setTimelinePlayheadTime(timelineTime);
    setSelectedClipId(position.clip.id);
    setError(null);
    setCurrentTime(position.sourceTime);
    void switchPreviewSource(
      position.clip.sourceVideoId,
      position.sourceTime,
      position.clip.id,
    );
  }

  useEffect(() => {
    function handleTimelineArrowKeys(e: KeyboardEvent) {
      if (voiceoverSessionRef.current?.actionsLocked || voiceoverFinishingRef.current) return;
      const target = e.target as HTMLElement | null;

      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (!timelineDuration) return;

      e.preventDefault();

      const delta = e.key === "ArrowLeft" ? -0.1 : 0.1;
      const nextTimelineTime = Math.max(
        0,
        Math.min(timelinePlayheadTime + delta, timelineDuration),
      );

      const position = timelineTimeToClipPosition(nextTimelineTime);
      if (!position) return;

      videoRef.current?.pause();
      setTimelinePlayheadTime(nextTimelineTime);
      setSelectedClipId(position.clip.id);
      setError(null);
      setCurrentTime(position.sourceTime);

      void switchPreviewSource(
        position.clip.sourceVideoId,
        position.sourceTime,
        position.clip.id,
      );
    }

    document.addEventListener("keydown", handleTimelineArrowKeys);
    return () =>
      document.removeEventListener("keydown", handleTimelineArrowKeys);
  }, [
    timelinePlayheadTime,
    timelineDuration,
    clips,
    timelineTimeToClipPosition,
    switchPreviewSource,
  ]);

  async function handleOpenInsertPicker() {
    if (!allowCoupledClipAction()) return;
    setShowInsertPicker(true);
    setLoadingLibrary(true);
    setError(null);

    try {
      const videos = await apiFetch<Video[]>("/api/videos");

      setLibraryVideos(
        (videos ?? []).filter(
          (video) =>
            video.id !== videoId &&
            video.status === "ready" &&
            video.duration > 0,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Videobibliothek konnte nicht geladen werden.",
      );
    } finally {
      setLoadingLibrary(false);
    }
  }

  function handleInsertSelectedVideo() {
    if (!allowCoupledClipAction()) return;
    if (!selectedInsertVideo) {
      setError("Bitte zuerst ein Video auswählen.");
      return;
    }

    const insertAt = Math.max(
      0,
      Math.min(timelinePlayheadTime, timelineDuration),
    );

    const position =
      timelineTimeToClipPosition(insertAt);

    const insertedId =
      `clip-${nextClipIdRef.current++}`;

    const insertedClip: EditorClip = {
      id: insertedId,
      sourceVideoId: selectedInsertVideo.id,
      sourceTitle:
        selectedInsertVideo.title || "Unbenanntes Video",
      start: 0,
      end: selectedInsertVideo.duration,
    };

    rememberEditorState();

    updateCoupledClips((previousClips) => {
      if (!position) {
        return [...previousClips, insertedClip];
      }

      const { clip, index, sourceTime, timelineStart } =
        position;

      const clipDuration = clipTimelineDuration(clip.start, clip.end, clip.speed);
      const distanceFromStart =
        insertAt - timelineStart;
      const distanceFromEnd =
        clipDuration - distanceFromStart;

      // Genau am Anfang eines Clips
      if (distanceFromStart <= 0.001) {
        return [
          ...previousClips.slice(0, index),
          insertedClip,
          ...previousClips.slice(index),
        ];
      }

      // Genau am Ende eines Clips
      if (distanceFromEnd <= 0.001) {
        return [
          ...previousClips.slice(0, index + 1),
          insertedClip,
          ...previousClips.slice(index + 1),
        ];
      }

      // Mitten im Clip: automatisch teilen
      const leftClip: EditorClip = {
        ...clip,
        id: `clip-${nextClipIdRef.current++}`,
        end: sourceTime,
      };

      const rightClip: EditorClip = {
        ...clip,
        id: `clip-${nextClipIdRef.current++}`,
        start: sourceTime,
      };

      return [
        ...previousClips.slice(0, index),
        leftClip,
        insertedClip,
        rightClip,
        ...previousClips.slice(index + 1),
      ];
    });

    setTimelinePlayheadTime(
      insertAt + selectedInsertVideo.duration,
    );
    setSelectedClipId(insertedId);
    void switchPreviewSource(
      insertedClip.sourceVideoId,
      insertedClip.end,
      insertedId,
      false,
    );
    setSelectedInsertVideo(null);
    setError(null);
  }

  function allowCoupledClipAction() {
    if (isAudioStillCoupled(clips, audioSegments)) return true;
    setError(INDEPENDENT_AUDIO_WARNING);
    return false;
  }

  function handleClipSpeed(speed: number) {
    if (volumeGestureRef.current || cancelAudioResizeRef.current) return;
    const selected = clips.find(clip => clip.id === selectedClipId);
    if (!selected || readClipSpeed(selected.speed) === speed) return;
    try {
      const next = changeClipSpeed(clips, audioSegments, selected.id, speed);
      if ([...coverOverlays, ...annotations].some(item => item.end > next.duration + 0.001)) {
        throw new Error("Die Geschwindigkeit würde bestehende Overlays oder Annotationen über das Videoende hinausschieben.");
      }
      rememberEditorState();
      setClips(next.clips);
      setAudioSegments(next.audioSegments);
      const active = layoutEditorClips(next.clips).find(item => item.clip.id === activeClipIdRef.current);
      if (active) setTimelinePlayheadTime(clipSourceToTimelineTime(active.clip, active.timelineStart, videoRef.current?.currentTime ?? currentTime));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Geschwindigkeit konnte nicht geändert werden.");
    }
  }

  function rememberEditorState() {
    setEditorHistory((history) => [
      ...history.slice(-49),
      {
        clips: clips.map((clip) => ({ ...clip })),
        audioSegments: audioSegments.map(cloneAudioSegment),
        duckOriginalAudio,
        coverOverlays: coverOverlays.map((overlay) => ({ ...overlay })),
        annotations: annotations.map((annotation) => ({ ...annotation })),
      },
    ]);
  }

  function handleDeleteAudio() {
    if (volumeGestureRef.current || cancelAudioResizeRef.current || !selectedAudioId) return;
    if (!audioSegments.some(segment => segment.id === selectedAudioId)) return;
    pausePreview();
    videoRef.current?.pause();
    rememberEditorState();
    setAudioSegments(previous => previous.filter(segment => segment.id !== selectedAudioId));
    setSelectedAudioId(null);
  }

  function beginAudioVolume(pointerId?: number) {
    if (volumeGestureRef.current || cancelAudioResizeRef.current || !selectedAudioId) return;
    const selected = audioSegments.find(segment => segment.id === selectedAudioId);
    if (!selected || !validAudioVolume(selected.volume)) return;
    const inputs = audioResizeInputsRef.current;
    let value = selected.volume ?? 1;
    let ended = false;
    const cleanup = (restoreVolume = true) => {
      ended = true;
      volumeGestureRef.current = null;
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("blur", cancel);
      setAudioVolumeDraft(null);
      audioPreviewRef.current?.setVolumeDraft(null, restoreVolume);
    };
    const cancel = () => { if (!ended) cleanup(); };
    const finish = () => {
      if (ended) return;
      const current = audioResizeInputsRef.current;
      if (current.audioSegments !== inputs.audioSegments || current.clips !== inputs.clips ||
        current.editorHistory !== inputs.editorHistory) { cancel(); return; }
      const changed = Math.abs(value - (selected.volume ?? 1)) > 1e-9;
      // Keep the live gain until React publishes the committed value; no old-gain blip.
      cleanup(!changed);
      if (!changed) return;
      current.rememberEditorState();
      setAudioSegments(previous => previous.map(segment => segment.id === selected.id ? { ...segment, volume: value } : segment));
    };
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
    const cancelled = (event: PointerEvent) => { if (event.pointerId === pointerId) cancel(); };
    volumeGestureRef.current = {
      cancel, finish,
      change: next => {
        if (ended || !validAudioVolume(next)) return;
        value = next;
        const draft = { id: selected.id, value };
        setAudioVolumeDraft(draft);
        audioPreviewRef.current?.setVolumeDraft(draft);
      },
    };
    setAudioVolumeDraft({ id: selected.id, value });
    if (pointerId !== undefined) {
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancelled);
    }
    window.addEventListener("blur", cancel);
  }

  function handleToggleAudioMute() {
    if (volumeGestureRef.current || cancelAudioResizeRef.current || !selectedAudioId) return;
    const selected = audioSegments.find(segment => segment.id === selectedAudioId);
    if (!selected) return;
    pausePreview();
    videoRef.current?.pause();
    rememberEditorState();
    setAudioSegments(previous => previous.map(segment => segment.id === selected.id
      ? { ...segment, muted: selected.muted !== true } : segment));
  }

  function handleUndo() {
    textAnnotationEditRef.current = null;
    setTextAnnotationDraft(null);
    volumeGestureRef.current?.cancel();
    cancelAudioResizeRef.current?.();
    if (editorHistory.length === 0) return;

    const previousState = editorHistory[editorHistory.length - 1];
    const clipsChanged = serializeTimeline(previousState.clips, coverOverlays) !==
      serializeTimeline(clips, coverOverlays);

    setClips(previousState.clips);
    setAudioSegments(previousState.audioSegments);
    setDuckOriginalAudio(previousState.duckOriginalAudio);
    setCoverOverlays(previousState.coverOverlays);
    setAnnotations(previousState.annotations);
    setEditorHistory((history) => history.slice(0, -1));
    setSelectedClipId(null);
    setSelectedCoverOverlayId(null);
    const firstClip = previousState.clips[0];
    if (clipsChanged && firstClip) {
      setTimelinePlayheadTime(0);
      setCurrentTime(firstClip.start);
      void switchPreviewSource(
        firstClip.sourceVideoId,
        firstClip.start,
        firstClip.id,
        false,
      );
    }
    setError(null);
  }

  function handleSplit() {
    if (volumeGestureRef.current || cancelAudioResizeRef.current) return;

    const position =
      timelineTimeToClipPosition(timelinePlayheadTime);

    if (!position) {
      setError("Zum Teilen muss der Abspielkopf innerhalb eines Clips stehen.");
      return;
    }

    const { clip, index, sourceTime } = position;

    const split = splitEditorClip(clip, sourceTime, `clip-${nextClipIdRef.current}`, `clip-${nextClipIdRef.current + 1}`);
    if (!split) {
      setError(
        "Zum Teilen muss der Abspielkopf innerhalb eines Clips stehen.",
      );
      return;
    }

    const [leftClip, rightClip] = split;
    let nextAudio: EditorAudioSegment[];
    try {
      const item = clipLayout[index];
      nextAudio = splitLinkedAudioSegments(audioSegments, clip, item.timelineStart, leftClip, rightClip);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Clip konnte nicht geteilt werden.");
      return;
    }
    rememberEditorState();
    nextClipIdRef.current += 2;

    setClips((previousClips) => [
      ...previousClips.slice(0, index),
      leftClip,
      rightClip,
      ...previousClips.slice(index + 1),
    ]);
    setAudioSegments(nextAudio);

    if (activeClipIdRef.current === clip.id) {
      activeClipIdRef.current = rightClip.id;
    }

    setSelectedClipId(null);
    setError(previous => previous === INDEPENDENT_AUDIO_WARNING ? previous : null);
  }

  function handleCoverOverlayPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    overlayId: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedCoverOverlayId(overlayId);

    const overlay = coverOverlays.find((item) => item.id === overlayId);
    const container = e.currentTarget.parentElement;

    if (!overlay || !container) return;

    const rect = container.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = overlay.x;
    const startY = overlay.y;
    const overlayWidth = overlay.width;
    const overlayHeight = overlay.height;
    let historyCaptured = false;

    function onMove(ev: PointerEvent) {
      if (!historyCaptured) {
        rememberEditorState();
        historyCaptured = true;
      }
      const deltaX = ((ev.clientX - startClientX) / rect.width) * 100;
      const deltaY = ((ev.clientY - startClientY) / rect.height) * 100;

      const nextX = Math.max(
        0,
        Math.min(100 - overlayWidth, startX + deltaX),
      );
      const nextY = Math.max(
        0,
        Math.min(100 - overlayHeight, startY + deltaY),
      );

      setCoverOverlays((previous) =>
        previous.map((item) =>
          item.id === overlayId
            ? { ...item, x: nextX, y: nextY }
            : item,
        ),
      );
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleCoverOverlayResizePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    overlayId: string,
  ) {
    e.preventDefault();
    e.stopPropagation();

    const overlay = coverOverlays.find((item) => item.id === overlayId);
    const container = e.currentTarget.parentElement?.parentElement;

    if (!overlay || !container) return;

    const rect = container.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startWidth = overlay.width;
    const startHeight = overlay.height;
    const overlayX = overlay.x;
    const overlayY = overlay.y;
    let historyCaptured = false;

    function onMove(ev: PointerEvent) {
      if (!historyCaptured) {
        rememberEditorState();
        historyCaptured = true;
      }
      const deltaX = ((ev.clientX - startClientX) / rect.width) * 100;
      const deltaY = ((ev.clientY - startClientY) / rect.height) * 100;

      const nextWidth = Math.max(
        5,
        Math.min(100 - overlayX, startWidth + deltaX),
      );
      const nextHeight = Math.max(
        5,
        Math.min(100 - overlayY, startHeight + deltaY),
      );

      setCoverOverlays((previous) =>
        previous.map((item) =>
          item.id === overlayId
            ? { ...item, width: nextWidth, height: nextHeight }
            : item,
        ),
      );
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleCoverOverlayTimelineMovePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    overlayId: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedCoverOverlayId(overlayId);

    const overlay = coverOverlays.find((item) => item.id === overlayId);
    const track = e.currentTarget.parentElement;

    if (!overlay || !track || timelineDuration <= 0) return;

    const rect = track.getBoundingClientRect();
    const startClientX = e.clientX;
    const originalStart = overlay.start;
    const overlayDuration = overlay.end - overlay.start;
    let historyCaptured = false;

    function onMove(ev: PointerEvent) {
      if (!historyCaptured) {
        rememberEditorState();
        historyCaptured = true;
      }
      const deltaTime =
        ((ev.clientX - startClientX) / rect.width) * timelineDuration;

      const start = Math.max(
        0,
        Math.min(
          timelineDuration - overlayDuration,
          originalStart + deltaTime,
        ),
      );

      const end = start + overlayDuration;

      setCoverOverlays((previous) =>
        previous.map((item) =>
          item.id === overlayId
            ? { ...item, start, end }
            : item,
        ),
      );
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleCoverOverlayTimelineStartPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    overlayId: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedCoverOverlayId(overlayId);

    const overlay = coverOverlays.find((item) => item.id === overlayId);
    const track = e.currentTarget.parentElement?.parentElement;

    if (!overlay || !track || timelineDuration <= 0) return;

    const rect = track.getBoundingClientRect();
    const minimumGap = 0.1;
    const overlayEnd = overlay.end;
    let historyCaptured = false;

    function onMove(ev: PointerEvent) {
      if (!historyCaptured) {
        rememberEditorState();
        historyCaptured = true;
      }
      const x = Math.max(
        0,
        Math.min(ev.clientX - rect.left, rect.width),
      );

      const rawTime = (x / rect.width) * timelineDuration;
      const start = Math.max(
        0,
        Math.min(rawTime, overlayEnd - minimumGap),
      );

      setCoverOverlays((previous) =>
        previous.map((item) =>
          item.id === overlayId
            ? { ...item, start }
            : item,
        ),
      );
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleCoverOverlayTimelineEndPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    overlayId: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedCoverOverlayId(overlayId);

    const overlay = coverOverlays.find((item) => item.id === overlayId);
    const track = e.currentTarget.parentElement?.parentElement;

    if (!overlay || !track || timelineDuration <= 0) return;

    const rect = track.getBoundingClientRect();
    const minimumGap = 0.1;
    const overlayStart = overlay.start;
    let historyCaptured = false;

    function onMove(ev: PointerEvent) {
      if (!historyCaptured) {
        rememberEditorState();
        historyCaptured = true;
      }
      const x = Math.max(
        0,
        Math.min(ev.clientX - rect.left, rect.width),
      );

      const rawTime = (x / rect.width) * timelineDuration;
      const end = Math.min(
        timelineDuration,
        Math.max(rawTime, overlayStart + minimumGap),
      );

      setCoverOverlays((previous) =>
        previous.map((item) =>
          item.id === overlayId
            ? { ...item, end }
            : item,
        ),
      );
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleCopyCoverOverlay() {
    const overlayToCopy = coverOverlays.find(
      (overlay) => overlay.id === selectedCoverOverlayId,
    );
    if (!overlayToCopy) {
      setError("Bitte zuerst eine Abdeckung auswählen.");
      return;
    }

    setCopiedCoverOverlay({ ...overlayToCopy });
    setError(null);
  }

  function handleCoverOverlayModeChange(mode: "cover" | "blur") {
    if (!selectedCoverOverlay || selectedCoverOverlay.mode === mode) return;

    rememberEditorState();
    setCoverOverlays((previous) =>
      previous.map((overlay) =>
        overlay.id === selectedCoverOverlay.id ? { ...overlay, mode } : overlay,
      ),
    );
    setError(null);
  }

  function handleCoverOverlayColorChange(color: string) {
    if (!selectedCoverOverlay || (selectedCoverOverlay.mode ?? "cover") !== "cover") return;

    rememberEditorState();
    setCoverOverlays((previous) =>
      previous.map((overlay) =>
        overlay.id === selectedCoverOverlay.id ? { ...overlay, color } : overlay,
      ),
    );
    setError(null);
  }

  function handleCoverOverlayOpacityChange(opacity: number) {
    if (!selectedCoverOverlay || (selectedCoverOverlay.mode ?? "cover") !== "cover") return;

    const normalizedOpacity = Math.max(0.1, Math.min(1, opacity));
    if (normalizedOpacity === (selectedCoverOverlay.opacity ?? 1)) return;

    setCoverOverlays((previous) =>
      previous.map((overlay) =>
        overlay.id === selectedCoverOverlay.id
          ? { ...overlay, opacity: normalizedOpacity }
          : overlay,
      ),
    );
    setError(null);
  }

  function handleCoverOverlayTextChange(text: string) {
    if (!selectedCoverOverlay || (selectedCoverOverlay.mode ?? "cover") !== "cover") return;
    if (text === (selectedCoverOverlay.text ?? "")) return;
    if (textEditOverlayRef.current !== selectedCoverOverlay.id) {
      rememberEditorState();
      textEditOverlayRef.current = selectedCoverOverlay.id;
    }
    setCoverOverlays((previous) => previous.map((overlay) =>
      overlay.id === selectedCoverOverlay.id ? { ...overlay, text: text.slice(0, 120) } : overlay,
    ));
  }

  function handleDeleteSelectedCoverOverlay() {
    if (!selectedCoverOverlayId) return;

    rememberEditorState();
    setCoverOverlays((previous) =>
      previous.filter((overlay) => overlay.id !== selectedCoverOverlayId),
    );
    setSelectedCoverOverlayId(null);
    setError(null);
  }

  function handlePasteCoverOverlay() {
    if (!copiedCoverOverlay || timelineDuration <= 0) {
      setError("Es ist keine Abdeckung zum Einfügen kopiert.");
      return;
    }

    const duration = copiedCoverOverlay.end - copiedCoverOverlay.start;
    const start = Math.min(
      timelinePlayheadTime,
      Math.max(0, timelineDuration - 0.1),
    );
    const end = Math.min(timelineDuration, start + duration);

    const pastedOverlay: EditorCoverOverlay = {
      ...copiedCoverOverlay,
      id: `cover-${Date.now()}`,
      start,
      end,
    };

    rememberEditorState();
    setCoverOverlays((previous) => [...previous, pastedOverlay]);
    setSelectedCoverOverlayId(pastedOverlay.id);
    setError(null);
  }

  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId);
  const annotationName = (item: EditorAnnotation) => t(item.type === "text" ? "editor.text" : item.type === "line" ? "editor.line" : item.type === "symbol" ? "editor.symbol" : item.type === "circle" ? "editor.circle" : "editor.arrow");

  function addAnnotation(source?: EditorAnnotation, type: EditorAnnotation["type"] = "arrow", symbol?: AnnotationSymbol) {
    if (timelineDuration <= 0) return;
    const start = Math.min(timelinePlayheadTime, Math.max(0, timelineDuration - 0.1));
    const defaultSize = type === "symbol" ? 18 : 30;
    const annotation: EditorAnnotation = source
      ? { ...source, id: crypto.randomUUID(),
          // Clipboard geometry uses the same frame-relative bounds as dragging.
          // Do not offset copies; only bring out-of-bounds positions back inside.
          x: source.type === "line" ? source.x : Math.max(0, Math.min(100 - source.width, source.x)),
          y: source.type === "line" ? source.y : Math.max(0, Math.min(100 - source.height, source.y)) }
      : type === "text" ? { id: crypto.randomUUID(), type: "text", text: "Text", x: 30, y: 45,
          width: TEXT_LAYOUT.width, height: TEXT_LAYOUT.height, fontSize: TEXT_LAYOUT.fontSize, color: TEXT_LAYOUT.color,
          start, end: Math.min(timelineDuration, start + 5) }
      : { id: crypto.randomUUID(), type, ...(type === "symbol" ? { symbol } : {}), x: 35, y: 35,
          width: type !== "arrow" ? Math.min(defaultSize, defaultSize * (videoFrameRect.height || 9) / (videoFrameRect.width || 16)) : 30,
          height: type !== "arrow" ? Math.min(defaultSize, defaultSize * (videoFrameRect.width || 16) / (videoFrameRect.height || 9)) : 20,
          start, end: Math.min(timelineDuration, start + 5), rotation: 0 };
    rememberEditorState();
    setAnnotations((previous) => [...previous, annotation]);
    selectAnnotation(annotation.id);
  }

  function updateAnnotation(patch: { start?: number; end?: number; rotation?: number; color?: string; shaftWidth?: number; strokeWidth?: number }) {
    if (!selectedAnnotation) return;
    if (patch.shaftWidth !== undefined && (selectedAnnotation.type !== "arrow" || arrowShaftWidth(patch.shaftWidth) === arrowShaftWidth(selectedAnnotation.shaftWidth))) return;
    if (patch.strokeWidth !== undefined) {
      if (selectedAnnotation.type !== "line" && selectedAnnotation.type !== "circle") return;
      const readStroke = selectedAnnotation.type === "circle" ? circleStrokeWidth : lineStrokeWidth;
      if (readStroke(patch.strokeWidth) === readStroke(selectedAnnotation.strokeWidth)) return;
    }
    const currentColor = selectedAnnotation.type === "text" ? selectedAnnotation.color || TEXT_LAYOUT.color : selectedAnnotation.color ?? "#FC2667";
    if (patch.color !== undefined && (!/^#[0-9a-fA-F]{6}$/.test(patch.color) || patch.color === currentColor)) return;
    rememberEditorState();
    setAnnotations((previous) => previous.map((item) =>
      item.id === selectedAnnotation.id ? { ...item, ...patch } : item));
  }

  function updateTextTypography(patch: TextTypography) {
    if (selectedAnnotation?.type !== "text") return;
    const next = { ...selectedAnnotation, ...patch };
    validateTextAnnotation(next);
    const before = textTypography(selectedAnnotation), after = textTypography(next);
    if (before.fontFamily === after.fontFamily && before.bold === after.bold && before.italic === after.italic) return;
    textAnnotationEditRef.current = null;
    rememberEditorState();
    setAnnotations(previous => previous.map(item => item.id === next.id ? next : item));
  }

  function updateTextProperty(field: "text" | "fontSize", value: string | number) {
    if (selectedAnnotation?.type !== "text") return;
    const patch = field === "text" ? { text: [...String(value)].slice(0, TEXT_LAYOUT.maxLength).join("") } : { fontSize: Number(value) };
    if ("text" in patch) setTextAnnotationDraft({ id: selectedAnnotation.id, text: patch.text! });
    const next = { ...selectedAnnotation, ...patch };
    try { validateTextAnnotation(next); } catch { return; }
    if (next.text === selectedAnnotation.text && next.fontSize === selectedAnnotation.fontSize) return;
    const session = `${selectedAnnotation.id}:${field}`;
    if (textAnnotationEditRef.current !== session) { rememberEditorState(); textAnnotationEditRef.current = session; }
    setAnnotations(previous => previous.map(item => item.id === next.id ? next : item));
  }

  function handleAnnotationPointerDown(e: React.PointerEvent<HTMLDivElement>, annotation: EditorAnnotation, resize = false) {
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(annotation.id);
    const rect = (annotation.type === "text" ? textFrameRef : annotation.type === "arrow" || annotation.type === "line" || annotation.type === "circle" || annotation.type === "symbol" ? arrowFrameRef : annotationFrameRef).current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    cancelAnnotationDragRef.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    let lastLineScale = 1;
    let captured = false;
    const move = (event: PointerEvent) => {
      if (annotation.type === "text") {
        const dx = (event.clientX - startX) / rect.width * 100;
        const dy = (event.clientY - startY) / rect.height * 100;
        const geometry = resize
          ? { x: annotation.x, y: annotation.y,
              width: Math.min(100 - annotation.x, Math.max(TEXT_LAYOUT.minWidth, annotation.width + dx)),
              height: Math.min(100 - annotation.y, Math.max(TEXT_LAYOUT.minHeight, annotation.height + dy)) }
          : { width: annotation.width, height: annotation.height,
              x: Math.max(0, Math.min(100 - annotation.width, annotation.x + dx)),
              y: Math.max(0, Math.min(100 - annotation.height, annotation.y + dy)) };
        if (!captured && geometry.x === annotation.x && geometry.y === annotation.y && geometry.width === annotation.width && geometry.height === annotation.height) return;
        if (!captured) { rememberEditorState(); captured = true; }
        setAnnotations(previous => previous.map(item => item.id === annotation.id ? { ...item, ...geometry } : item));
        return;
      }
      if (resize && annotation.type === "line") {
        const radians = annotation.rotation * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        // SVG rotates before its non-uniform viewport scale. Project in actual
        // screen pixels, not independently normalized x/y coordinates.
        const vx = .84 * annotation.width * rect.width / 100 * cos;
        const vy = .84 * annotation.height * rect.height / 100 * sin;
        const deltaScale = ((event.clientX - startX) * vx + (event.clientY - startY) * vy) / (vx * vx + vy * vy);
        // Keep the SVG's first endpoint (8,50) fixed while scaling its viewport.
        const ax = .5 - .42 * cos, ay = .5 - .42 * sin;
        const fixedX = annotation.x + annotation.width * ax;
        const fixedY = annotation.y + annotation.height * ay;
        // Intersect the actual endpoint ray with the frame, not its invisible SVG box.
        const rayLimit = (origin: number, delta: number) => Math.abs(delta) < 1e-10
          ? Infinity : (delta > 0 ? 100 - origin : -origin) / delta;
        const maximum = Math.min(rayLimit(fixedX, .84 * annotation.width * cos),
          rayLimit(fixedY, .84 * annotation.height * sin));
        const minimum = Math.min(1, Math.max(5 / annotation.width, 5 / annotation.height));
        const scale = Math.max(minimum, Math.min(maximum, 1 + deltaScale));
        if (Math.abs(scale - lastLineScale) < 1e-10) return;
        if (!captured) { rememberEditorState(); captured = true; }
        lastLineScale = scale;
        const width = annotation.width * scale, height = annotation.height * scale;
        setAnnotations((previous) => previous.map((item) => item.id === annotation.id
          ? { ...item, width, height, x: fixedX - width * ax, y: fixedY - height * ay } : item));
        return;
      }
      if (event.clientX === startX && event.clientY === startY && !captured) return;
      if (!captured) { rememberEditorState(); captured = true; }
      const dx = (event.clientX - startX) / rect.width * 100;
      const dy = (event.clientY - startY) / rect.height * 100;
      if (!resize && annotation.type === "line") {
        const r = annotation.rotation * Math.PI / 180;
        const cx = annotation.x + annotation.width / 2, cy = annotation.y + annotation.height / 2;
        const rx = Math.abs(.42 * annotation.width * Math.cos(r));
        const ry = Math.abs(.42 * annotation.height * Math.sin(r));
        const shiftX = Math.max(rx - cx, Math.min(100 - cx - rx, dx));
        const shiftY = Math.max(ry - cy, Math.min(100 - cy - ry, dy));
        setAnnotations((previous) => previous.map((item) => item.id === annotation.id
          ? { ...item, x: annotation.x + shiftX, y: annotation.y + shiftY } : item));
        return;
      }
      const geometry = resize
        ? { width: Math.min(100 - annotation.x, Math.max(5, annotation.width + dx)),
            height: Math.min(100 - annotation.y, Math.max(5, annotation.height + dy)) }
        : { x: Math.max(0, Math.min(100 - annotation.width, annotation.x + dx)),
            y: Math.max(0, Math.min(100 - annotation.height, annotation.y + dy)) };
      setAnnotations((previous) => previous.map((item) => item.id === annotation.id ? { ...item, ...geometry } : item));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      cancelAnnotationDragRef.current = null;
    };
    cancelAnnotationDragRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }

  function handleAnnotationRotation(e: React.PointerEvent<HTMLButtonElement>, annotation: EditorAnnotation) {
    if (annotation.type === "text") return;
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(annotation.id);
    const rect = (annotation.type === "arrow" || annotation.type === "line" || annotation.type === "symbol" ? arrowFrameRef : annotationFrameRef).current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    cancelAnnotationDragRef.current?.();
    const width = rect.width * annotation.width / 100;
    const height = rect.height * annotation.height / 100;
    const cx = rect.left + rect.width * (annotation.x + annotation.width / 2) / 100;
    const cy = rect.top + rect.height * (annotation.y + annotation.height / 2) / 100;
    // Undo the SVG viewport's non-uniform scale before measuring its angle.
    // Rotation remains in the existing 100x100 viewBox around (50,50).
    const angleAt = (x: number, y: number) => Math.atan2((y - cy) / height, (x - cx) / width) * 180 / Math.PI;
    const initialAngle = angleAt(e.clientX, e.clientY);
    let captured = false;
    let lastRotation = annotation.rotation;
    const move = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - cx, event.clientY - cy) < 2) return;
      const angle = annotation.rotation + angleAt(event.clientX, event.clientY) - initialAngle;
      const rotation = Math.round(((angle % 360 + 360) % 360) * 1000) / 1000 % 360;
      if (rotation === lastRotation) return;
      if (!captured) { rememberEditorState(); captured = true; }
      lastRotation = rotation;
      setAnnotations((previous) => previous.map((item) => item.id === annotation.id ? { ...item, rotation } : item));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      cancelAnnotationDragRef.current = null;
    };
    cancelAnnotationDragRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }

  function handleAnnotationTimelinePointerDown(e: React.PointerEvent<HTMLElement>, annotation: EditorAnnotation, edge: "start" | "end" | "move") {
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(annotation.id);
    const track = edge === "move" ? e.currentTarget.parentElement : e.currentTarget.parentElement?.parentElement;
    const rect = track?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || timelineDuration <= 0) return;
    cancelAnnotationDragRef.current?.();
    const startClientX = e.clientX;
    let captured = false;
    const duration = annotation.end - annotation.start;
    const initialValue = edge === "end" ? annotation.end : annotation.start;
    let lastValue = initialValue;
    const move = (event: PointerEvent) => {
      const rawTime = initialValue + (event.clientX - startClientX) / rect.width * timelineDuration;
      const value = edge === "move"
        ? Math.max(0, Math.min(timelineDuration - duration, rawTime))
        : edge === "start"
        ? Math.max(0, Math.min(annotation.end - 0.1, rawTime))
        : Math.min(timelineDuration, Math.max(annotation.start + 0.1, rawTime));
      if (value === lastValue) return;
      if (!captured) { rememberEditorState(); captured = true; }
      lastValue = value;
      const times = edge === "move" ? { start: value, end: value + duration } : { [edge]: value };
      setAnnotations((previous) => previous.map((item) => item.id === annotation.id ? { ...item, ...times } : item));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      cancelAnnotationDragRef.current = null;
    };
    cancelAnnotationDragRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }

  function handleAddCoverOverlay() {
    if (timelineDuration <= 0) return;

    const start = Math.min(
      timelinePlayheadTime,
      Math.max(0, timelineDuration - 0.1),
    );
    const end = Math.min(timelineDuration, start + 5);

    const overlay: EditorCoverOverlay = {
      id: `cover-${Date.now()}`,
      x: 30,
      y: 30,
      width: 40,
      height: 20,
      start,
      end,
      mode: "cover",
      color: "#000000",
      opacity: 1,
    };

    rememberEditorState();
    setCoverOverlays((previous) => [...previous, overlay]);
    setSelectedCoverOverlayId(overlay.id);
    setError(null);
  }

  function handleDeleteSelectedClip() {
    if (!allowCoupledClipAction()) return;
    if (!selectedClipId) {
      setError("Bitte zuerst einen Clip auswählen.");
      return;
    }

    if (clips.length <= 1) {
      setError("Der letzte verbleibende Clip kann nicht gelöscht werden.");
      return;
    }

    const selectedClip = clips.find(
      (clip) => clip.id === selectedClipId,
    );

    if (!selectedClip) return;

    rememberEditorState();

    updateCoupledClips((previousClips) =>
      previousClips.filter(
        (clip) => clip.id !== selectedClipId,
      ),
    );

    if (activeClipIdRef.current === selectedClipId) {
      const remainingClips = clips.filter((clip) => clip.id !== selectedClipId);
      const nextClip = remainingClips[0];
      if (nextClip) {
        setTimelinePlayheadTime(0);
        setCurrentTime(nextClip.start);
        void switchPreviewSource(
          nextClip.sourceVideoId,
          nextClip.start,
          nextClip.id,
          false,
        );
      }
    }

    setSelectedClipId(null);
    setError(null);
  }

  function handleResetTrim() {
    setTrimStart(0);
    setTrimEnd(duration);
    setCurrentTime(0);
    setTimelinePlayheadTime(0);

    void switchPreviewSource(
      videoId,
      0,
      sourceClipAtTime(videoId, 0)?.id,
      false,
    );
  }

  async function handleApplyTrim() {
    if (trimEnd - trimStart < 1) {
      setError("Der verbleibende Bereich muss mindestens 1 Sekunde lang sein.");
      return;
    }

    const confirmed = window.confirm(t("editor.trimConfirm"));

    if (!confirmed) return;

    setTrimming(true);
    setError(null);

    try {
      await apiFetch(`/api/videos/${videoId}/trim`, {
        method: "POST",
        body: JSON.stringify({
          startSeconds: trimStart,
          endSeconds: trimEnd,
        }),
      });

      onTrimStarted?.();
      closeEditor();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Trimmen fehlgeschlagen."
      );
      setTrimming(false);
    }
  }

  async function handleRenderTimeline(title: string) {
    if (!title.trim() || rendering) return;
    setShowRenderName(false);
    if (clips.length === 0 || timelineDuration < 1) {
      setError("Die Timeline muss mindestens eine Sekunde lang sein.");
      return;
    }

    setRendering(true);
    setRenderStatus("processing");
    setRenderedVideoId(null);
    setError(null);
    try {
      await apiFetch(`/api/videos/${videoId}/editor/render`, {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          version: 1,
          clips: clips.map(clipToStored),
          overlays: coverOverlays.map((overlay) => ({
            id: overlay.id,
            x: overlay.x,
            y: overlay.y,
            width: overlay.width,
            height: overlay.height,
            start: overlay.start,
            end: overlay.end,
            mode: overlay.mode ?? "cover",
            color: overlay.color,
            opacity: overlay.opacity,
            text: overlay.text,
          })),
          annotations,
          audioSegments,
          // Render requests also persist the timeline; retain this metadata.
          // Audio rendering does not consume it until ducking is implemented.
          duckOriginalAudio: duckOriginalAudio || undefined,
        }),
      });
    } catch (err) {
      setRendering(false);
      setRenderStatus("failed");
      setError(err instanceof Error ? err.message : "Rendern konnte nicht gestartet werden.");
    }
  }

  const timelineCurrentTime =
    timelinePlayheadTime;

  const playheadPct =
    timelineDuration > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (timelineCurrentTime / timelineDuration) * 100,
          ),
        )
      : 0;

  const trimStartPct =
    duration > 0 ? (trimStart / duration) * 100 : 0;

  const trimEndPct =
    duration > 0 ? (trimEnd / duration) * 100 : 100;

  const visibleCoverOverlays = coverOverlays
    .map((overlay, index) => ({ overlay, index }))
    .filter(
      ({ overlay }) =>
        timelinePlayheadTime >= overlay.start &&
        timelinePlayheadTime <= overlay.end,
    );
  const selectedVisibleCoverOverlay = visibleCoverOverlays.find(
    ({ overlay }) => overlay.id === selectedCoverOverlayId,
  )?.overlay;

  const hasDeletedTime =
    timelineDuration < duration - 0.001 ||
    clips.some((clip) => clip.sourceVideoId !== videoId);

  return (
    <div
      className="video-editor-studio-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeEditor();
      }}
      onClickCapture={blockDuringVoiceover}
      onPointerDownCapture={blockDuringVoiceover}
      onKeyDownCapture={blockDuringVoiceover}
      onChangeCapture={blockDuringVoiceover}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-editor-title"
        className="video-editor-studio-shell"
      >
        <header className="video-editor-studio-topbar">
          <h2
            id="video-editor-title"
            style={{
              margin: 0,
              fontSize: 20,
              color: "var(--color-text)",
            }}
          >
            {t("editor.title")}
          </h2>

          <button
            type="button"
            data-voiceover-control
            onClick={closeEditor}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              padding: "6px 12px",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            {t("editor.close")}
          </button>
        </header>

        <main className="video-editor-studio-body">

        {error && error !== INDEPENDENT_AUDIO_WARNING && (
          <div
            style={{
              color: "var(--color-error)",
              marginBottom: 16,
            }}
          >
            {t(editorErrorKeys[error] ?? error)}
          </div>
        )}

        {!clipSpeedBlocked && <>
        <audio ref={audioRef} preload="auto" hidden data-testid="video-editor-audio-preview" />
        {audioPreviewError && (
          <div role="alert">
            {t(editorErrorKeys[audioPreviewError] ?? audioPreviewError)}
            <button type="button" onClick={async () => {
              const preview = audioPreviewRef.current;
              if (preview instanceof EditorMultitrackAudioPreview) {
                try { await preview.refreshUrls(); }
                catch { setAudioPreviewError("Audioquelle konnte nicht geladen werden."); return; }
                if (audioPreviewRef.current !== preview) return;
              }
              setAudioPreviewError(null);
              previewPlayingRef.current = true;
              audioPreviewRef.current?.sync(true, true);
              void videoRef.current?.play().catch(() => {
                pausePreview();
                setAudioPreviewError("Wiedergabe konnte nicht gestartet werden.");
              });
            }}>{t("editor.playWithAudio")}</button>
          </div>
        )}
        <div className="video-editor-studio-workspace" data-testid="video-editor-studio-workspace">
        {videoUrl && (
          <div className="video-editor-studio-stage" data-testid="video-editor-studio-stage">
          <div
            ref={previewContainerRef}
            data-testid="video-editor-preview"
            className="video-editor-studio-preview"
            // Text and arrows use the full canonical canvas. Projects without
            // either retain their existing intrinsic-source preview layout.
            style={{ position: "relative", width: hasCanonicalAnnotations ? "min(100%, 83.5555555556dvh, 1350px)" : "100%", marginInline: "auto" }}
          >
            <video
              ref={videoRef}
              controls={!voiceoverBusy}
              muted
              onError={() => {
                voiceoverSessionRef.current?.transportFailed(new Error("Video-Vorschau fehlgeschlagen."));
              }}
              onVolumeChange={(e) => {
                if (!e.currentTarget.muted) e.currentTarget.muted = true;
                if (e.currentTarget.volume !== 0) e.currentTarget.volume = 0;
              }}
              onPlay={() => {
                applyActiveVideoSpeed();
                previewPlayingRef.current = true;
                if (!videoSwitchPendingRef.current) audioPreviewRef.current?.sync(true, true);
              }}
              onWaiting={() => {
                videoBufferingRef.current = true;
                audioPreviewRef.current?.stop();
              }}
              onPlaying={() => {
                const wasBuffering = videoBufferingRef.current;
                videoBufferingRef.current = false;
                if (wasBuffering && previewPlayingRef.current && !videoSwitchPendingRef.current) {
                  audioPreviewRef.current?.sync(true, true);
                }
              }}
              onPause={(e) => {
                if (internalPauseRef.current) { internalPauseRef.current = false; return; }
                if (voiceoverSessionRef.current?.state === "recording") {
                  voiceoverSessionRef.current.transportFailed(new Error("Video-Wiedergabe wurde während der Aufnahme unterbrochen."));
                  return;
                }
                if (!e.currentTarget.ended) pausePreview();
              }}
              onSeeking={() => {
                if (voiceoverSessionRef.current?.state === "recording" && !videoSwitchPendingRef.current && !sourceTransitionPendingRef.current) {
                  voiceoverSessionRef.current.transportFailed(new Error("Seek während der Voice-over-Aufnahme ist nicht erlaubt."));
                  return;
                }
                applyActiveVideoSpeed(); audioPreviewRef.current?.stop();
              }}
              onSeeked={() => {
                applyActiveVideoSpeed();
                if (!videoSwitchPendingRef.current) audioPreviewRef.current?.sync(previewPlayingRef.current, true);
              }}
              onLoadedMetadata={(e) => {
                applyActiveVideoSpeed();
                e.currentTarget.muted = true;
                e.currentTarget.defaultMuted = true;
                e.currentTarget.volume = 0;
                updateVisibleVideoFrame();
              }}
              onTimeUpdate={(e) => {
                const sourceTime = e.currentTarget.currentTime;
                const activeClip = clips.find(
                  (clip) => clip.id === activeClipIdRef.current,
                );

                if (!activeClip) return;
                if (activeClip.sourceVideoId !== activeSourceVideoIdRef.current) return;

                const clipTimelineStart = timelineStartForClip(activeClip.id);
                if (clipTimelineStart === null) return;

                setCurrentTime(sourceTime);
                if (!videoSwitchPendingRef.current && !videoBufferingRef.current && !e.currentTarget.seeking) {
                  audioPreviewRef.current?.sync(previewPlayingRef.current);
                }
                setTimelinePlayheadTime(
                  clipSourceToTimelineTime(activeClip, clipTimelineStart, sourceTime),
                );

                if (
                  !e.currentTarget.paused &&
                  sourceTime >= activeClip.end
                ) {
                  advancePreviewToNextClip();
                }
              }}
              onEnded={advancePreviewToNextClip}
              style={{
                width: "100%",
                ...(hasCanonicalAnnotations ? { aspectRatio: "16 / 9" } : {}),
                maxHeight: "min(47dvh, 760px)",
                display: "block",
                objectFit: "contain",
                background: "#000",
                borderRadius: 8,
              }}
            />

            {[false, true].map(isArrowFrame => {
              // Symbols also share the canonical output canvas. Covers retain
              // their existing source-relative coordinate system.
              const frameRect = isArrowFrame ? textFrameRect : videoFrameRect;
              return <div key={String(isArrowFrame)}
              data-testid={isArrowFrame ? "video-editor-arrow-frame" : "video-editor-overlay-frame"}
              ref={isArrowFrame ? arrowFrameRef : annotationFrameRef}
              style={{
                position: "absolute",
                left: frameRect.left,
                top: frameRect.top,
                width: frameRect.width,
                height: frameRect.height,
                overflow: "hidden",
                borderRadius: 8,
                pointerEvents: "none",
              }}
            >
              {annotations.filter((item) => item.type !== "text").filter(item => (item.type === "arrow" || item.type === "line" || item.type === "circle" || item.type === "symbol") === isArrowFrame).filter((item) => timelineCurrentTime >= item.start && timelineCurrentTime <= item.end).map((item) => (
                <div key={item.id} data-testid={`video-editor-${item.type}-${item.id}`}
                  onPointerDown={(e) => handleAnnotationPointerDown(e, item)}
                  onClick={(e) => { e.stopPropagation(); selectAnnotation(item.id); }}
                  style={{ position: "absolute", left: `${item.x}%`, top: `${item.y}%`, width: `${item.width}%`, height: `${item.height}%`,
                    pointerEvents: item.type === "line" ? "none" : "auto", touchAction: "none", cursor: "move", boxSizing: "border-box",
                    zIndex: selectedAnnotationId === item.id ? 4 : 3,
                    border: item.type === "line" || item.type === "circle" || item.type === "symbol" ? "none" : selectedAnnotationId === item.id ? "1px solid #FC2667" : "1px solid transparent",
                    ...(item.type === "circle" || item.type === "symbol" ? { outline: selectedAnnotationId === item.id ? "1px solid #FC2667" : "none", outlineOffset: -1 } : {}) }}>
                  <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: "block", pointerEvents: "none" }}>
                    {/* Every vertex is within radius 44 of (50,50), so at any
                        angle the actual polygon stays inside this viewport. */}
                    {item.type === "line"
                      ? <g transform={`rotate(${item.rotation} 50 50)`}>
                          <line x1="8" y1="50" x2="92" y2="50" fill="none" stroke={item.color ?? "#FC2667"} strokeWidth={linePreviewStrokeWidth(item.strokeWidth, textFrameRect.width)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                          <line data-testid={`video-editor-line-hit-${item.id}`} x1="8" y1="50" x2="92" y2="50" stroke="transparent" strokeWidth="12" vectorEffect="non-scaling-stroke" style={{ pointerEvents: "stroke" }} />
                        </g>
                      : item.type === "symbol" && item.symbol
                      ? <g transform={`rotate(${item.rotation} 50 50)`} style={{ color: item.color ?? "#FC2667" }}>
                          {/* Entire stroked 16x16 icon remains inside radius 50,
                              including at arbitrary rotations before scaling. */}
                          <g transform="translate(18 18) scale(4)"><SymbolShape symbol={item.symbol} /></g>
                        </g>
                      : item.type === "circle"
                      ? <ellipse cx="50" cy="50" rx="47" ry="47" fill="none" stroke={item.color ?? "#FC2667"} strokeWidth={circlePreviewStrokeWidth(item.strokeWidth, textFrameRect.width)} vectorEffect="non-scaling-stroke" />
                      : <polygon fill={item.color ?? "#FC2667"} points={arrowPolygonPoints(item.shaftWidth)} transform={`rotate(${item.rotation} 50 50)`} />}
                  </svg>
                  {selectedAnnotationId === item.id && item.type !== "circle" && <>
                    <span aria-hidden="true" style={{ position: "absolute",
                      ...(item.type === "line" ? {
                        left: "50%", top: "50%", height: 8,
                        transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`, transformOrigin: "bottom center",
                      } : { right: 5, top: Math.max(-14, -frameRect.height * item.y / 100), height: 18 }),
                      width: 1, background: "#FC2667", pointerEvents: "none" }} />
                    <button type="button" aria-label={t("editor.rotateItem", { item: annotationName(item) })} title={t("editor.rotateItem", { item: annotationName(item) })}
                      data-testid={`video-editor-${item.type}-rotate-${item.id}`}
                      onPointerDown={(e) => handleAnnotationRotation(e, item)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ position: "absolute",
                        ...(item.type === "line" ? {
                          left: `calc(50% + ${14 * Math.sin(item.rotation * Math.PI / 180)}px - 6px)`,
                          top: `calc(50% - ${14 * Math.cos(item.rotation * Math.PI / 180)}px - 6px)`,
                        } : { right: 0, top: Math.max(-18, -frameRect.height * item.y / 100) }),
                        width: 12, height: 12, minWidth: 0, padding: 0, borderRadius: "50%", border: "2px solid #FC2667",
                        background: "#FFFFFF", cursor: "grab", touchAction: "none", pointerEvents: "auto" }} />
                  </>}
                  {selectedAnnotationId === item.id && <div data-testid={`video-editor-${item.type}-resize-${item.id}`}
                    onPointerDown={(e) => handleAnnotationPointerDown(e, item, true)}
                    style={{ position: "absolute",
                      ...(item.type === "line" ? {
                        left: `calc(${50 + 42 * Math.cos(item.rotation * Math.PI / 180)}% - 6px)`,
                        top: `calc(${50 + 42 * Math.sin(item.rotation * Math.PI / 180)}% - 6px)`,
                      } : { right: 0, bottom: 0 }),
                      width: 12, height: 12, background: "#FC2667", cursor: item.type === "line" ? "grab" : "nwse-resize", touchAction: "none", pointerEvents: "auto" }} />}
                </div>
              ))}
              {!isArrowFrame && <>{visibleCoverOverlays.map(({ overlay }) => (
                <div
                  key={overlay.id}
                  data-testid={`video-editor-cover-overlay-${overlay.id}`}
                  onPointerDown={(e) =>
                    handleCoverOverlayPointerDown(e, overlay.id)
                  }
                  style={{
                    position: "absolute",
                    left: `${overlay.x}%`,
                    top: `${overlay.y}%`,
                    width: `${overlay.width}%`,
                    height: `${overlay.height}%`,
                    background: (overlay.mode ?? "cover") === "blur"
                      ? "rgba(255, 255, 255, 0.01)"
                      : (overlay.color ?? "#000000"),
                    opacity: (overlay.mode ?? "cover") === "cover"
                      ? (overlay.opacity ?? 1)
                      : undefined,
                    backdropFilter: (overlay.mode ?? "cover") === "blur" ? "blur(12px)" : undefined,
                    WebkitBackdropFilter: (overlay.mode ?? "cover") === "blur" ? "blur(12px)" : undefined,
                    zIndex: 2,
                    pointerEvents: "auto",
                    cursor: "move",
                    touchAction: "none",
                  }}
                >
                </div>
              ))}
              {visibleCoverOverlays.filter(({ overlay }) =>
                (overlay.mode ?? "cover") === "cover" && overlay.text,
              ).map(({ overlay }) => {
                // Reserve the full badge group when badges at this origin are staggered.
                const badgeCount = visibleCoverOverlays.filter(({ overlay: other }) =>
                  other.x === overlay.x && other.y === overlay.y,
                ).length;
                const leftInset = 22 + (overlay.x <= 50 ? (badgeCount - 1) * 20 : 0);
                const rightInset = 12;
                const availableWidth = videoFrameRect.width * overlay.width / 100 - leftInset - rightInset;
                const availableHeight = videoFrameRect.height * overlay.height / 100 - 8;
                return (
                <div
                  key={`text-${overlay.id}`}
                  data-testid={`video-editor-cover-text-${overlay.id}`}
                  style={{
                    position: "absolute", left: `${overlay.x}%`, top: `${overlay.y}%`,
                    width: `${overlay.width}%`, height: `${overlay.height}%`,
                    zIndex: 3, pointerEvents: "none", overflow: "hidden",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    boxSizing: "border-box", color: "#fff",
                    fontSize: 16, opacity: 1,
                  }}
                >
                  <div
                    data-testid={`video-editor-text-content-${overlay.id}`}
                    style={{
                      position: "absolute", left: leftInset, right: rightInset, top: 4, bottom: 4,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      overflow: "hidden", visibility: availableWidth >= 16 && availableHeight >= 20 ? "visible" : "hidden",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {overlay.text}
                    </span>
                  </div>
                </div>
                );
              })}
              {selectedVisibleCoverOverlay && (
                <div
                  data-testid={`video-editor-cover-interaction-${selectedVisibleCoverOverlay.id}`}
                  onPointerDown={(e) =>
                    handleCoverOverlayPointerDown(e, selectedVisibleCoverOverlay.id)
                  }
                  style={{
                    position: "absolute",
                    left: `${selectedVisibleCoverOverlay.x}%`,
                    top: `${selectedVisibleCoverOverlay.y}%`,
                    width: `${selectedVisibleCoverOverlay.width}%`,
                    height: `${selectedVisibleCoverOverlay.height}%`,
                    zIndex: 4,
                    border: "1px solid #FC2667",
                    boxSizing: "border-box",
                    pointerEvents: "auto",
                    cursor: "move",
                    touchAction: "none",
                  }}
                >
                  <div
                    data-testid={`video-editor-cover-resize-${selectedVisibleCoverOverlay.id}`}
                    onPointerDown={(e) =>
                      handleCoverOverlayResizePointerDown(e, selectedVisibleCoverOverlay.id)
                    }
                    style={{
                      position: "absolute",
                      right: -7,
                      bottom: -7,
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: "#FC2667",
                      border: "2px solid #FFFFFF",
                      boxSizing: "border-box",
                      cursor: "nwse-resize",
                      touchAction: "none",
                    }}
                  />
                </div>
              )}
              <div
                data-testid="video-editor-cover-badge-layer"
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 5,
                  pointerEvents: "none",
                }}
              >
                {visibleCoverOverlays.map(({ overlay, index }, badgeIndex) => {
                  const collisionIndex = visibleCoverOverlays
                    .slice(0, badgeIndex)
                    .filter(
                      ({ overlay: previous }) =>
                        previous.x === overlay.x && previous.y === overlay.y,
                    ).length;
                  const horizontalOffset = collisionIndex * 20 * (overlay.x > 50 ? -1 : 1);
                  const translateX = overlay.x > 80 ? "-100%" : "0";
                  const translateY = overlay.y > 80 ? "-100%" : "0";

                  return (
                    <span
                      key={overlay.id}
                      data-testid={`video-editor-cover-badge-${overlay.id}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCoverOverlayId(overlay.id);
                      }}
                      style={{
                        position: "absolute",
                        top: `${overlay.y}%`,
                        left: `${overlay.x}%`,
                        transform: `translate(${translateX}, ${translateY}) translateX(${horizontalOffset}px)`,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        boxSizing: "border-box",
                        overflow: "hidden",
                        borderRadius: 5,
                        background: "#FC2667",
                        color: "#FFFFFF",
                        fontSize: 10,
                        fontWeight: 700,
                        lineHeight: 1,
                        pointerEvents: "auto",
                        cursor: "pointer",
                      }}
                    >
                      {index + 1}
                    </span>
                  );
                })}
              </div>
            </>}
            </div>;
            })}
            {hasTextAnnotations && <div ref={textFrameRef} data-testid="video-editor-text-frame"
              style={{ position: "absolute", ...{ left: textFrameRect.left, top: textFrameRect.top, width: textFrameRect.width, height: textFrameRect.height },
                pointerEvents: "none", overflow: "hidden", zIndex: 6 }}>
              {textFrameRect.height > 0 && annotations.filter(item => item.type === "text").filter(item => timelineCurrentTime >= item.start && timelineCurrentTime <= item.end).map(item => {
                const box = textBoxToPixels(item, { ...textFrameRect, left: 0, top: 0 });
                return <div key={item.id} data-testid={`video-editor-text-${item.id}`}
                  onPointerDown={event => handleAnnotationPointerDown(event, item)}
                  onClick={event => { event.stopPropagation(); selectAnnotation(item.id); }}
                  style={{ position: "absolute", ...box, pointerEvents: "auto", touchAction: "none", cursor: "move",
                    outline: selectedAnnotationId === item.id ? "1px solid #FC2667" : "none", outlineOffset: -1 }}>
                  <span data-testid={`video-editor-annotation-text-content-${item.id}`}
                    style={{ position: "absolute", inset: 0, overflow: "hidden", whiteSpace: "pre", pointerEvents: "none",
                      ...textTypography(item).style,
                      color: item.color || TEXT_LAYOUT.color, fontSize: scaledTextFontSize(item.fontSize, textFrameRect.height), lineHeight: 1.2, textAlign: "left" }}>
                    {textAnnotationDraft?.id === item.id ? textAnnotationDraft.text : item.text}
                  </span>
                  {selectedAnnotationId === item.id && <div data-testid={`video-editor-text-resize-${item.id}`}
                    onPointerDown={event => handleAnnotationPointerDown(event, item, true)}
                    style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12, background: "#FC2667", cursor: "nwse-resize", touchAction: "none" }} />}
                </div>;
              })}
            </div>}
          </div>
          </div>
        )}

        {error === INDEPENDENT_AUDIO_WARNING && (
          <div role="alert" data-testid="video-editor-audio-guard-warning"
            style={{ marginBottom: 8, padding: "8px 10px", borderRadius: 6,
              border: "1px solid #F7C2D2", borderLeft: "3px solid #E6467A",
              background: "#FFF7FA", color: "#0F172A",
              fontSize: 13, lineHeight: 1.4 }}>
            {t("editor.independentAudioWarning")}
          </div>
        )}

        <div
          className="video-editor-studio-toolbar"
        >
          <div className="video-editor-toolbar-group" role="group" aria-label={t("editor.clipTools")} data-testid="video-editor-toolbar-clip">
          <span className="video-editor-tool">
            <button
              type="button"
              className="video-editor-tool-button"
              aria-label={t("editor.trim")}
              aria-describedby="video-editor-tooltip-trim"
              style={{ cursor: "default" }}
            >
              <EditorToolIcon name="trim" />
            </button>
            <span id="video-editor-tooltip-trim" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.trim")}
            </span>
          </span>

          <span className="video-editor-tool">
            <button type="button" onClick={handleSplit} className="video-editor-tool-button"
              aria-label={t("editor.split")} aria-describedby="video-editor-tooltip-split">
              <EditorToolIcon name="split" />
            </button>
            <span id="video-editor-tooltip-split" role="tooltip" className="video-editor-tool-tooltip">{t("editor.split")}</span>
          </span>

          {selectedClipId && (
            <label className="video-editor-toolbar-speed">
              {t("editor.speed")}
              <select aria-label={t("editor.speed")} value={readClipSpeed(clips.find(clip => clip.id === selectedClipId)?.speed)}
                disabled={audioGestureActive || audioVolumeDraft !== null}
                onChange={event => handleClipSpeed(Number(event.target.value))}
                style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: "6px 8px", background: "var(--color-surface)", color: "var(--color-text)" }}>
                {EDITOR_CLIP_SPEEDS.map(speed => <option key={speed} value={speed}>{speed.toLocaleString(language)}×</option>)}
              </select>
            </label>
          )}

          {selectedClipId && (
            <button type="button" onClick={handleDeleteSelectedClip} disabled={clips.length <= 1}
              className="video-editor-toolbar-delete">
              {t("editor.deleteClip")}
            </button>
          )}

          <span className="video-editor-tool">
            <button type="button" onClick={handleOpenInsertPicker} className="video-editor-tool-button"
              aria-label={t("editor.insertVideo")} aria-describedby="video-editor-tooltip-insert">
              <EditorToolIcon name="insert" />
            </button>
            <span id="video-editor-tooltip-insert" role="tooltip" className="video-editor-tool-tooltip">{t("editor.insertVideo")}</span>
          </span>
          </div>

          <div className="video-editor-toolbar-group" role="group" aria-label={t("editor.insertTools")} data-testid="video-editor-toolbar-insert">
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleAddCoverOverlay}
              className="video-editor-tool-button"
              aria-label={t("editor.addCoverShort")}
              aria-describedby="video-editor-tooltip-cover"
            >
              <EditorToolIcon name="cover" />
            </button>
            <span id="video-editor-tooltip-cover" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.addCover")}
            </span>
          </span>

          <span className="video-editor-tool">
            <button type="button" className="video-editor-tool-button" aria-label={t("editor.addArrow")}
              aria-describedby="video-editor-tooltip-arrow" onClick={() => addAnnotation()}>
              <EditorToolIcon name="arrow" />
            </button>
            <span id="video-editor-tooltip-arrow" role="tooltip" className="video-editor-tool-tooltip">{t("editor.addArrow")}</span>
          </span>
          <span className="video-editor-tool">
            <button type="button" className="video-editor-tool-button" aria-label={t("editor.addCircle")}
              aria-describedby="video-editor-tooltip-circle" onClick={() => addAnnotation(undefined, "circle")}>
              <EditorToolIcon name="circle" />
            </button>
            <span id="video-editor-tooltip-circle" role="tooltip" className="video-editor-tool-tooltip">{t("editor.addCircle")}</span>
          </span>
          <span className="video-editor-tool" onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShowSymbolPicker(false);
          }} onKeyDown={(e) => {
            if (e.key === "Escape" && showSymbolPicker) {
              e.stopPropagation(); setShowSymbolPicker(false); symbolPickerButtonRef.current?.focus();
            }
          }}>
            <button ref={symbolPickerButtonRef} type="button" className="video-editor-tool-button" aria-label={t("editor.addSymbol")}
              aria-describedby={showSymbolPicker ? undefined : "video-editor-tooltip-symbol"} aria-haspopup="dialog" aria-expanded={showSymbolPicker}
              onClick={() => setShowSymbolPicker((previous) => !previous)}><EditorToolIcon name="symbol" /></button>
            {!showSymbolPicker && <span id="video-editor-tooltip-symbol" role="tooltip" className="video-editor-tool-tooltip">{t("editor.addSymbol")}</span>}
            {showSymbolPicker && <div role="dialog" aria-label={t("editor.chooseSymbol")}
              style={{ position: "absolute", left: 0, top: "100%", zIndex: 50, display: "grid", gridTemplateColumns: "repeat(4, 32px)", gap: 4, padding: 8, background: "white", border: "1px solid var(--color-border)", borderRadius: 8 }}>
              {annotationSymbols.map((symbol, index) => <button key={symbol} autoFocus={index === 0} type="button"
                className="video-editor-tool-button" aria-label={t(symbolLabelKeys[symbol])} title={t(symbolLabelKeys[symbol])}
                onClick={() => { addAnnotation(undefined, "symbol", symbol); setShowSymbolPicker(false); symbolPickerButtonRef.current?.focus(); }}>
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 16 16"><SymbolShape symbol={symbol} /></svg>
              </button>)}
            </div>}
          </span>

          <span className="video-editor-tool">
            <button type="button" className="video-editor-tool-button" aria-label={t("editor.addLine")}
              aria-describedby="video-editor-tooltip-line" onClick={() => addAnnotation(undefined, "line")}>
              <EditorToolIcon name="line" />
            </button>
            <span id="video-editor-tooltip-line" role="tooltip" className="video-editor-tool-tooltip">{t("editor.addLine")}</span>
          </span>

          <button type="button" className="video-editor-tool-button" aria-label={t("editor.addText")} title={t("editor.addText")}
            onClick={() => addAnnotation(undefined, "text")}>{t("editor.text")}</button>
          </div>

          <div className="video-editor-toolbar-group video-editor-toolbar-group--audio" role="group" aria-label={t("editor.audioTools")} data-testid="video-editor-toolbar-audio">
          {!voiceoverBusy ? (
            <button type="button" data-voiceover-control className="video-editor-voiceover-button"
              aria-label={t("editor.recordVoiceover")} title={t("editor.recordVoiceover")}
              disabled={clipSpeedBlocked || !!audioPreviewError || timelinePlayheadTime >= timelineDuration}
              onClick={() => void startVoiceover()}>
              <EditorToolIcon name="microphone" /> {t("editor.recordVoiceover")}
            </button>
          ) : (
            <button type="button" data-voiceover-control className="video-editor-voiceover-button video-editor-voiceover-button--recording"
              aria-label={t("editor.stopRecording")} title={t("editor.stopRecording")}
              disabled={voiceoverState !== "recording"} onClick={() => void stopVoiceover()}>
              <EditorToolIcon name="stop" /> {t("editor.stopRecording")}
            </button>
          )}

          <label className="video-editor-toolbar-ducking">
            <input type="checkbox" checked={duckOriginalAudio}
              disabled={voiceoverBusy || audioGestureActive || audioVolumeDraft !== null}
              onChange={event => {
                const enabled = event.target.checked;
                if (enabled === duckOriginalAudio) return;
                rememberEditorState();
                setDuckOriginalAudio(enabled);
              }} />
            {t("editor.duckOriginal")}
          </label>
          </div>

          <div className="video-editor-toolbar-group" role="group" aria-label={t("editor.history")} data-testid="video-editor-toolbar-history">
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleUndo}
              disabled={editorHistory.length === 0}
              className="video-editor-tool-button"
              aria-label={t("editor.undoIcon")}
              aria-describedby="video-editor-tooltip-undo"
            >
              <EditorToolIcon name="undo" />
            </button>
            <span id="video-editor-tooltip-undo" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.undo")}
            </span>
          </span>
          </div>

        </div>
        <p className="video-editor-toolbar-hint" data-testid="video-editor-toolbar-hint">
          {t("editor.splitHint")}
        </p>

        <div className={`video-editor-cover-actions${selectedAnnotation || selectedCoverOverlay || copiedAnnotation || copiedCoverOverlay ? "" : " video-editor-cover-actions--empty"}`}
          data-testid="video-editor-cover-actions"
          data-empty={selectedAnnotation || selectedCoverOverlay || copiedAnnotation || copiedCoverOverlay ? "false" : "true"}>
        {selectedAnnotation && <>
          <span>{annotationName(selectedAnnotation)}:</span>
          {selectedAnnotation.type === "text" && <>
            <label>{t("editor.font")} <select aria-label={t("editor.textFont")} value={textTypography(selectedAnnotation).fontFamily}
              onChange={event => updateTextTypography({ fontFamily: event.target.value })}>
              {TEXT_FONTS.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
            </select></label>
            <button type="button" className="video-editor-tool-button" aria-label={t("editor.textBold")} title={t("editor.textBold")}
              aria-pressed={selectedAnnotation.bold ?? false} onClick={() => updateTextTypography({ bold: !selectedAnnotation.bold })}><b>B</b></button>
            <button type="button" className="video-editor-tool-button" aria-label={t("editor.textItalic")} title={t("editor.textItalic")}
              aria-pressed={selectedAnnotation.italic ?? false} onClick={() => updateTextTypography({ italic: !selectedAnnotation.italic })}><i>I</i></button>
            <label>{t("editor.text")} <textarea aria-label={t("editor.textContent")} rows={2} style={{ resize: "none" }}
              value={textAnnotationDraft?.id === selectedAnnotation.id ? textAnnotationDraft.text : selectedAnnotation.text}
              onFocus={() => { textAnnotationEditRef.current = null; }}
              onBlur={() => { textAnnotationEditRef.current = null; setTextAnnotationDraft(null); }}
              onChange={event => updateTextProperty("text", event.target.value)} /></label>
            <label>{t("editor.size")} <input aria-label={t("editor.textSize")} type="number" min={TEXT_LAYOUT.minFontSize} max={TEXT_LAYOUT.maxFontSize}
              value={selectedAnnotation.fontSize}
              onFocus={() => { textAnnotationEditRef.current = null; }} onBlur={() => { textAnnotationEditRef.current = null; }}
              onChange={event => updateTextProperty("fontSize", Number(event.target.value))} style={{ width: 70 }} /></label>
          </>}
          {selectedAnnotation.type === "arrow" && <label>{t("editor.stroke")} <select aria-label={t("editor.arrowStroke")} value={arrowShaftWidth(selectedAnnotation.shaftWidth)}
            onChange={e => updateAnnotation({ shaftWidth: Number(e.target.value) })}>
            {ARROW_SHAFT_WIDTHS.map(value => <option key={value} value={value}>{value === 12 ? t("editor.defaultValue", { value }) : value}</option>)}
          </select></label>}
          {selectedAnnotation.type === "circle" && <label>{t("editor.stroke")} <select aria-label={t("editor.circleStroke")} value={circleStrokeWidth(selectedAnnotation.strokeWidth)}
            onChange={e => updateAnnotation({ strokeWidth: Number(e.target.value) })}>
            {CIRCLE_STROKE_WIDTHS.map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>}
          {selectedAnnotation.type === "line" && <label>{t("editor.stroke")} <select aria-label={t("editor.lineStroke")} value={lineStrokeWidth(selectedAnnotation.strokeWidth)}
            onChange={e => updateAnnotation({ strokeWidth: Number(e.target.value) })}>
            {LINE_STROKE_WIDTHS.map(value => <option key={value} value={value}>{value === 3 ? t("editor.defaultValue", { value }) : value}</option>)}
          </select></label>}
          <label>{t("editor.color")} <input type="color" aria-label={selectedAnnotation.type === "line" ? t("editor.lineColor") : t("editor.itemColor", { item: annotationName(selectedAnnotation) })} value={selectedAnnotation.type === "text" ? selectedAnnotation.color || TEXT_LAYOUT.color : selectedAnnotation.color ?? "#FC2667"}
            onChange={(e) => updateAnnotation({ color: e.target.value })}
            style={{ width: 32, height: 28, padding: 2, cursor: "pointer" }} /></label>
          {selectedAnnotation.type !== "circle" && selectedAnnotation.type !== "text" && <>
          <label>{t("editor.direction")} <select aria-label={selectedAnnotation.type === "line" ? t("editor.lineDirection") : t("editor.itemDirection", { item: annotationName(selectedAnnotation) })} value={selectedAnnotation.rotation}
            onChange={(e) => updateAnnotation({ rotation: Number(e.target.value) })}>
            {selectedAnnotation.rotation % 45 !== 0 && <option value={selectedAnnotation.rotation}>{selectedAnnotation.rotation}°</option>}
            {["editor.right", "editor.downRight", "editor.down", "editor.downLeft", "editor.left", "editor.upLeft", "editor.up", "editor.upRight"].map((key, index) =>
              <option key={key} value={index * 45}>{t(key)}</option>)}
          </select></label>
          </>}
          <label>{t("editor.start")} <input aria-label={t("editor.itemStart", { item: annotationName(selectedAnnotation) })} type="number" min={0} max={selectedAnnotation.end - 0.1} step={0.1}
            value={selectedAnnotation.start} onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) updateAnnotation({ start: Math.max(0, Math.min(value, selectedAnnotation.end - 0.1)) });
            }} style={{ width: 70 }} /></label>
          <label>{t("editor.end")} <input aria-label={t("editor.itemEnd", { item: annotationName(selectedAnnotation) })} type="number" min={selectedAnnotation.start + 0.1} max={timelineDuration} step={0.1}
            value={selectedAnnotation.end} onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) updateAnnotation({ end: Math.min(timelineDuration, Math.max(value, selectedAnnotation.start + 0.1)) });
            }} style={{ width: 70 }} /></label>
          <button type="button" className="video-editor-tool-button" aria-label={t("editor.copyItem", { item: annotationName(selectedAnnotation) })} title={t("editor.copyItem", { item: annotationName(selectedAnnotation) })}
            onClick={() => setCopiedAnnotation({ ...selectedAnnotation })}><EditorToolIcon name="copy" /></button>
          <button type="button" className="video-editor-tool-button" aria-label={t("editor.deleteItem", { item: annotationName(selectedAnnotation) })} title={t("editor.deleteItem", { item: annotationName(selectedAnnotation) })} onClick={() => {
            rememberEditorState();
            setAnnotations((previous) => previous.filter((item) => item.id !== selectedAnnotation.id));
            setSelectedAnnotationId(null);
          }}><EditorToolIcon name="delete" /></button>
        </>}
        {copiedAnnotation && <button type="button" className="video-editor-tool-button" aria-label={t("editor.pasteItem", { item: annotationName(copiedAnnotation) })} title={t("editor.pasteItem", { item: annotationName(copiedAnnotation) })}
          onClick={() => addAnnotation(copiedAnnotation)}><EditorToolIcon name="paste" /></button>}
        {selectedCoverOverlay && (
          <>
          <strong className="video-editor-cover-actions-label">{t("editor.cover")}:</strong>

          <label className="video-editor-cover-time-label">
            {t("editor.type")}{" "}
            <select
              aria-label={t("editor.coverType")}
              value={selectedCoverOverlay.mode ?? "cover"}
              onChange={(e) => handleCoverOverlayModeChange(e.target.value as "cover" | "blur")}
              className="video-editor-cover-time-input"
            >
              <option value="cover">{t("editor.coverMode")}</option>
              <option value="blur">{t("editor.blurMode")}</option>
            </select>
          </label>

          {(selectedCoverOverlay.mode ?? "cover") === "cover" && (
            <>
              <label className="video-editor-cover-time-label">
                {t("editor.color")}{" "}
                <input
                  type="color"
                  aria-label={t("editor.coverColor")}
                  value={selectedCoverOverlay.color ?? "#000000"}
                  onChange={(e) => handleCoverOverlayColorChange(e.target.value)}
                  style={{ width: 32, height: 28, padding: 2 }}
                />
              </label>
              <label className="video-editor-cover-time-label">
                {t("editor.opacity")}{" "}
                <input
                  type="range"
                  aria-label={t("editor.coverOpacity")}
                  min={10}
                  max={100}
                  step={1}
                  value={Math.round((selectedCoverOverlay.opacity ?? 1) * 100)}
                  onPointerDown={rememberEditorState}
                  onKeyDown={(e) => {
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
                      rememberEditorState();
                    }
                  }}
                  onChange={(e) => handleCoverOverlayOpacityChange(Number(e.target.value) / 100)}
                  className="video-editor-opacity-slider"
                  style={{ width: 88 }}
                />
                <span
                  className="video-editor-opacity-value"
                  data-testid="video-editor-cover-opacity-value"
                >
                  {Math.round((selectedCoverOverlay.opacity ?? 1) * 100)} %
                </span>
              </label>
              <label className="video-editor-cover-time-label">
                {t("editor.text")}{" "}
                <input
                  type="text"
                  aria-label={t("editor.coverText")}
                  maxLength={120}
                  value={selectedCoverOverlay.text ?? ""}
                  onFocus={() => { textEditOverlayRef.current = null; }}
                  onBlur={() => { textEditOverlayRef.current = null; }}
                  onChange={(e) => handleCoverOverlayTextChange(e.target.value)}
                  className="video-editor-cover-time-input"
                  style={{ width: 160 }}
                />
              </label>
            </>
          )}

          <label className="video-editor-cover-time-label">
            {t("editor.start")}{" "}
            <input
              type="number"
              min={0}
              max={Math.max(0, selectedCoverOverlay.end - 0.1)}
              step={0.1}
              value={selectedCoverOverlay.start}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;

                const start = Math.max(
                  0,
                  Math.min(value, selectedCoverOverlay.end - 0.1),
                );

                setCoverOverlays((previous) =>
                  previous.map((overlay) =>
                    overlay.id === selectedCoverOverlay.id
                      ? { ...overlay, start }
                      : overlay,
                  ),
                );
              }}
              className="video-editor-cover-time-input"
            />
            {" s"}
          </label>

          <label className="video-editor-cover-time-label">
            {t("editor.end")}{" "}
            <input
              type="number"
              min={selectedCoverOverlay.start + 0.1}
              max={timelineDuration}
              step={0.1}
              value={selectedCoverOverlay.end}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;

                const end = Math.min(
                  timelineDuration,
                  Math.max(value, selectedCoverOverlay.start + 0.1),
                );

                setCoverOverlays((previous) =>
                  previous.map((overlay) =>
                    overlay.id === selectedCoverOverlay.id
                      ? { ...overlay, end }
                      : overlay,
                  ),
                );
              }}
              className="video-editor-cover-time-input"
            />
            {" s"}
          </label>

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleCopyCoverOverlay}
              className="video-editor-tool-button"
              aria-label={t("editor.coverCopy")}
              aria-describedby="video-editor-tooltip-copy-cover"
            >
              <EditorToolIcon name="copy" />
            </button>
            <span id="video-editor-tooltip-copy-cover" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.coverCopy")}
            </span>
          </span>

          </>
        )}

        {copiedCoverOverlay && (
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handlePasteCoverOverlay}
              className="video-editor-tool-button"
              aria-label={t("editor.coverPaste")}
              aria-describedby="video-editor-tooltip-paste-cover"
            >
              <EditorToolIcon name="paste" />
            </button>
            <span id="video-editor-tooltip-paste-cover" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.coverPaste")}
            </span>
          </span>
        )}

        {selectedCoverOverlay && (
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleDeleteSelectedCoverOverlay}
              className="video-editor-tool-button video-editor-tool-button--destructive"
              aria-label={t("editor.coverDelete")}
              aria-describedby="video-editor-tooltip-delete-cover"
            >
              <EditorToolIcon name="delete" />
            </button>
            <span id="video-editor-tooltip-delete-cover" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.coverDelete")}
            </span>
          </span>
        )}
        </div>

        </div>
        {showInsertPicker && (
          <div
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              padding: 14,
              marginBottom: 18,
              background: "var(--color-surface)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <strong style={{ color: "var(--color-text)" }}>
                {t("editor.libraryChoose")}
              </strong>

              <button
                type="button"
                onClick={() => setShowInsertPicker(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  cursor: "grab",
                  touchAction: "none",
                  fontSize: 18,
                }}
              >
                ×
              </button>
            </div>

            {loadingLibrary ? (
              <div style={{ color: "var(--color-text-secondary)" }}>
                {t("editor.libraryLoading")}
              </div>
            ) : libraryVideos.length === 0 ? (
              <div style={{ color: "var(--color-text-secondary)" }}>
                {t("editor.libraryEmpty")}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 10,
                }}
              >
                {libraryVideos.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    onClick={() => {
                      setSelectedInsertVideo(video);
                      setShowInsertPicker(false);
                    }}
                    style={{
                      textAlign: "left",
                      border:
                        selectedInsertVideo?.id === video.id
                          ? "2px solid #E6467A"
                          : "1px solid var(--color-border)",
                      borderRadius: 8,
                      padding: 10,
                      background: "#FFFFFF",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        color: "#0F172A",
                        marginBottom: 4,
                      }}
                    >
                      {video.title || t("editor.untitledVideo")}
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {formatDuration(video.duration)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {selectedInsertVideo && (
          <div
            style={{
              marginBottom: 14,
              padding: "8px 12px",
              borderRadius: 8,
              background: "#F8FAFC",
              color: "#0F172A",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span>
              {t("editor.selectedForInsert")}{" "}
              <strong>
                {selectedInsertVideo.title || t("editor.untitledVideo")}
              </strong>{" "}
              ({formatDuration(selectedInsertVideo.duration)})
            </span>

            <button
              type="button"
              onClick={handleInsertSelectedVideo}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                background: "#0F172A",
                color: "#FFFFFF",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t("editor.insertHere")}
            </button>
          </div>
        )}

        <section className="video-editor-studio-timeline" data-testid="video-editor-studio-timeline">
        <div className="video-editor-timeline-controls">
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={() => setTimelineZoom(1)}
              className="video-editor-tool-button"
              aria-label={t("editor.fit")}
              aria-describedby="video-editor-tooltip-fit"
            >
              <EditorToolIcon name="fit" />
            </button>
            <span
              id="video-editor-tooltip-fit"
              role="tooltip"
              className="video-editor-tool-tooltip video-editor-tool-tooltip--left-edge"
            >
              {t("editor.fit")}
            </span>
          </span>

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={() => {
                const index = TIMELINE_ZOOM_LEVELS.indexOf(
                  timelineZoom as (typeof TIMELINE_ZOOM_LEVELS)[number],
                );
                setTimelineZoom(TIMELINE_ZOOM_LEVELS[Math.max(0, index - 1)]);
              }}
              disabled={timelineZoom <= 1}
              className="video-editor-tool-button"
              aria-label={t("editor.zoomOut")}
              aria-describedby="video-editor-tooltip-zoom-out"
            >
              <EditorToolIcon name="minus" />
            </button>
            <span id="video-editor-tooltip-zoom-out" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.zoomOut")}
            </span>
          </span>

          <input
            type="range"
            min="0"
            max={TIMELINE_ZOOM_LEVELS.length - 1}
            step="1"
            value={TIMELINE_ZOOM_LEVELS.indexOf(
              timelineZoom as (typeof TIMELINE_ZOOM_LEVELS)[number],
            )}
            onChange={(e) =>
              setTimelineZoom(TIMELINE_ZOOM_LEVELS[Number(e.currentTarget.value)])
            }
            aria-label={t("editor.timelineZoom")}
            className="video-editor-zoom-slider"
          />

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={() => {
                const index = TIMELINE_ZOOM_LEVELS.indexOf(
                  timelineZoom as (typeof TIMELINE_ZOOM_LEVELS)[number],
                );
                setTimelineZoom(
                  TIMELINE_ZOOM_LEVELS[Math.min(TIMELINE_ZOOM_LEVELS.length - 1, index + 1)],
                );
              }}
              disabled={
                timelineZoom >= TIMELINE_ZOOM_LEVELS[TIMELINE_ZOOM_LEVELS.length - 1]
              }
              className="video-editor-tool-button"
              aria-label={t("editor.zoomIn")}
              aria-describedby="video-editor-tooltip-zoom-in"
            >
              <EditorToolIcon name="plus" />
            </button>
            <span id="video-editor-tooltip-zoom-in" role="tooltip" className="video-editor-tool-tooltip">
              {t("editor.zoomIn")}
            </span>
          </span>

          <span className="video-editor-timeline-zoom-value">
            {timelineZoom === 1 ? "1.0" : timelineZoom}×
          </span>
        </div>

        <div className="video-editor-timeline-time-range">
          <span>{formatDuration(timelineCurrentTime)}</span>
          <span>{formatDuration(timelineDuration)}</span>
        </div>

        <div
          data-testid="video-editor-timeline-scroll"
          style={{
            overflowX: "auto",
            overflowY: "hidden",
            paddingBottom: 6,
          }}
        >
        <div
          data-testid="video-editor-timeline-ruler"
          className="video-editor-timeline-ruler"
          data-tick-step={timelineTickStep}
          style={{
            position: "relative",
            height: 28,
            width: `${timelineZoom * 100}%`,
            minWidth: "100%",
          }}
        >
          {Array.from(
            { length: Math.floor(timelineDuration / timelineTickStep) + 1 },
            (_, index) => {
              const tickTime = index * timelineTickStep;
              const left =
                timelineDuration > 0 ? (tickTime / timelineDuration) * 100 : 0;

              return (
                <div
                  key={`timeline-tick-${index}`}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    top: 0,
                    pointerEvents: "none",
                  }}
                >
                  <div className="video-editor-timeline-tick" />
                  <span
                    className="video-editor-timeline-tick-label"
                    style={{
                      position: "absolute",
                      top: 9,
                      left: index === 0 ? 0 : "50%",
                      transform: index === 0 ? "none" : "translateX(-50%)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatTimelineTick(tickTime)}
                  </span>
                </div>
              );
            },
          )}
        </div>
        <div
          data-testid="video-editor-overlay-scroll"
          onClick={() => setSelectedCoverOverlayId(null)}
          style={{
            width: `${timelineZoom * 100}%`,
            minWidth: "100%",
            maxHeight:
              VISIBLE_OVERLAY_TRACKS * OVERLAY_TRACK_HEIGHT +
              (VISIBLE_OVERLAY_TRACKS - 1) * OVERLAY_TRACK_GAP,
            overflowY: coverOverlays.length > VISIBLE_OVERLAY_TRACKS ? "auto" : "visible",
            marginBottom: 4,
          }}
        >
        <div
          data-testid="video-editor-overlay-track"
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: OVERLAY_TRACK_GAP,
          }}
        >
          {coverOverlays.length === 0 && (
            <div
              className="video-editor-timeline-overlay-row"
              style={{
                position: "relative",
                height: 38,
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 10,
                  top: 9,
                  fontSize: 12,
                  color: "var(--color-text-secondary)",
                }}
              >
                {t("editor.covers")}
              </span>
            </div>
          )}

          {coverOverlays.map((overlay, index) => {
            const left =
              timelineDuration > 0
                ? (overlay.start / timelineDuration) * 100
                : 0;

            const width =
              timelineDuration > 0
                ? ((overlay.end - overlay.start) / timelineDuration) * 100
                : 0;

            const selected = overlay.id === selectedCoverOverlayId;

            return (
              <div
                key={overlay.id}
                className="video-editor-timeline-overlay-row"
                data-testid={`video-editor-overlay-row-${overlay.id}`}
                data-selected={selected ? "true" : "false"}
                style={{
                  position: "relative",
                  height: 38,
                  overflow: "hidden",
                }}
              >
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedCoverOverlayId(overlay.id);
                  }}
                  onPointerDown={(e) =>
                    handleCoverOverlayTimelineMovePointerDown(e, overlay.id)
                  }
                  style={{
                    position: "absolute",
                    top: 4,
                    bottom: 4,
                    left: `${left}%`,
                    width: `${width}%`,
                    minWidth: 4,
                    borderRadius: 5,
                    background: selected ? "#FBE3EC" : "#F5EDF1",
                    border: selected ? "1px solid #FC2667" : "1px solid #E4A2B9",
                    outline: selected ? "2px solid #FC2667" : "none",
                    outlineOffset: "-2px",
                    color: selected ? "#881337" : "#6E2943",
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "5px 7px",
                    boxSizing: "border-box",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {t("editor.coverNumber", { number: index + 1 })}

                  <div
                    onPointerDown={(e) =>
                      handleCoverOverlayTimelineStartPointerDown(e, overlay.id)
                    }
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      bottom: 0,
                      width: 12,
                      borderRight: "2px solid #FFFFFF",
                      background: "rgba(255,255,255,0.22)",
                      cursor: "ew-resize",
                      touchAction: "none",
                    }}
                    title={t("editor.coverStartDrag")}
                  />

                  <div
                    onPointerDown={(e) =>
                      handleCoverOverlayTimelineEndPointerDown(e, overlay.id)
                    }
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      bottom: 0,
                      width: 12,
                      borderLeft: "2px solid #FFFFFF",
                      background: "rgba(255,255,255,0.22)",
                      cursor: "ew-resize",
                      touchAction: "none",
                    }}
                    title={t("editor.coverEndDrag")}
                  />
                </div>
              </div>
            );
          })}
        </div>
        </div>

          {annotations.length > 0 && <div data-testid="video-editor-annotation-tracks"
            onClick={() => setSelectedCoverOverlayId(null)}
            style={{ width: `${timelineZoom * 100}%`, minWidth: "100%", marginBottom: 4, display: "flex", flexDirection: "column", gap: 4 }}>
            {annotations.map((item, index) => <div key={item.id} data-testid={`video-editor-${item.type}-track-${item.id}`}
              className="video-editor-timeline-overlay-row"
              style={{ height: 38, position: "relative" }}>
              <button type="button" aria-label={t("editor.annotationNumber", { item: annotationName(item), number: annotations.slice(0, index + 1).filter((a) => a.type === item.type).length })} aria-pressed={selectedAnnotationId === item.id}
                onPointerDown={(e) => handleAnnotationTimelinePointerDown(e, item, "move")}
                onClick={(e) => { e.stopPropagation(); selectAnnotation(item.id); }}
                style={{ position: "absolute", left: `${item.start / timelineDuration * 100}%`, width: `${(item.end - item.start) / timelineDuration * 100}%`,
                  top: 3, bottom: 3, overflow: "hidden", whiteSpace: "nowrap", background: selectedAnnotationId === item.id ? "#FBE3EC" : "#F5EDF1", color: "#881337", cursor: "grab", touchAction: "none",
                  border: selectedAnnotationId === item.id ? "2px solid #FC2667" : "1px solid #F9A8C0", borderRadius: 5 }}>
                {t("editor.annotationNumber", { item: annotationName(item), number: annotations.slice(0, index + 1).filter((a) => a.type === item.type).length })}
                {(["start", "end"] as const).map((edge) => <span key={edge}
                  data-testid={`video-editor-${item.type}-${edge}-${item.id}`}
                  title={t(edge === "start" ? "editor.dragItemStart" : "editor.dragItemEnd", { item: t(item.type === "text" ? "editor.ofText" : item.type === "line" ? "editor.ofLine" : item.type === "symbol" ? "editor.ofSymbol" : item.type === "circle" ? "editor.ofCircle" : "editor.ofArrow") })}
                  onPointerDown={(e) => handleAnnotationTimelinePointerDown(e, item, edge)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ position: "absolute", top: 0, bottom: 0, width: 8,
                    [edge === "start" ? "left" : "right"]: 0,
                    background: "#FC2667", cursor: "ew-resize", touchAction: "none" }} />)}
              </button>
            </div>)}
          </div>}
          <div
            ref={timelineRef}
            data-testid="video-editor-timeline"
            className="video-editor-timeline-video-track"
            data-zoom={timelineZoom}
            onClick={(e) => {
              setSelectedCoverOverlayId(null);
              handleTimelineClick(e);
            }}
            style={{
              position: "relative",
              height: 64,
              width: `${timelineZoom * 100}%`,
              minWidth: "100%",
              borderRadius: 8,
              cursor: "pointer",
              overflow: "hidden",
              userSelect: "none",
            }}
          >
          {clipLayout.map(
            ({ clip, clipDuration, timelineStart }, index) => {
            const left =
              timelineDuration > 0
                ? (timelineStart / timelineDuration) * 100
                : 0;

            const width =
              timelineDuration > 0
                ? (clipDuration / timelineDuration) * 100
                : 0;

            return (
              <div
                key={clip.id}
                data-testid={`video-editor-clip-${clip.id}`}
                className="video-editor-timeline-clip"
                style={{
                  position: "absolute",
                  top: 10,
                  bottom: 10,
                  left: `${left}%`,
                  width: `${width}%`,
                  background: selectedClipId === clip.id ? "#253b59" : "#34465e",
                  border: "1px solid rgba(255,255,255,0.5)",
                  outline:
                    selectedClipId === clip.id
                      ? "3px solid #FC2667"
                      : "none",
                  outlineOffset: "-3px",
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 12px",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  zIndex: selectedClipId === clip.id ? 2 : 1,
                }}
              >
                {clip.sourceVideoId === videoId
                  ? t("editor.clipNumber", { number: index + 1 })
                  : clip.sourceTitle
                    ? t("editor.insertedTitle", { title: clip.sourceTitle === "Unbenanntes Video" ? t("editor.untitledVideo") : clip.sourceTitle })
                    : t("editor.insertedVideo")}
              </div>
            );
          })}

          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: `${trimStartPct}%`,
              background: "rgba(15, 23, 42, 0.6)",
              pointerEvents: "none",
            }}
          />

          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${trimEndPct}%`,
              right: 0,
              background: "rgba(15, 23, 42, 0.6)",
              pointerEvents: "none",
            }}
          />

          <div
            onMouseDown={handleTrimPointerDown("start")}
            onTouchStart={handleTrimPointerDown("start")}
            title={t("editor.trimStart")}
            className="video-editor-timeline-trim-handle"
            style={{
              position: "absolute",
              top: 4,
              bottom: 4,
              left: `${trimStartPct}%`,
              width: 14,
              transform: "translateX(-7px)",
              background: "#fff",
              border: "2px solid #E6467A",
              borderRadius: 5,
              cursor: "ew-resize",
              zIndex: 4,
              touchAction: "none",
            }}
          />

          <div
            onMouseDown={handleTrimPointerDown("end")}
            onTouchStart={handleTrimPointerDown("end")}
            title={t("editor.trimEnd")}
            className="video-editor-timeline-trim-handle"
            style={{
              position: "absolute",
              top: 4,
              bottom: 4,
              left: `${trimEndPct}%`,
              width: 14,
              transform: "translateX(-7px)",
              background: "#fff",
              border: "2px solid #E6467A",
              borderRadius: 5,
              cursor: "ew-resize",
              zIndex: 4,
              touchAction: "none",
            }}
          />

          <div
            data-testid="video-editor-playhead"
            className="video-editor-timeline-playhead"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${playheadPct}%`,
              width: 2,
              background: "#E6467A",
              transform: "translateX(-1px)",
              pointerEvents: "none",
            }}
          />

          <div
            className="video-editor-timeline-playhead-marker"
            style={{
              position: "absolute",
              top: 0,
              left: `${playheadPct}%`,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#E6467A",
              transform: "translate(-5px, -2px)",
              pointerEvents: "none",
            }}
          />
        </div>

        {groupAudioSegments(audioSegments).map(({ trackId, segments }) => {
          const label = trackId === "original" ? t("editor.originalAudio") : t("editor.voiceover");
          return <div key={trackId} data-audio-track={trackId}
          data-testid={trackId === "original" ? "video-editor-audio-track" : "video-editor-voiceover-track"} role="group" aria-label={label}
          className="video-editor-timeline-audio-track"
          style={{ position: "relative", height: 36, marginTop: 4, width: `${timelineZoom * 100}%`, minWidth: "100%",
            borderRadius: 8, overflow: "hidden", userSelect: "none" }}>
          {segments.map((segment, index) => {
            const visual = audioResizeDraft?.id === segment.id ? audioResizeDraft : segment;
            return (
            <div key={segment.id} data-testid={`video-editor-audio-${videoAudioSource(segment)?.clipId ?? segment.id}`}
              className="video-editor-timeline-audio-segment"
              onPointerDown={e => handleAudioResize(e, segment, "move")}
              onClick={e => { e.stopPropagation(); setSelectedAudioId(segment.id); }}
              data-audio-id={segment.id} data-track-id={audioTrackId(segment)} data-clip-id={videoAudioSource(segment)?.clipId} data-source-video-id={videoAudioSource(segment)?.videoId}
              data-source-start={segment.sourceStart} data-source-end={segment.sourceEnd}
              data-timeline-start={segment.timelineStart}
              title={t("editor.audioSegment", { track: label, number: index + 1 })}
              style={{ position: "absolute", top: 4, bottom: 4,
                left: `${timelineDuration > 0 ? visual.timelineStart / timelineDuration * 100 : 0}%`,
                width: `${timelineDuration > 0 ? audioSegmentTimelineDuration(visual, clips) / timelineDuration * 100 : 0}%`,
                cursor: movingAudioId === segment.id ? "grabbing" : "grab", touchAction: "none",
                outline: selectedAudioId === segment.id ? "2px solid #FC2667" : undefined,
                outlineOffset: -1,
                boxSizing: "border-box", border: "1px solid rgba(255,255,255,0.45)", background: "#34465e",
                color: "#fff", fontSize: 12, padding: "0 12px", display: "flex", alignItems: "center",
                gap: 6, whiteSpace: "nowrap", overflow: "hidden" }}>
              <AudioSegmentWaveform sourceKey={audioSourceKey(audioSource(visual))} sourceStart={visual.sourceStart}
                sourceEnd={visual.sourceEnd} zoom={timelineZoom} cache={waveformCacheRef.current}
                loadUrl={() => audioSourceResolver.resolve(audioSource(visual))} />
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, position: "relative", background: "#34465e" }}>
                <path d="M2 6h3l4-3v10l-4-3H2ZM12 5a5 5 0 0 1 0 6" />
              </svg>
              <span className="video-editor-timeline-audio-label" style={{ position: "relative", background: "#34465e" }}>{t("editor.audioNumber", { track: label, number: index + 1 })}{segment.muted === true ? t("editor.mutedSuffix") : ""}</span>
              {selectedAudioId === segment.id && (["start", "end"] as const).map(edge => (
                <button key={edge} type="button" data-audio-resize-handle={edge} aria-label={t(edge === "start" ? "editor.audioTrimStart" : "editor.audioTrimEnd")}
                  disabled={audioSegmentTimelineDuration(segment, clips) < 0.1}
                  onPointerDown={e => handleAudioResize(e, segment, edge)}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                  style={{ position: "absolute", top: 0, bottom: 0, [edge === "start" ? "left" : "right"]: 0,
                    width: "min(8px, 40%)", padding: 0, border: 0, borderRadius: 2,
                    background: "rgba(255,255,255,0.78)", cursor: "ew-resize", touchAction: "none" }} />
              ))}
            </div>
          ); })}
          <div data-testid={`audio-playhead-${trackId}`} aria-hidden="true"
            style={{ position: "absolute", top: 0, bottom: 0, left: `${playheadPct}%`, width: 2,
              background: "#E6467A", pointerEvents: "none" }} />
        </div>
        })}

        </div>

        <div style={{ minHeight: 36, display: "flex", alignItems: "center", gap: 6 }}>
          {audioSegments.some(segment => segment.id === selectedAudioId) && (
            <button type="button" className="video-editor-tool-button" onClick={handleToggleAudioMute}
              disabled={audioGestureActive || audioVolumeDraft !== null}
              style={{ width: "auto", padding: "0 8px" }}>
              {t(audioSegments.find(segment => segment.id === selectedAudioId)?.muted === true ? "editor.unmute" : "editor.mute")}
            </button>
          )}
          {audioSegments.some(segment => segment.id === selectedAudioId) && (
            <button type="button" className="video-editor-tool-button" onClick={handleDeleteAudio}
              disabled={audioGestureActive || audioVolumeDraft !== null}
              style={{ width: "auto", gap: 6, padding: "0 8px" }}>
              <EditorToolIcon name="delete" />
              {t("editor.deleteAudio")}
            </button>
          )}
          {audioSegments.some(segment => segment.id === selectedAudioId) && (
            <label className="video-editor-cover-time-label">
              {t("editor.volume")}{" "}
              <input type="range" aria-label={t("editor.audioVolume")} min={0} max={100} step={1}
                className="video-editor-opacity-slider" style={{ width: 88 }}
                disabled={audioGestureActive}
                value={Math.round((audioVolumeDraft?.value ?? audioSegments.find(segment => segment.id === selectedAudioId)?.volume ?? 1) * 100)}
                onPointerDown={event => beginAudioVolume(event.pointerId)}
                onKeyDown={event => {
                  if (event.key === "Escape" && volumeGestureRef.current) {
                    event.preventDefault(); event.stopPropagation(); volumeGestureRef.current.cancel();
                  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) beginAudioVolume();
                }}
                onKeyUp={event => {
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) volumeGestureRef.current?.finish();
                }}
                onBlur={() => volumeGestureRef.current?.finish()}
                onChange={event => {
                  if (cancelAudioResizeRef.current) return;
                  beginAudioVolume();
                  volumeGestureRef.current?.change(Number(event.target.value) / 100);
                }} />
              <span className="video-editor-opacity-value">
                {Math.round((audioVolumeDraft?.value ?? audioSegments.find(segment => segment.id === selectedAudioId)?.volume ?? 1) * 100)} %
              </span>
            </label>
          )}
        </div>
        </section>

        <div className="video-editor-timeline-selection-summary">
          <span>{t("editor.beginning")} {formatDuration(trimStart)}</span>
          <span>
            {t("editor.selection")} {formatDuration(Math.max(0, trimEnd - trimStart))}
          </span>
          <span>{t("editor.ending")} {formatDuration(trimEnd)}</span>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 10,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={handleResetTrim}
            disabled={trimming}
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              padding: "9px 16px",
              fontWeight: 600,
              cursor: trimming ? "default" : "pointer",
            }}
          >
            {t("editor.reset")}
          </button>

          <button
            type="button"
            onClick={handleApplyTrim}
            disabled={
              trimming ||
              hasDeletedTime ||
              (trimStart <= 0.001 && trimEnd >= duration - 0.001)
            }
            style={{
              background: "#0F172A",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 8,
              padding: "9px 18px",
              fontWeight: 600,
              cursor: trimming ? "default" : "pointer",
              opacity:
                trimming ||
                hasDeletedTime ||
                (trimStart <= 0.001 && trimEnd >= duration - 0.001)
                  ? 0.6
                  : 1,
            }}
          >
            {t(trimming ? "editor.trimming" : "editor.applyTrim")}
          </button>

          <button
            type="button"
            onClick={() => setShowRenderName(true)}
            disabled={rendering || clips.length === 0 || timelineDuration < 1}
            style={{
              background: "#E6467A",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 8,
              padding: "9px 18px",
              fontWeight: 600,
              cursor: rendering ? "default" : "pointer",
              opacity: rendering ? 0.6 : 1,
            }}
          >
            {t(rendering ? "editor.rendering" : "editor.renderNew")}
          </button>
        </div>
        {showRenderName && <PromptDialog title={t("editor.renderName")}
          initialValue={`${videoTitle} – ${t("editor.editedSuffix")}`} submitLabel={t("editor.render")} cancelLabel={t("common.cancel")}
          onCancel={() => setShowRenderName(false)} onSubmit={handleRenderTimeline} />}
        {renderStatus === "ready" && renderedVideoId && (
          <div style={{ marginTop: 12, textAlign: "center", color: "var(--color-text)" }}>
            {t("editor.renderComplete")} <a href={`/videos/${renderedVideoId}`}>{t("editor.openEdited")}</a>
          </div>
        )}
        </>}
        </main>
      </div>
    </div>
  );
}
