import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { formatDuration } from "../utils/format";
import type { Video } from "../types/video";

interface EditorClip {
  id: string;
  sourceVideoId: string;
  sourceTitle?: string;
  start: number;
  end: number;
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

interface EditorAnnotation {
  id: string;
  type: "arrow";
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  rotation: number;
}

interface EditorHistoryEntry {
  clips: EditorClip[];
  coverOverlays: EditorCoverOverlay[];
  annotations: EditorAnnotation[];
}

interface StoredEditorState {
  timeline: {
    version: number;
    clips: Array<{
      id: string;
      sourceId: string;
      sourceStart: number;
      sourceEnd: number;
      duration: number;
    }>;
    overlays?: EditorCoverOverlay[];
    annotations?: EditorAnnotation[];
  };
  renderStatus: "none" | "processing" | "ready" | "failed";
  renderError: string | null;
  renderedVideoId: string | null;
}

interface VideoEditorModalProps {
  videoId: string;
  duration: number;
  onClose: () => void;
  onTrimStarted?: () => void;
}

const TIMELINE_ZOOM_LEVELS = [1, 2, 5, 10] as const;
const TIMELINE_TICK_STEPS = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const OVERLAY_SAVE_DEBOUNCE_MS = 400;
const VISIBLE_OVERLAY_TRACKS = 4;
const OVERLAY_TRACK_HEIGHT = 38;
const OVERLAY_TRACK_GAP = 4;

function serializeTimeline(clips: EditorClip[], overlays: EditorCoverOverlay[], annotations: EditorAnnotation[] = []) {
  return JSON.stringify({
    version: 1,
    clips: clips.map((clip) => ({
      id: clip.id,
      sourceId: clip.sourceVideoId,
      sourceStart: clip.start,
      sourceEnd: clip.end,
      duration: clip.end - clip.start,
    })),
    overlays,
    annotations,
  });
}

function EditorToolIcon({ name }: { name: "trim" | "split" | "cover" | "insert" | "undo" | "fit" | "minus" | "plus" | "copy" | "paste" | "delete" | "arrow" }) {
  const paths = {
    arrow: <path d="M2 13 13 2M5 2h8v8" />,
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
  duration,
  onClose,
  onTrimStarted,
}: VideoEditorModalProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [timelinePlayheadTime, setTimelinePlayheadTime] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [showInsertPicker, setShowInsertPicker] = useState(false);
  const [libraryVideos, setLibraryVideos] = useState<Video[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedInsertVideo, setSelectedInsertVideo] = useState<Video | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(duration);
  const [trimming, setTrimming] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<StoredEditorState["renderStatus"]>("none");
  const [renderedVideoId, setRenderedVideoId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editorHistory, setEditorHistory] = useState<EditorHistoryEntry[]>([]);
  const [coverOverlays, setCoverOverlays] = useState<EditorCoverOverlay[]>([]);
  const [selectedCoverOverlayId, setCoverSelection] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<EditorAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [copiedAnnotation, setCopiedAnnotation] = useState<EditorAnnotation | null>(null);
  const annotationFrameRef = useRef<HTMLDivElement>(null);
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
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const nextClipIdRef = useRef(2);
  const timelineRef = useRef<HTMLDivElement>(null);
  const draggingTrimRef = useRef<"start" | "end" | null>(null);
  const videoUrlsRef = useRef<Record<string, string>>({});
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

  async function loadVideoUrl(sourceVideoId: string) {
    if (videoUrlsRef.current[sourceVideoId]) {
      return videoUrlsRef.current[sourceVideoId];
    }

    const res = await apiFetch<{ downloadUrl: string }>(`/api/videos/${sourceVideoId}/download`);
    if (!res?.downloadUrl) {
      throw new Error("Video konnte nicht geladen werden.");
    }

    videoUrlsRef.current[sourceVideoId] = res.downloadUrl;
    return res.downloadUrl;
  }

  async function switchPreviewSource(
    sourceVideoId: string,
    sourceTime: number,
    clipId?: string,
    resumePlayback?: boolean,
  ) {
    const video = videoRef.current;
    if (!video) return;

    const generation = ++sourceSwitchGenerationRef.current;
    cancelPendingSourceLoadRef.current?.();
    cancelPendingSourceLoadRef.current = null;
    const shouldResume = resumePlayback ?? !video.paused;

    try {
      const url = await loadVideoUrl(sourceVideoId);
      if (generation !== sourceSwitchGenerationRef.current) return;

      if (clipId) activeClipIdRef.current = clipId;

      if (activeSourceVideoIdRef.current === sourceVideoId && video.src === url) {
        video.currentTime = sourceTime;
        if (shouldResume) await video.play();
        sourceTransitionPendingRef.current = false;
        return;
      }

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
      if (shouldResume) await video.play();
      sourceTransitionPendingRef.current = false;
      setError(null);
    } catch (err) {
      if (generation !== sourceSwitchGenerationRef.current) return;
      sourceTransitionPendingRef.current = false;
      setError(
        err instanceof Error ? err.message : "Video konnte nicht geladen werden.",
      );
    }
  }



  useEffect(() => {
    let cancelled = false;
    apiFetch<{ downloadUrl: string }>(`/api/videos/${videoId}/download`)
      .then((res) => {
        if (cancelled) return;
        if (res?.downloadUrl) {
          setVideoUrl(res.downloadUrl);
          videoUrlsRef.current[videoId] = res.downloadUrl;
        } else {
          setError("Video konnte nicht geladen werden.");
        }
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
  }, [videoUrl]);

  useEffect(() => {
    editorStateLoadedRef.current = false;
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
          restoredClips = state.timeline.clips.map((clip) => ({
            id: clip.id,
            sourceVideoId: clip.sourceId,
            start: clip.sourceStart,
            end: clip.sourceEnd,
          }));
          setClips(restoredClips);
          restoredOverlays = (state.timeline.overlays ?? []).map((overlay) => ({
            ...overlay,
            mode: overlay.mode === "blur" ? "blur" : "cover",
          }));
          setCoverOverlays(restoredOverlays);
          restoredAnnotations = state.timeline.annotations ?? [];
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
        const restoredPayload = serializeTimeline(restoredClips, restoredOverlays, restoredAnnotations);
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
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const timelineDuration = clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.end - clip.start),
    0,
  );

  useEffect(() => {
    const payload = serializeTimeline(clips, coverOverlays, annotations);
    latestTimelinePayloadRef.current = payload;

    if (!editorStateLoadedRef.current) return;
    if (payload === lastSavedTimelinePayloadRef.current) return;

    timelineSavePendingRef.current = true;
    if (overlaySaveTimerRef.current !== null) {
      window.clearTimeout(overlaySaveTimerRef.current);
    }
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
  }, [clips, coverOverlays, annotations, videoId]);

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
    if (clips.length === 0) return null;

    const clampedTime = Math.max(
      0,
      Math.min(timelineTime, timelineDuration),
    );

    let offset = 0;

    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      const clipDuration = clip.end - clip.start;
      const clipTimelineEnd = offset + clipDuration;

      if (
        clampedTime <= clipTimelineEnd ||
        index === clips.length - 1
      ) {
        const insideClip = Math.max(
          0,
          Math.min(clampedTime - offset, clipDuration),
        );

        return {
          clip,
          index,
          timelineStart: offset,
          sourceTime: clip.start + insideClip,
        };
      }

      offset = clipTimelineEnd;
    }

    return null;
  }

  function timelineStartForClip(clipId: string) {
    let offset = 0;
    for (const clip of clips) {
      if (clip.id === clipId) return offset;
      offset += clip.end - clip.start;
    }
    return null;
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

    setClips((previousClips) => {
      if (!position) {
        return [...previousClips, insertedClip];
      }

      const { clip, index, sourceTime, timelineStart } =
        position;

      const clipDuration = clip.end - clip.start;
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

  function rememberEditorState() {
    setEditorHistory((history) => [
      ...history.slice(-49),
      {
        clips: clips.map((clip) => ({ ...clip })),
        coverOverlays: coverOverlays.map((overlay) => ({ ...overlay })),
        annotations: annotations.map((annotation) => ({ ...annotation })),
      },
    ]);
  }

  function handleUndo() {
    if (editorHistory.length === 0) return;

    const previousState = editorHistory[editorHistory.length - 1];
    const clipsChanged = serializeTimeline(previousState.clips, coverOverlays) !==
      serializeTimeline(clips, coverOverlays);

    setClips(previousState.clips);
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
    const minimumDistance = 0.1;

    const position =
      timelineTimeToClipPosition(timelinePlayheadTime);

    if (!position) {
      setError("Zum Teilen muss der Abspielkopf innerhalb eines Clips stehen.");
      return;
    }

    const { clip, index, sourceTime } = position;

    if (
      sourceTime <= clip.start + minimumDistance ||
      sourceTime >= clip.end - minimumDistance
    ) {
      setError(
        "Zum Teilen muss der Abspielkopf innerhalb eines Clips stehen.",
      );
      return;
    }

    rememberEditorState();

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

    setClips((previousClips) => [
      ...previousClips.slice(0, index),
      leftClip,
      rightClip,
      ...previousClips.slice(index + 1),
    ]);

    if (activeClipIdRef.current === clip.id) {
      activeClipIdRef.current = rightClip.id;
    }

    setSelectedClipId(null);
    setError(null);
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

  function addAnnotation(source?: EditorAnnotation) {
    if (timelineDuration <= 0) return;
    const start = Math.min(timelinePlayheadTime, Math.max(0, timelineDuration - 0.1));
    const annotation: EditorAnnotation = source
      ? { ...source, id: crypto.randomUUID(),
          // Clipboard geometry uses the same frame-relative bounds as dragging.
          // Do not offset copies; only bring out-of-bounds positions back inside.
          x: Math.max(0, Math.min(100 - source.width, source.x)),
          y: Math.max(0, Math.min(100 - source.height, source.y)) }
      : { id: crypto.randomUUID(), type: "arrow", x: 35, y: 35, width: 30, height: 20,
          start, end: Math.min(timelineDuration, start + 5), rotation: 0 };
    rememberEditorState();
    setAnnotations((previous) => [...previous, annotation]);
    selectAnnotation(annotation.id);
  }

  function updateAnnotation(patch: Partial<Pick<EditorAnnotation, "start" | "end" | "rotation">>) {
    if (!selectedAnnotation) return;
    rememberEditorState();
    setAnnotations((previous) => previous.map((item) =>
      item.id === selectedAnnotation.id ? { ...item, ...patch } : item));
  }

  function handleAnnotationPointerDown(e: React.PointerEvent<HTMLDivElement>, annotation: EditorAnnotation, resize = false) {
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(annotation.id);
    const rect = annotationFrameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    cancelAnnotationDragRef.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    let captured = false;
    const move = (event: PointerEvent) => {
      if (event.clientX === startX && event.clientY === startY && !captured) return;
      if (!captured) { rememberEditorState(); captured = true; }
      const dx = (event.clientX - startX) / rect.width * 100;
      const dy = (event.clientY - startY) / rect.height * 100;
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

  function handleAnnotationTimelineResize(e: React.PointerEvent<HTMLSpanElement>, annotation: EditorAnnotation, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    selectAnnotation(annotation.id);
    const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || timelineDuration <= 0) return;
    cancelAnnotationDragRef.current?.();
    const startClientX = e.clientX;
    let captured = false;
    let lastValue = annotation[edge];
    const move = (event: PointerEvent) => {
      const rawTime = annotation[edge] + (event.clientX - startClientX) / rect.width * timelineDuration;
      const value = edge === "start"
        ? Math.max(0, Math.min(annotation.end - 0.1, rawTime))
        : Math.min(timelineDuration, Math.max(annotation.start + 0.1, rawTime));
      if (value === lastValue) return;
      if (!captured) { rememberEditorState(); captured = true; }
      lastValue = value;
      setAnnotations((previous) => previous.map((item) => item.id === annotation.id ? { ...item, [edge]: value } : item));
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

    setClips((previousClips) =>
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

    const confirmed = window.confirm(
      "Das aktuelle Video wird durch die getrimmte Version ersetzt. Möchtest du fortfahren?"
    );

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
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Trimmen fehlgeschlagen."
      );
      setTrimming(false);
    }
  }

  async function handleRenderTimeline() {
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
          version: 1,
          clips: clips.map((clip) => ({
            id: clip.id,
            sourceId: clip.sourceVideoId,
            sourceStart: clip.start,
            sourceEnd: clip.end,
            duration: clip.end - clip.start,
          })),
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

  let timelineOffset = 0;

  const clipLayout = clips.map((clip) => {
    const clipDuration = Math.max(0, clip.end - clip.start);
    const timelineStart = timelineOffset;

    timelineOffset += clipDuration;

    return {
      clip,
      clipDuration,
      timelineStart,
    };
  });

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
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--color-overlay)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-editor-title"
        style={{
        width: "calc(100vw - 32px)",
        height: "calc(100vh - 32px)",
        minWidth: 720,
        minHeight: 520,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100vh - 32px)",
        resize: "both",
        boxSizing: "border-box",
        position: "relative",
          overflowY: "auto",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2
            id="video-editor-title"
            style={{
              margin: 0,
              fontSize: 20,
              color: "var(--color-text)",
            }}
          >
            Video bearbeiten
          </h2>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              padding: "6px 12px",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            Schließen
          </button>
        </div>

        {error && (
          <div
            style={{
              color: "var(--color-error)",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {videoUrl && (
          <div
            ref={previewContainerRef}
            data-testid="video-editor-preview"
            style={{ position: "relative", width: "100%", marginBottom: 16 }}
          >
            <video
              ref={videoRef}
              controls
              onLoadedMetadata={updateVisibleVideoFrame}
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
                setTimelinePlayheadTime(
                  Math.max(
                    clipTimelineStart,
                    Math.min(
                      clipTimelineStart + (activeClip.end - activeClip.start),
                      clipTimelineStart + (sourceTime - activeClip.start),
                    ),
                  ),
                );

                if (
                  !e.currentTarget.paused &&
                  sourceTime >= activeClip.end - 0.05
                ) {
                  advancePreviewToNextClip();
                }
              }}
              onEnded={advancePreviewToNextClip}
              style={{
                width: "100%",
                maxHeight: "min(48vh, 560px)",
                display: "block",
                objectFit: "contain",
                background: "#000",
                borderRadius: 8,
              }}
            />

            <div
              data-testid="video-editor-overlay-frame"
              ref={annotationFrameRef}
              style={{
                position: "absolute",
                left: videoFrameRect.left,
                top: videoFrameRect.top,
                width: videoFrameRect.width,
                height: videoFrameRect.height,
                overflow: "hidden",
                borderRadius: 8,
                pointerEvents: "none",
              }}
            >
              {annotations.filter((item) => timelineCurrentTime >= item.start && timelineCurrentTime <= item.end).map((item) => (
                <div key={item.id} data-testid={`video-editor-arrow-${item.id}`}
                  onPointerDown={(e) => handleAnnotationPointerDown(e, item)}
                  onClick={(e) => { e.stopPropagation(); selectAnnotation(item.id); }}
                  style={{ position: "absolute", left: `${item.x}%`, top: `${item.y}%`, width: `${item.width}%`, height: `${item.height}%`,
                    pointerEvents: "auto", touchAction: "none", cursor: "move", boxSizing: "border-box",
                    zIndex: selectedAnnotationId === item.id ? 4 : 3,
                    border: selectedAnnotationId === item.id ? "1px solid #FC2667" : "1px solid transparent" }}>
                  <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: "block", pointerEvents: "none" }}>
                    <polygon fill="#FC2667" points="8,44 65,44 65,28 94,50 65,72 65,56 8,56" transform={`rotate(${item.rotation} 50 50)`} />
                  </svg>
                  {selectedAnnotationId === item.id && <div data-testid={`video-editor-arrow-resize-${item.id}`}
                    onPointerDown={(e) => handleAnnotationPointerDown(e, item, true)}
                    style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12, background: "#FC2667", cursor: "nwse-resize", touchAction: "none" }} />}
                </div>
              ))}
              {visibleCoverOverlays.map(({ overlay }) => (
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
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <span className="video-editor-tool">
            <button
              type="button"
              className="video-editor-tool-button"
              aria-label="Trimmen"
              aria-describedby="video-editor-tooltip-trim"
              style={{ cursor: "default" }}
            >
              <EditorToolIcon name="trim" />
            </button>
            <span id="video-editor-tooltip-trim" role="tooltip" className="video-editor-tool-tooltip">
              Trimmen
            </span>
          </span>

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleSplit}
              className="video-editor-tool-button"
              aria-label="Teilen"
              aria-describedby="video-editor-tooltip-split"
            >
              <EditorToolIcon name="split" />
            </button>
            <span id="video-editor-tooltip-split" role="tooltip" className="video-editor-tool-tooltip">
              Teilen
            </span>
          </span>

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleAddCoverOverlay}
              className="video-editor-tool-button"
              aria-label="+ Abdeckung"
              aria-describedby="video-editor-tooltip-cover"
            >
              <EditorToolIcon name="cover" />
            </button>
            <span id="video-editor-tooltip-cover" role="tooltip" className="video-editor-tool-tooltip">
              Abdeckung hinzufügen
            </span>
          </span>

          <span className="video-editor-tool">
            <button type="button" className="video-editor-tool-button" aria-label="Pfeil hinzufügen"
              aria-describedby="video-editor-tooltip-arrow" onClick={() => addAnnotation()}>
              <EditorToolIcon name="arrow" />
            </button>
            <span id="video-editor-tooltip-arrow" role="tooltip" className="video-editor-tool-tooltip">Pfeil hinzufügen</span>
          </span>

          {selectedClipId && (
            <button
              type="button"
              onClick={handleDeleteSelectedClip}
              disabled={clips.length <= 1}
              style={{
                border: "1px solid #B42318",
                borderRadius: 8,
                padding: "8px 14px",
                background: "#FFFFFF",
                color: "#B42318",
                fontWeight: 600,
                cursor:
                  clips.length <= 1 ? "default" : "pointer",
                opacity: clips.length <= 1 ? 0.5 : 1,
              }}
            >
              Clip löschen
            </button>
          )}

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleOpenInsertPicker}
              className="video-editor-tool-button"
              aria-label="Video einfügen"
              aria-describedby="video-editor-tooltip-insert"
            >
              <EditorToolIcon name="insert" />
            </button>
            <span id="video-editor-tooltip-insert" role="tooltip" className="video-editor-tool-tooltip">
              Video einfügen
            </span>
          </span>

          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleUndo}
              disabled={editorHistory.length === 0}
              className="video-editor-tool-button"
              aria-label="↶ Rückgängig"
              aria-describedby="video-editor-tooltip-undo"
            >
              <EditorToolIcon name="undo" />
            </button>
            <span id="video-editor-tooltip-undo" role="tooltip" className="video-editor-tool-tooltip">
              Rückgängig
            </span>
          </span>

          <span
            style={{
              fontSize: 13,
              color: "var(--color-text-secondary)",
            }}
          >
            Abspielkopf setzen und mit „Teilen“ einen neuen Clip erzeugen
          </span>
        </div>

        <div className="video-editor-cover-actions" data-testid="video-editor-cover-actions">
        {selectedAnnotation && <>
          <span>Pfeil:</span>
          <label>Richtung <select aria-label="Pfeilrichtung" value={selectedAnnotation.rotation}
            onChange={(e) => updateAnnotation({ rotation: Number(e.target.value) })}>
            {["Rechts", "Rechts unten", "Unten", "Links unten", "Links", "Links oben", "Oben", "Rechts oben"].map((label, index) =>
              <option key={label} value={index * 45}>{label}</option>)}
          </select></label>
          <label>Start <input aria-label="Pfeil Start" type="number" min={0} max={selectedAnnotation.end - 0.1} step={0.1}
            value={selectedAnnotation.start} onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) updateAnnotation({ start: Math.max(0, Math.min(value, selectedAnnotation.end - 0.1)) });
            }} style={{ width: 70 }} /></label>
          <label>Ende <input aria-label="Pfeil Ende" type="number" min={selectedAnnotation.start + 0.1} max={timelineDuration} step={0.1}
            value={selectedAnnotation.end} onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) updateAnnotation({ end: Math.min(timelineDuration, Math.max(value, selectedAnnotation.start + 0.1)) });
            }} style={{ width: 70 }} /></label>
          <button type="button" className="video-editor-tool-button" aria-label="Pfeil kopieren" title="Pfeil kopieren"
            onClick={() => setCopiedAnnotation({ ...selectedAnnotation })}><EditorToolIcon name="copy" /></button>
          <button type="button" className="video-editor-tool-button" aria-label="Pfeil löschen" title="Pfeil löschen" onClick={() => {
            rememberEditorState();
            setAnnotations((previous) => previous.filter((item) => item.id !== selectedAnnotation.id));
            setSelectedAnnotationId(null);
          }}><EditorToolIcon name="delete" /></button>
        </>}
        {copiedAnnotation && <button type="button" className="video-editor-tool-button" aria-label="Pfeil einfügen" title="Pfeil einfügen"
          onClick={() => addAnnotation(copiedAnnotation)}><EditorToolIcon name="paste" /></button>}
        {selectedCoverOverlay && (
          <>
          <strong className="video-editor-cover-actions-label">Abdeckung:</strong>

          <label className="video-editor-cover-time-label">
            Typ{" "}
            <select
              aria-label="Abdeckungstyp"
              value={selectedCoverOverlay.mode ?? "cover"}
              onChange={(e) => handleCoverOverlayModeChange(e.target.value as "cover" | "blur")}
              className="video-editor-cover-time-input"
            >
              <option value="cover">Abdecken</option>
              <option value="blur">Blur</option>
            </select>
          </label>

          {(selectedCoverOverlay.mode ?? "cover") === "cover" && (
            <>
              <label className="video-editor-cover-time-label">
                Farbe{" "}
                <input
                  type="color"
                  aria-label="Cover-Farbe"
                  value={selectedCoverOverlay.color ?? "#000000"}
                  onChange={(e) => handleCoverOverlayColorChange(e.target.value)}
                  style={{ width: 32, height: 28, padding: 2 }}
                />
              </label>
              <label className="video-editor-cover-time-label">
                Deckkraft{" "}
                <input
                  type="range"
                  aria-label="Cover-Deckkraft"
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
                Text{" "}
                <input
                  type="text"
                  aria-label="Cover-Text"
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
            Start{" "}
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
            Ende{" "}
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
              aria-label="Abdeckung kopieren"
              aria-describedby="video-editor-tooltip-copy-cover"
            >
              <EditorToolIcon name="copy" />
            </button>
            <span id="video-editor-tooltip-copy-cover" role="tooltip" className="video-editor-tool-tooltip">
              Abdeckung kopieren
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
              aria-label="Abdeckung einfügen"
              aria-describedby="video-editor-tooltip-paste-cover"
            >
              <EditorToolIcon name="paste" />
            </button>
            <span id="video-editor-tooltip-paste-cover" role="tooltip" className="video-editor-tool-tooltip">
              Abdeckung einfügen
            </span>
          </span>
        )}

        {selectedCoverOverlay && (
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={handleDeleteSelectedCoverOverlay}
              className="video-editor-tool-button video-editor-tool-button--destructive"
              aria-label="Abdeckung löschen"
              aria-describedby="video-editor-tooltip-delete-cover"
            >
              <EditorToolIcon name="delete" />
            </button>
            <span id="video-editor-tooltip-delete-cover" role="tooltip" className="video-editor-tool-tooltip">
              Abdeckung löschen
            </span>
          </span>
        )}
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
                Video aus Bibliothek auswählen
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
                Bibliothek wird geladen...
              </div>
            ) : libraryVideos.length === 0 ? (
              <div style={{ color: "var(--color-text-secondary)" }}>
                Keine weiteren fertigen Videos gefunden.
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
                      {video.title || "Unbenanntes Video"}
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
              Zum Einfügen ausgewählt:{" "}
              <strong>
                {selectedInsertVideo.title || "Unbenanntes Video"}
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
              Hier einfügen
            </button>
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <span className="video-editor-tool">
            <button
              type="button"
              onClick={() => setTimelineZoom(1)}
              className="video-editor-tool-button"
              aria-label="Ansicht einpassen"
              aria-describedby="video-editor-tooltip-fit"
            >
              <EditorToolIcon name="fit" />
            </button>
            <span
              id="video-editor-tooltip-fit"
              role="tooltip"
              className="video-editor-tool-tooltip video-editor-tool-tooltip--left-edge"
            >
              Ansicht einpassen
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
              aria-label="Verkleinern"
              aria-describedby="video-editor-tooltip-zoom-out"
            >
              <EditorToolIcon name="minus" />
            </button>
            <span id="video-editor-tooltip-zoom-out" role="tooltip" className="video-editor-tool-tooltip">
              Verkleinern
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
            aria-label="Timeline-Zoom"
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
              aria-label="Vergrößern"
              aria-describedby="video-editor-tooltip-zoom-in"
            >
              <EditorToolIcon name="plus" />
            </button>
            <span id="video-editor-tooltip-zoom-in" role="tooltip" className="video-editor-tool-tooltip">
              Vergrößern
            </span>
          </span>

          <span
            style={{
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            {timelineZoom === 1 ? "1.0" : timelineZoom}×
          </span>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            color: "var(--color-text-secondary)",
            marginBottom: 8,
          }}
        >
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
          data-tick-step={timelineTickStep}
          style={{
            position: "relative",
            height: 28,
            width: `${timelineZoom * 100}%`,
            minWidth: "100%",
            borderBottom: "1px solid var(--color-border)",
            marginBottom: 4,
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
                  <div
                    style={{
                      width: 1,
                      height: 8,
                      background: "var(--color-text-secondary)",
                      opacity: 0.6,
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      top: 9,
                      left: index === 0 ? 0 : "50%",
                      transform: index === 0 ? "none" : "translateX(-50%)",
                      fontSize: 10,
                      color: "var(--color-text-secondary)",
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
              style={{
                position: "relative",
                height: 38,
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                background: "#F8FAFC",
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
                Abdeckungen
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
                data-testid={`video-editor-overlay-row-${overlay.id}`}
                data-selected={selected ? "true" : "false"}
                style={{
                  position: "relative",
                  height: 38,
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  background: "#F8FAFC",
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
                    background: selected ? "#FC2667" : "#F7C2D2",
                    border: "1px solid #FC2667",
                    color: selected ? "#FFFFFF" : "#0F172A",
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "5px 7px",
                    boxSizing: "border-box",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  Abdeckung {index + 1}

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
                    title="Start der Abdeckung ziehen"
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
                    title="Ende der Abdeckung ziehen"
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
            {annotations.map((item, index) => <div key={item.id} data-testid={`video-editor-arrow-track-${item.id}`}
              style={{ height: 38, position: "relative", background: "#F8FAFC", border: "1px solid var(--color-border)", borderRadius: 8 }}>
              <button type="button" aria-label={`Pfeil ${index + 1}`} aria-pressed={selectedAnnotationId === item.id}
                onClick={(e) => { e.stopPropagation(); selectAnnotation(item.id); }}
                style={{ position: "absolute", left: `${item.start / timelineDuration * 100}%`, width: `${(item.end - item.start) / timelineDuration * 100}%`,
                  top: 3, bottom: 3, overflow: "hidden", whiteSpace: "nowrap", background: "#FCE7EF", color: "#881337",
                  border: selectedAnnotationId === item.id ? "2px solid #FC2667" : "1px solid #F9A8C0", borderRadius: 5 }}>
                Pfeil {index + 1}
                {(["start", "end"] as const).map((edge) => <span key={edge}
                  data-testid={`video-editor-arrow-${edge}-${item.id}`}
                  title={edge === "start" ? "Start des Pfeils ziehen" : "Ende des Pfeils ziehen"}
                  onPointerDown={(e) => handleAnnotationTimelineResize(e, item, edge)}
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
              background: "var(--color-border)",
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
                style={{
                  position: "absolute",
                  top: 10,
                  bottom: 10,
                  left: `${left}%`,
                  width: `${width}%`,
                  background: "#1E293B",
                  border: "1px solid rgba(255,255,255,0.35)",
                  outline:
                    selectedClipId === clip.id
                      ? "3px solid #E6467A"
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
                  ? `Clip ${index + 1}`
                  : clip.sourceTitle
                    ? `Eingefügt: ${clip.sourceTitle}`
                    : "Eingefügtes Video"}
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
            title="Trim-Anfang"
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
            title="Trim-Ende"
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

        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 10,
            fontSize: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          <span>Anfang: {formatDuration(trimStart)}</span>
          <span>
            Auswahl: {formatDuration(Math.max(0, trimEnd - trimStart))}
          </span>
          <span>Ende: {formatDuration(trimEnd)}</span>
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
            Zurücksetzen
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
            {trimming ? "Wird getrimmt..." : "Trimmen anwenden"}
          </button>

          <button
            type="button"
            onClick={handleRenderTimeline}
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
            {rendering ? "Video wird gerendert..." : "Als neues Video rendern"}
          </button>
        </div>
        {renderStatus === "ready" && renderedVideoId && (
          <div style={{ marginTop: 12, textAlign: "center", color: "var(--color-text)" }}>
            Render abgeschlossen. <a href={`/videos/${renderedVideoId}`}>Bearbeitetes Video öffnen</a>
          </div>
        )}
      </div>
    </div>
  );
}
