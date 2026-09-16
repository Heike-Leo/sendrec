import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoEditorModal, isAudioStillCoupled } from "./VideoEditorModal";
import { EditorAudioPreview } from "./editorAudioPreview";
import { loadAudioWaveformPeaks } from "./editorAudioWaveform";
import type { EditorAudioSegment } from "./editorAudioGeometry";

vi.mock("./editorAudioWaveform", async importOriginal => ({
  ...await importOriginal<typeof import("./editorAudioWaveform")>(), loadAudioWaveformPeaks: vi.fn(),
}));

const mockApiFetch = vi.fn();

describe("audio coupling guard", () => {
  const clips = [
    { id: "one", sourceVideoId: "original", start: 2, end: 7 },
    { id: "two", sourceVideoId: "original", start: 10, end: 15 },
  ];
  const audio = [
    { id: "a", sourceClipId: "one", sourceVideoId: "original", sourceStart: 2, sourceEnd: 7, timelineStart: 0 },
    { id: "b", sourceClipId: "two", sourceVideoId: "original", sourceStart: 10, sourceEnd: 15, timelineStart: 5 },
  ];
  it("matches by clip ID, ignoring audio IDs and storage order", () => {
    expect(isAudioStillCoupled(clips, [...audio].reverse().map(a => ({ ...a, id: `new-${a.id}` })))).toBe(true);
  });
  it.each([undefined, 1, 0.9999999, 0.5, 0, NaN, Infinity, -0.1, 1.1])("checks coupled volume %s with tolerance", volume => {
    expect(isAudioStillCoupled(clips, [{ ...audio[0], volume }, audio[1]])).toBe(volume === undefined || volume === 1 || volume === 0.9999999);
  });
  it("treats only muted:true as independent, without overlooking changed geometry after unmute", () => {
    expect(isAudioStillCoupled(clips, audio)).toBe(true);
    expect(isAudioStillCoupled(clips, audio.map(a => ({ ...a, muted: false })))).toBe(true);
    expect(isAudioStillCoupled(clips, [{ ...audio[0], muted: true }, audio[1]])).toBe(false);
    expect(isAudioStillCoupled(clips, [{ ...audio[0], muted: false, timelineStart: 1 }, audio[1]])).toBe(false);
  });
  it.each([
    { timelineStart: 0.01 }, { sourceStart: 2.01 }, { sourceEnd: 6.99 },
    { sourceVideoId: "inserted" }, { sourceClipId: "other" }, { sourceEnd: NaN },
  ])("rejects independently changed geometry/source: %j", (change) => {
    expect(isAudioStillCoupled(clips, [{ ...audio[0], ...change }, audio[1]])).toBe(false);
  });
  it("rejects empty, missing, extra and duplicate segment assignments", () => {
    for (const segments of [[], [audio[0]], [...audio, audio[0]], [audio[0], audio[0]]]) {
      expect(isAudioStillCoupled(clips, segments)).toBe(false);
    }
  });
  it("tolerates arithmetic rounding and recomputes after restoring an undo snapshot", () => {
    const snapshot = audio.map(a => ({ ...a }));
    expect(isAudioStillCoupled(clips, audio.map(a => ({ ...a, timelineStart: a.timelineStart + 1e-8 })))).toBe(true);
    expect(isAudioStillCoupled(clips, [{ ...audio[0], timelineStart: 0.1 }, audio[1]])).toBe(false);
    expect(isAudioStillCoupled(clips, snapshot)).toBe(true);
  });
});

function expectCoupledAudio() {
  const track = screen.getByTestId("video-editor-audio-track");
  const videoTrack = screen.getByTestId("video-editor-timeline");
  expect(videoTrack.nextElementSibling).toBe(track);
  expect(track.style.width).toBe(videoTrack.style.width);
  const segments = track.querySelectorAll<HTMLElement>("[data-clip-id]");
  expect(segments.length).toBe(screen.getAllByTestId(/^video-editor-clip-/).length);
  for (const segment of segments) {
    const clip = screen.getByTestId(`video-editor-clip-${segment.dataset.clipId}`);
    expect(segment.style.left).toBe(clip.style.left);
    expect(segment.style.width).toBe(clip.style.width);
  }
  expect(track.querySelector("button, input, audio")).toBeNull();
}

const emptyEditorState = {
  timeline: { version: 0, clips: [] },
  renderStatus: "none",
  renderError: null,
  renderedVideoId: null,
};

let libraryVideos: unknown[];
let editorState: typeof emptyEditorState | {
  timeline: {
    version: number;
      clips: Array<{
        id: string;
        sourceId: string;
        sourceStart: number;
        sourceEnd: number;
        duration: number;
        speed?: number;
      }>;
      overlays?: Array<{
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
      }>;
      audioSegments?: EditorAudioSegment[];
      annotations?: Array<{ id: string; type: "arrow" | "circle" | "symbol" | "line"; symbol?: string; x: number; y: number; width: number; height: number; start: number; end: number; rotation: number; color?: string }>;
  };
  renderStatus: "none" | "processing" | "ready" | "failed";
  renderError: string | null;
  renderedVideoId: string | null;
};
let sourceLoadError: Error | null;

vi.mock("../api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe("VideoEditorModal multi-source preview", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    vi.mocked(loadAudioWaveformPeaks).mockReset().mockRejectedValue(new Error("No waveform in this test"));
    libraryVideos = [];
    editorState = emptyEditorState;
    sourceLoadError = null;
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    mockApiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/videos/original/editor" && !options) return Promise.resolve(editorState);
      if (path === "/api/videos/original/editor" && options?.method === "PUT") return Promise.resolve(undefined);
      if (path === "/api/videos/original/editor/render") return Promise.resolve(undefined);
      if (path === "/api/videos") return Promise.resolve(libraryVideos);
      if (path === "/api/videos/original/download") {
        return Promise.resolve({ downloadUrl: "https://media.example/original.mp4" });
      }
      if (path === "/api/videos/inserted/download") {
        return Promise.resolve({ downloadUrl: "https://media.example/inserted.mp4" });
      }
      if (path === "/api/videos/broken/download" && sourceLoadError) {
        return Promise.reject(sourceLoadError);
      }
      return Promise.reject(new Error(`Unexpected API call: ${path}`));
    });
  });

  it.each([0.5, 0.75, 1.25, 1.5, 2, 0, -1, NaN, Infinity])("blocks stored non-unit/invalid audio speed %s without overwriting it", async speed => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: { version: 1,
      clips: [{ id: "c", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
      audioSegments: [{ id: "a", sourceClipId: "c", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0, geometryLinked: false, speed }] } };
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByText(speed >= 0.5 && speed <= 2
      ? "Audio-Geschwindigkeit ungleich 1.0 wird noch nicht unterstützt."
      : "Clip-Geschwindigkeit muss endlich und zwischen 0.5 und 2.0 sein.");
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("button", { name: "Als neues Video rendern" })).toBeNull();
    view.unmount();
    expect(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT" || o?.method === "POST")).toEqual([]);
  });

  it.each([0.5, 0.75, 1.25, 1.5, 2, 0, -1, NaN, Infinity])("does not activate or overwrite stored speed %s", async speed => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: { version: 1,
      clips: [{ id: "c", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10, speed }] } };
    const rendered = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByText(speed >= 0.5 && speed <= 2
      ? "Clip-Geschwindigkeit ungleich 1.0 wird noch nicht unterstützt."
      : "Clip-Geschwindigkeit muss endlich und zwischen 0.5 und 2.0 sein.");
    expect(rendered.container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("button", { name: "Als neues Video rendern" })).toBeNull();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    rendered.unmount();
    expect(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT" || options?.method === "POST")).toEqual([]);
  });

  it("keeps explicit speed one in saved clips after loading and splitting", async () => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: { version: 1,
      clips: [{ id: "c", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10, speed: 1 }] } };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-clip-c");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Teilen" }));
    await waitFor(() => {
      const save = mockApiFetch.mock.calls.find(([, options]) => options?.method === "PUT");
      expect(save).toBeDefined();
      const clips = JSON.parse(save![1].body).clips;
      expect(clips).toHaveLength(2);
      expect(clips.every((clip: { speed?: number }) => clip.speed === 1)).toBe(true);
    });
  });

  it("reapplies nominal video speed on metadata, play, seek and undo without unmuting", async () => {
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-clip-clip-1");
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "preservesPitch", { configurable: true, writable: true, value: false });
    for (const event of ["loadedmetadata", "play", "seeking", "seeked"]) {
      video.playbackRate = 2;
      fireEvent(video, new Event(event));
      expect(video.playbackRate).toBe(1);
      expect(video.preservesPitch).toBe(true);
      expect(video.muted).toBe(true);
    }
    fireEvent.pause(video);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Teilen" }));
    video.playbackRate = 2;
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await waitFor(() => expect(video.playbackRate).toBe(1));
  });

  it("shows a waveform inside the real audio bar without changing selection, zoom or mute controls", async () => {
    vi.mocked(loadAudioWaveformPeaks).mockResolvedValue({ min: new Float32Array([0]), max: new Float32Array([0.5]),
      sampleRate: 1000, sampleCount: 10000, samplesPerPeak: 10000 });
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    const canvas = await screen.findByTestId("audio-waveform");
    const segment = canvas.parentElement!;
    expect(segment).toHaveAttribute("data-audio-id");
    expect(canvas).toHaveStyle({ pointerEvents: "none" });
    fireEvent.click(segment);
    expect(screen.getByRole("button", { name: "Tonanfang kürzen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tonende kürzen" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    expect(screen.getByRole("button", { name: "Ton an" })).toBeInTheDocument();
    expect(screen.getByTestId("audio-waveform")).toBeInTheDocument();
    expect(loadAudioWaveformPeaks).toHaveBeenCalledTimes(1);
  });

  it.each(["Teilen", "Video einfügen", "Clip löschen"])("blocks %s for independent audio without history or saves", async (action) => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [
        { id: "one", sourceId: "original", sourceStart: 0, sourceEnd: 5, duration: 5 },
        { id: "two", sourceId: "original", sourceStart: 5, sourceEnd: 10, duration: 5 },
      ],
      audioSegments: [
        { id: "a", sourceClipId: "one", sourceVideoId: "original", sourceStart: 0, sourceEnd: 4, timelineStart: 1 },
        { id: "b", sourceClipId: "two", sourceVideoId: "original", sourceStart: 5, sourceEnd: 10, timelineStart: 5 },
      ],
    } };
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    const first = await screen.findByTestId("video-editor-clip-one");
    fireEvent.click(first);
    const track = screen.getByTestId("video-editor-timeline");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    fireEvent.click(track, { clientX: 250 });
    const beforeAudio = screen.getByTestId("video-editor-audio-track").innerHTML;
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    mockApiFetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.getByText(/Die Tonspur wurde unabhängig vom Video bearbeitet/)).toBeInTheDocument();
    const warning = screen.getByTestId("video-editor-audio-guard-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Teilen" }));
    expect(warning.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Clip löschen" }));
    expect(screen.getAllByText(/Die Tonspur wurde unabhängig vom Video bearbeitet/)).toHaveLength(1);
    expect(screen.getAllByTestId(/^video-editor-clip-/)).toHaveLength(2);
    expect(screen.getByTestId("video-editor-audio-track").innerHTML).toBe(beforeAudio);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    view.unmount();
    expect(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
    expect(mockApiFetch.mock.calls.filter(([path]) => path === "/api/videos")).toHaveLength(0);
  });

  async function mountAudioTrim(short = false) {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [
        { id: "one", sourceId: "original", sourceStart: 0, sourceEnd: short ? 0.05 : 10, duration: short ? 0.05 : 10 },
        { id: "two", sourceId: "inserted", sourceStart: 30, sourceEnd: 40, duration: 10 },
      ],
    } };
    const view = render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />);
    const bar = await screen.findByTestId("video-editor-audio-one");
    const track = screen.getByTestId("video-editor-audio-track");
    const scroller = track.parentElement!;
    let width = 1000;
    vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => ({ width, left: -scroller.scrollLeft, top: 0 } as DOMRect));
    fireEvent.click(bar);
    const start = screen.getByRole("button", { name: "Tonanfang kürzen" });
    const end = screen.getByRole("button", { name: "Tonende kürzen" });
    return { ...view, bar, track, scroller, start, end, setWidth: (value: number) => { width = value; } };
  }

  it.each(["start", "end"] as const)("trims audio %s with draft isolation, one undo, save/reload and clip guard", async edge => {
    const ui = await mountAudioTrim();
    const other = screen.getByTestId("video-editor-audio-two").outerHTML;
    const clips = screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    play.mockClear();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
    pause.mockClear();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(ui[edge], { clientX: 500, pointerId: 1 });
    expect(pause.mock.instances).toContain(document.querySelector("video"));
    expect(pause.mock.instances).toContain(screen.getByTestId("video-editor-audio-preview"));
    fireEvent.pointerMove(document, { clientX: edge === "start" ? 600 : 400, pointerId: 1 });
    expect(ui.bar.style.width).toBe("40%");
    expect(ui.bar).toHaveAttribute("data-source-start", "0");
    expect(ui.bar).toHaveAttribute("data-source-end", "10");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
    fireEvent.pointerUp(document, { pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    const expected = { geometryLinked: false, speed: 1, id: "audio:one", sourceClipId: "one", sourceVideoId: "original",
      sourceStart: edge === "start" ? 2 : 0, sourceEnd: edge === "end" ? 8 : 10, timelineStart: edge === "start" ? 2 : 0 };
    expect(ui.bar).toHaveAttribute("data-source-start", String(expected.sourceStart));
    expect(ui.bar).toHaveAttribute("data-source-end", String(expected.sourceEnd));
    expect(ui.bar).toHaveAttribute("data-timeline-start", String(expected.timelineStart));
    expect(screen.getByTestId("video-editor-audio-two").outerHTML).toBe(other);
    expect(screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML)).toEqual(clips);
    expect(play).not.toHaveBeenCalled();
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments[0]).toEqual(expected);
    expect(payload.audioSegments[1]).toMatchObject({ sourceVideoId: "inserted", sourceStart: 30, sourceEnd: 40, timelineStart: 10 });
    for (const action of ["Teilen", "Video einfügen", "Clip löschen"]) {
      if (action === "Clip löschen") fireEvent.click(screen.getByTestId("video-editor-clip-one"));
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByText(/Die Tonspur wurde unabhängig/)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ui.bar).toHaveAttribute("data-source-start", "0");
    expect(ui.bar).toHaveAttribute("data-source-end", "10");
    expect(ui.bar).toHaveAttribute("data-timeline-start", "0");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([path]) => path === "/api/videos")).toBe(true));
    ui.unmount();
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />);
    expect(await screen.findByTestId("video-editor-audio-one")).toHaveAttribute("data-source-end", String(expected.sourceEnd));
    expect(screen.getByTestId("video-editor-audio-one")).toHaveAttribute("data-timeline-start", String(expected.timelineStart));
  });

  it.each(["click", "cancel", "return", "outward", "zoom", "geometry", "unmount", "undo"])("discards audio resize on %s without save/history", async reason => {
    const ui = await mountAudioTrim();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(ui.end, { clientX: 500, pointerId: 1 });
    if (reason !== "click") fireEvent.pointerMove(document, { clientX: reason === "outward" ? 700 : 400, pointerId: 1 });
    if (reason === "return") fireEvent.pointerMove(document, { clientX: 500, pointerId: 1 });
    if (reason === "cancel") fireEvent.pointerCancel(document, { pointerId: 1 });
    if (reason === "zoom") fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    if (reason === "geometry") ui.setWidth(2000);
    if (reason === "unmount") ui.unmount();
    // A real earlier action makes Undo available without altering audio.
    if (reason === "undo") {
      fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
      fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    }
    fireEvent.pointerUp(document, { pointerId: 1 });
    if (reason !== "unmount") {
      expect(ui.bar).toHaveAttribute("data-source-end", "10");
      expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
      ui.unmount();
    }
    if (reason !== "undo") expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
  });

  it.each(["start", "end"] as const)("clamps %s to 100 ms and disallows later re-extension", async edge => {
    const ui = await mountAudioTrim();
    fireEvent.pointerDown(ui[edge], { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: edge === "start" ? 5000 : -5000, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(Number(ui.bar.dataset.sourceEnd) - Number(ui.bar.dataset.sourceStart)).toBeCloseTo(0.1, 8);
    const before = ui.bar.outerHTML;
    fireEvent.pointerDown(ui[edge], { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: edge === "start" ? -5000 : 5000, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar.outerHTML).toBe(before);
  });

  it("keeps sub-100ms legacy audio unchanged and handles disabled", async () => {
    const ui = await mountAudioTrim(true);
    expect(ui.start).toBeDisabled();
    expect(ui.end).toBeDisabled();
    expect(ui.bar).toHaveAttribute("data-source-end", "0.05");
  });

  it("uses measured zoom width and includes scroll delta without double-counting zoom", async () => {
    const ui = await mountAudioTrim();
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    ui.setWidth(2000);
    fireEvent.pointerDown(ui.start, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    ui.scroller.scrollLeft = 100;
    fireEvent.scroll(ui.scroller);
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-source-start", "2");
    expect(ui.bar).toHaveAttribute("data-timeline-start", "2");
    expect(Number(ui.bar.dataset.timelineStart) + Number(ui.bar.dataset.sourceEnd) - Number(ui.bar.dataset.sourceStart)).toBe(10);
  });

  it("keeps drafts out of an already pending save and does not resync audio on pointermove", async () => {
    const ui = await mountAudioTrim();
    fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    const sync = vi.spyOn(EditorAudioPreview.prototype, "sync");
    fireEvent.pointerDown(ui.start, { clientX: 500, pointerId: 1 });
    sync.mockClear();
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 650, pointerId: 1 });
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 10, timelineStart: 0 });
    expect(sync).not.toHaveBeenCalled();
    fireEvent.pointerCancel(document, { pointerId: 1 });
    expect(ui.bar.style.left).toBe("0%");
    sync.mockRestore();
  });

  it("discards a stale audio gesture when a coupled clip action changes the segment state", async () => {
    const ui = await mountAudioTrim();
    fireEvent.pointerDown(ui.end, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 });
    fireEvent.click(screen.getByTestId("video-editor-clip-two"));
    fireEvent.click(screen.getByRole("button", { name: "Clip löschen" }));
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-source-end", "10");
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(2);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  const moveAudio = [
    { id: "a", sourceClipId: "one", sourceVideoId: "original", sourceStart: 2, sourceEnd: 6, timelineStart: 4 },
    { id: "b", sourceClipId: "two", sourceVideoId: "inserted", sourceStart: 30, sourceEnd: 34, timelineStart: 12 },
  ];
  async function mountAudioMove(segments: EditorAudioSegment[] = moveAudio) {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [
        { id: "one", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 },
        { id: "two", sourceId: "inserted", sourceStart: 30, sourceEnd: 40, duration: 10 },
      ], audioSegments: segments.map(item => ({ ...item })),
    } };
    // Finish async editor-state restoration and its gesture-cancelling effects
    // before pointerDown. Finding the segment alone only guarantees DOM presence.
    const view = await act(async () => render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />));
    const bar = await screen.findByTestId("video-editor-audio-one");
    const track = screen.getByTestId("video-editor-audio-track");
    const scroller = track.parentElement!;
    let width = 1000;
    vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => ({ width, left: -scroller.scrollLeft, top: 0 } as DOMRect));
    return { ...view, bar, track, scroller, setWidth: (w: number) => { width = w; } };
  }

  it.each([true, false, undefined].flatMap(geometryLinked =>
    (["move", "start", "end"] as const).map(edge => ({ geometryLinked, edge }))))(
    "commits detachment on $edge and restores $geometryLinked on undo", async ({ geometryLinked, edge }) => {
      const original = { ...moveAudio[0], geometryLinked };
      const ui = await mountAudioMove([original, moveAudio[1]]);
      fireEvent.click(ui.bar);
      const handle = edge === "move" ? ui.bar : screen.getByRole("button", { name: edge === "start" ? "Tonanfang kürzen" : "Tonende kürzen" });
      fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: edge === "end" ? 450 : 550, pointerId: 1 });
      fireEvent.pointerUp(document, { pointerId: 1 });
      await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
      const payload = JSON.parse(mockApiFetch.mock.calls.find(([, o]) => o?.method === "PUT")![1].body);
      expect(payload.audioSegments[0].geometryLinked).toBe(false);
      expect(payload.audioSegments[0].speed).toBe(1);
      expect(payload.audioSegments[1]).toEqual(moveAudio[1]);
      fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
      mockApiFetch.mockClear();
      ui.unmount();
      const restored = JSON.parse(mockApiFetch.mock.calls.find(([, o]) => o?.method === "PUT")![1].body).audioSegments[0];
      expect(restored).toEqual(JSON.parse(JSON.stringify(original)));
      expect(Object.hasOwn(restored, "geometryLinked")).toBe(geometryLinked !== undefined);
    });

  it.each([true, false, undefined].flatMap(geometryLinked =>
    ["cancel", "unchanged", "trim-unchanged", "mute", "volume"].map(action => ({ geometryLinked, action }))))(
    "retains linkage $geometryLinked through $action and save/reload", async ({ geometryLinked, action }) => {
      const original = { ...moveAudio[0], geometryLinked, speed: 1 };
      const ui = await mountAudioMove([original, moveAudio[1]]);
      fireEvent.click(ui.bar);
      if (action === "mute") fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
      else if (action === "volume") {
        const slider = screen.getByRole("slider", { name: "Audio-Lautstärke" });
        fireEvent.pointerDown(slider, { pointerId: 1 });
        fireEvent.change(slider, { target: { value: "50" } });
        fireEvent.pointerUp(document, { pointerId: 1 });
      } else {
        const handle = action === "trim-unchanged" ? screen.getByRole("button", { name: "Tonende kürzen" }) : ui.bar;
        fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
        if (action === "cancel") {
          fireEvent.pointerMove(document, { clientX: 550, pointerId: 1 });
          fireEvent.pointerCancel(document, { pointerId: 1 });
        } else {
          fireEvent.pointerMove(document, { clientX: 500, pointerId: 1 });
          fireEvent.pointerUp(document, { pointerId: 1 });
        }
        expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
      }
      // An unrelated edit makes the save observable even for unchanged gestures.
      fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
      ui.unmount();
      const payload = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
      expect(payload.audioSegments[0].geometryLinked).toBe(geometryLinked);
      expect(payload.audioSegments[0].speed).toBe(1);
      expect(Object.hasOwn(payload.audioSegments[0], "geometryLinked")).toBe(geometryLinked !== undefined);
      editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
      const reloaded = await act(async () => render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />));
      fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
      mockApiFetch.mockClear();
      reloaded.unmount();
      expect(JSON.parse(mockApiFetch.mock.calls.find(([, o]) => o?.method === "PUT")![1].body).audioSegments).toEqual(payload.audioSegments);
    });

  it.each([-100, 100])("moves audio by %s px, commits only timelineStart, saves/reloads and undoes once", async dx => {
    const ui = await mountAudioMove();
    const other = screen.getByTestId("video-editor-audio-two").outerHTML;
    const clips = screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML);
    const video = document.querySelector("video")!;
    const time = video.currentTime;
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause"); pause.mockClear();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play"); play.mockClear();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    expect(ui.bar.style.cursor).toBe("grabbing");
    expect(pause.mock.instances).toContain(video);
    expect(pause.mock.instances).toContain(screen.getByTestId("video-editor-audio-preview"));
    fireEvent.pointerMove(document, { clientX: 500 + dx, pointerId: 1 });
    expect(ui.bar.style.left).toBe(`${(4 + dx / 50) * 5}%`);
    expect(ui.bar).toHaveAttribute("data-timeline-start", "4");
    expect(ui.bar).toHaveAttribute("data-source-start", "2");
    expect(ui.bar).toHaveAttribute("data-source-end", "6");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
    fireEvent.pointerUp(document, { pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(video.currentTime).toBe(time);
    expect(play).not.toHaveBeenCalled();
    expect(ui.bar.style.cursor).toBe("grab");
    expect(screen.getByTestId("video-editor-audio-two").outerHTML).toBe(other);
    expect(screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML)).toEqual(clips);
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual([{ ...moveAudio[0], timelineStart: 4 + dx / 50, geometryLinked: false, speed: 1 }, moveAudio[1]]);
    for (const action of ["Teilen", "Video einfügen", "Clip löschen"]) {
      if (action === "Clip löschen") fireEvent.click(screen.getByTestId("video-editor-clip-one"));
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ui.bar).toHaveAttribute("data-timeline-start", "4");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    ui.unmount();
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />);
    expect(await screen.findByTestId("video-editor-audio-one")).toHaveAttribute("data-timeline-start", String(4 + dx / 50));
  });

  it.each([
    { target: "one", dx: -10000, result: 0 },
    { target: "one", dx: 10000, result: 8 },
    { target: "two", dx: -10000, result: 8 },
    { target: "two", dx: 10000, result: 16 },
  ])("clamps $target to $result without crossing neighbours in an unsorted array", async ({ target, dx, result }) => {
    const ui = await mountAudioMove([...moveAudio].reverse());
    const bar = screen.getByTestId(`video-editor-audio-${target}`);
    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 500 + dx, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(bar).toHaveAttribute("data-timeline-start", String(result));
    expect(Array.from(ui.track.children).map(e => e.getAttribute("data-audio-id"))).toEqual(["b", "a"]);
  });

  it("includes zoom width and horizontal scrolling for move", async () => {
    const ui = await mountAudioMove();
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    ui.setWidth(2000);
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    ui.scroller.scrollLeft = 100;
    fireEvent.scroll(ui.scroller);
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "6");
  });

  it.each(["click", "cancel", "return", "zoom", "geometry", "state", "undo", "unmount"])("discards move on %s without an audio commit", async reason => {
    const ui = await mountAudioMove();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    if (reason !== "click") fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    if (reason === "cancel") fireEvent.pointerCancel(document, { pointerId: 1 });
    if (reason === "return") fireEvent.pointerMove(document, { clientX: 500, pointerId: 1 });
    if (reason === "zoom") fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    if (reason === "geometry") ui.setWidth(2000);
    if (reason === "state" || reason === "undo") {
      fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
      if (reason === "undo") fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    }
    if (reason === "unmount") ui.unmount();
    fireEvent.pointerUp(document, { pointerId: 1 });
    if (reason !== "unmount") {
      expect(ui.bar).toHaveAttribute("data-timeline-start", "4");
      if (reason !== "state") expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
      ui.unmount();
    }
    if (!["state", "undo"].includes(reason)) expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
  });

  it("does not move or save a packed track and keeps clip actions available", async () => {
    const ui = await mountAudioTrim();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 10000, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "0");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([p]) => p === "/api/videos")).toBe(true));
  });

  it("moves sub-100ms audio but disabled resize handles never start move", async () => {
    const ui = await mountAudioMove([{ ...moveAudio[0], sourceEnd: 2.05 }]);
    fireEvent.click(ui.bar);
    const handle = screen.getByRole("button", { name: "Tonanfang kürzen" });
    expect(handle).toBeDisabled();
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "4");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "6");
    expect(ui.bar).toHaveAttribute("data-source-end", "2.05");
  });

  it("keeps protection after undoing a move, and releases it only after undoing the preceding trim", async () => {
    const ui = await mountAudioTrim();
    fireEvent.pointerDown(ui.end, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-source-end", "8");
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 550, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "1");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ui.bar).toHaveAttribute("data-timeline-start", "0");
    expect(ui.bar).toHaveAttribute("data-source-end", "8");
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ui.bar).toHaveAttribute("data-source-end", "10");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([p]) => p === "/api/videos")).toBe(true));
  });

  it("never saves a move draft or resyncs preview while an earlier save is pending", async () => {
    const ui = await mountAudioMove();
    fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    const sync = vi.spyOn(EditorAudioPreview.prototype, "sync");
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    sync.mockClear();
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual(moveAudio);
    expect(sync).not.toHaveBeenCalled();
    fireEvent.pointerCancel(document, { pointerId: 1 });
    sync.mockRestore();
  });

  it.each([
    { sourceEnd: 2 }, { sourceEnd: 1 }, { timelineStart: -1 },
    { timelineStart: 18 }, { timelineStart: 10 },
  ])("rejects invalid move geometry rather than repairing it: %j", async change => {
    const ui = await mountAudioMove([{ ...moveAudio[0], ...change }, moveAudio[1]]);
    const before = ui.bar.dataset.timelineStart;
    fireEvent.pointerDown(ui.bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", before);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  it.each([false, true])("deletes only the selected audio ID, preserves neighbours, saves/reloads and undoes (same source: %s)", async sameSource => {
    const segments = [moveAudio[0], { ...moveAudio[1], sourceVideoId: sameSource ? "original" : "inserted" }];
    const ui = await mountAudioMove(segments);
    expect(screen.queryByRole("button", { name: "Ton löschen" })).not.toBeInTheDocument();
    const other = screen.getByTestId("video-editor-audio-two");
    const otherData = { ...other.dataset };
    const otherStyle = other.getAttribute("style");
    const clips = screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML);
    fireEvent.click(ui.bar);
    const button = screen.getByRole("button", { name: "Ton löschen" });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause"); pause.mockClear();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play"); play.mockClear();
    mockApiFetch.mockClear();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByTestId("video-editor-audio-one")).not.toBeInTheDocument();
    expect({ ...screen.getByTestId("video-editor-audio-two").dataset }).toEqual(otherData);
    expect(screen.getByTestId("video-editor-audio-two").getAttribute("style")).toBe(otherStyle);
    expect(screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML)).toEqual(clips);
    expect(screen.queryByRole("button", { name: "Ton löschen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tonanfang kürzen" })).not.toBeInTheDocument();
    expect(pause.mock.instances).toContain(document.querySelector("video"));
    expect(pause.mock.instances).toContain(screen.getByTestId("video-editor-audio-preview"));
    expect(play).not.toHaveBeenCalled();
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual([segments[1]]);
    const clip = screen.getByTestId("video-editor-clip-one");
    vi.spyOn(clip.parentElement!, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    await act(async () => { fireEvent.click(clip, { clientX: 100 }); });
    fireEvent.click(screen.getByRole("button", { name: "Clip löschen" }));
    expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^video-editor-clip-/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    expect(Array.from(ui.track.children).map(e => e.getAttribute("data-audio-id"))).toEqual(["a", "b"]);
    mockApiFetch.mockClear();
    ui.unmount();
    const restored = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(restored.audioSegments).toEqual(segments);
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-audio-two");
    expect(screen.queryByTestId("video-editor-audio-one")).not.toBeInTheDocument();
  });

  it.each(["move", "start", "end"] as const)("blocks audio delete immediately during %s and preserves the active gesture", async mode => {
    const ui = await mountAudioMove();
    fireEvent.click(ui.bar);
    const button = screen.getByRole("button", { name: "Ton löschen" });
    const target = mode === "move" ? ui.bar : screen.getByRole("button", { name: mode === "start" ? "Tonanfang kürzen" : "Tonende kürzen" });
    fireEvent.pointerDown(target, { clientX: 500, pointerId: 1 });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(ui.track.children).toHaveLength(2);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.pointerMove(document, { clientX: mode === "end" ? 450 : 550, pointerId: 1 });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(button).toBeEnabled();
    expect(ui.track.children).toHaveLength(2);
    expect(ui.bar).toHaveAttribute(mode === "end" ? "data-source-end" : mode === "start" ? "data-source-start" : "data-timeline-start", mode === "end" ? "5" : mode === "start" ? "3" : "5");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  it("hides deletion for stale selection after the selected audio disappears through a coupled clip edit", async () => {
    const ui = await mountAudioTrim();
    const oldButton = screen.getByRole("button", { name: "Ton löschen" });
    const oldToggle = screen.getByRole("button", { name: "Ton aus" });
    const clip = screen.getByTestId("video-editor-clip-one");
    vi.spyOn(clip.parentElement!, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    await act(async () => { fireEvent.click(clip, { clientX: 100 }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clip löschen" })); });
    expect(screen.queryByRole("button", { name: "Ton löschen" })).not.toBeInTheDocument();
    fireEvent.click(oldButton);
    expect(screen.queryByRole("button", { name: "Ton aus" })).not.toBeInTheDocument();
    fireEvent.click(oldToggle);
    expect(ui.track.children).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" })); });
    expect(ui.track.children).toHaveLength(2);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  it("preserves explicit [] after deleting the last segment, saves/reloads silence and restores coupling with undo", async () => {
    const ui = await mountAudioPreview([{ id: "only", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0 }]);
    fireEvent.click(screen.getByTestId("video-editor-audio-clip-1"));
    fireEvent.click(screen.getByRole("button", { name: "Ton löschen" }));
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(0);
    for (const action of ["Teilen", "Video einfügen"]) {
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    }
    await act(async () => { fireEvent.click(screen.getByTestId("video-editor-clip-clip-1")); });
    expect(screen.getByRole("button", { name: "Clip löschen" })).toBeDisabled();
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual([]);
    const audioPlay = vi.spyOn(ui.audio, "play"); audioPlay.mockClear();
    ui.video.currentTime = 5;
    fireEvent.play(ui.video);
    expect(audioPlay).not.toHaveBeenCalled();
    expect(ui.video.muted).toBe(true);
    fireEvent.pause(ui.video);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByTestId("video-editor-audio-clip-1")).toHaveAttribute("data-audio-id", "only");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([p]) => p === "/api/videos")).toBe(true));
    ui.unmount();
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-clip-clip-1");
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(0);
    const audio = screen.getByTestId("video-editor-audio-preview") as HTMLAudioElement;
    const play = vi.spyOn(audio, "play");
    fireEvent.play(document.querySelector("video")!);
    expect(play).not.toHaveBeenCalled();
    expect(document.querySelector("video")!.muted).toBe(true);
  });

  it("plays remaining audio normally but stays silent in the deleted segment interval", async () => {
    const ui = await mountAudioPreview([
      { id: "first", sourceVideoId: "original", sourceStart: 0, sourceEnd: 4, timelineStart: 0 },
      { id: "second", sourceVideoId: "inserted", sourceStart: 30, sourceEnd: 34, timelineStart: 6 },
    ]);
    const first = screen.getByTestId("video-editor-audio-track").querySelector<HTMLElement>('[data-audio-id="first"]')!;
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Ton löschen" }));
    const play = vi.spyOn(ui.audio, "play"); play.mockClear();
    ui.video.currentTime = 2;
    fireEvent.play(ui.video);
    expect(play).not.toHaveBeenCalled();
    ui.video.currentTime = 7;
    fireEvent.timeUpdate(ui.video);
    await waitFor(() => expect(ui.audio.src).toContain("inserted.mp4"));
    fireEvent.loadedMetadata(ui.audio);
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(ui.audio.currentTime).toBe(31);
    expect(ui.video.muted).toBe(true);
  });

  it.each([true, false])("toggles selected audio only, persists/reloads muted:%s and restores exact undo state", async muted => {
    const ui = await mountAudioMove([moveAudio[0], { ...moveAudio[1], sourceVideoId: "original" }]);
    expect(screen.queryByRole("button", { name: "Ton aus" })).not.toBeInTheDocument();
    fireEvent.click(ui.bar);
    const clips = screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML);
    const other = screen.getByTestId("video-editor-audio-two").outerHTML;
    if (!muted) fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause"); pause.mockClear();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play"); play.mockClear();
    mockApiFetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: muted ? "Ton aus" : "Ton an" }));
    expect(pause.mock.instances).toContain(document.querySelector("video"));
    expect(pause.mock.instances).toContain(screen.getByTestId("video-editor-audio-preview"));
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: muted ? "Ton an" : "Ton aus" })).toBeEnabled();
    expect(ui.bar.textContent?.includes("stumm")).toBe(muted);
    expect(screen.getByTestId("video-editor-audio-two").outerHTML).toBe(other);
    expect(screen.getAllByTestId(/^video-editor-clip-/).map(e => e.outerHTML)).toEqual(clips);
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual([{ ...moveAudio[0], muted }, { ...moveAudio[1], sourceVideoId: "original" }]);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: muted ? "Ton aus" : "Ton an" })).toBeEnabled();
    if (!muted) fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    mockApiFetch.mockClear();
    ui.unmount();
    expect(JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body).audioSegments[0]).toEqual(moveAudio[0]);
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={20} onClose={vi.fn()} />);
    const bar = await screen.findByTestId("video-editor-audio-one");
    fireEvent.click(bar);
    expect(screen.getByRole("button", { name: muted ? "Ton an" : "Ton aus" })).toBeEnabled();
    expect(bar.textContent?.includes("stumm")).toBe(muted);
  });

  it.each(["move", "start", "end"] as const)("locks mute during %s from pointerdown and retains mute through editing/deletion", async mode => {
    const ui = await mountAudioMove();
    fireEvent.click(ui.bar);
    fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    const toggle = screen.getByRole("button", { name: "Ton an" });
    const target = mode === "move" ? ui.bar : screen.getByRole("button", { name: mode === "start" ? "Tonanfang kürzen" : "Tonende kürzen" });
    fireEvent.pointerDown(target, { clientX: 500, pointerId: 1 });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.pointerMove(document, { clientX: mode === "end" ? 450 : 550, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(toggle).toBeEnabled();
    expect(ui.bar).toHaveTextContent("stumm");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    expect(JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body).audioSegments[0].muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ton löschen" }));
    expect(screen.queryByTestId("video-editor-audio-one")).not.toBeInTheDocument();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    expect(screen.getByTestId("video-editor-audio-one")).not.toHaveTextContent("stumm");
  });

  it("protects coupled clip edits after mute and lifts the guard on unmute or undo", async () => {
    const ui = await mountAudioTrim();
    fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    const clip = screen.getByTestId("video-editor-clip-one");
    vi.spyOn(clip.parentElement!, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    await act(async () => { fireEvent.click(clip, { clientX: 100 }); });
    for (const action of ["Teilen", "Video einfügen", "Clip löschen"]) {
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    }
    expect(ui.track.children).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Ton an" }));
    fireEvent.click(screen.getByRole("button", { name: "Teilen" }));
    expect(screen.getAllByTestId(/^video-editor-clip-/)).toHaveLength(3);
    for (let i = 0; i < 3; i++) await act(async () => { fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" })); });
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Video einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([p]) => p === "/api/videos")).toBe(true));
  });

  it("keeps the only muted segment visible while play stays silent and video remains muted", async () => {
    const ui = await mountAudioPreview([{ id: "only", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0 }]);
    fireEvent.click(screen.getByTestId("video-editor-audio-clip-1"));
    fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    const play = vi.spyOn(ui.audio, "play"); play.mockClear();
    fireEvent.play(ui.video);
    expect(play).not.toHaveBeenCalled();
    expect(ui.video.muted).toBe(true);
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ton an" }));
    expect(play).not.toHaveBeenCalled();
    fireEvent.play(ui.video);
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it.each([0, 0.5, 1])("commits one volume transaction, saves/reloads %s, and undoes without restarting transport", async volume => {
    const segment = { id: "only", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0, volume: 0.4 };
    const ui = await mountAudioPreview([segment]);
    fireEvent.click(screen.getByTestId("video-editor-audio-clip-1"));
    const slider = screen.getByRole("slider", { name: "Audio-Lautstärke" });
    expect(slider).toHaveValue("40");
    fireEvent.play(ui.video);
    await act(async () => {});
    const seek = vi.spyOn(ui.audio, "currentTime", "set");
    const play = vi.spyOn(ui.audio, "play"); play.mockClear();
    const pause = vi.spyOn(ui.audio, "pause"); pause.mockClear();
    const load = vi.spyOn(ui.audio, "load"); load.mockClear();
    mockApiFetch.mockClear();
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: String(volume * 100) } });
    expect(ui.audio.volume).toBe(volume);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(ui.audio.volume).toBe(volume);
    expect(seek).not.toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(payload.audioSegments).toEqual([{ ...segment, sourceClipId: "clip-1", volume }]);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(slider).toHaveValue("40"); expect(ui.audio.volume).toBe(0.4);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    ui.unmount();
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: payload };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("video-editor-audio-clip-1"));
    expect(screen.getByRole("slider", { name: "Audio-Lautstärke" })).toHaveValue(String(volume * 100));
  });

  it.each(["cancel", "unchanged", "keyboard"])("handles volume %s as one transaction or no change", async mode => {
    const ui = await mountAudioPreview([{ id: "a", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0 }]);
    fireEvent.click(screen.getByTestId("video-editor-audio-clip-1"));
    const slider = screen.getByRole("slider", { name: "Audio-Lautstärke" });
    mockApiFetch.mockClear();
    if (mode === "keyboard") fireEvent.keyDown(slider, { key: "ArrowLeft" });
    else fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: "30" } });
    if (mode === "cancel") fireEvent.pointerCancel(document, { pointerId: 1 });
    if (mode === "unchanged") {
      fireEvent.change(slider, { target: { value: "100" } });
      fireEvent.pointerUp(document, { pointerId: 1 });
    }
    if (mode === "keyboard") {
      fireEvent.keyDown(slider, { key: "ArrowLeft", repeat: true });
      fireEvent.change(slider, { target: { value: "29" } });
      fireEvent.keyUp(slider, { key: "ArrowLeft" });
      expect(slider).toHaveValue("29");
      fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    }
    expect(slider).toHaveValue("100"); expect(ui.audio.volume).toBe(1);
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT")).toHaveLength(0);
  });

  it("blocks coupled edits for volume changes and restores coupling at 100 percent", async () => {
    const ui = await mountAudioTrim();
    const slider = screen.getByRole("slider", { name: "Audio-Lautstärke" });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.pointerUp(document, { pointerId: 1 });
    const clip = screen.getByTestId("video-editor-clip-one");
    vi.spyOn(clip.parentElement!, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    await act(async () => { fireEvent.click(clip, { clientX: 100 }); });
    for (const action of ["Teilen", "Video einfügen", "Clip löschen"]) {
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByTestId("video-editor-audio-guard-warning")).toBeInTheDocument();
    }
    expect(ui.track.children).toHaveLength(2);
    fireEvent.pointerDown(slider, { pointerId: 2 });
    fireEvent.change(slider, { target: { value: "100" } });
    fireEvent.pointerUp(document, { pointerId: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Teilen" }));
    expect(screen.getAllByTestId(/^video-editor-clip-/)).toHaveLength(3);
  });

  it.each(["move", "start", "end"] as const)("mutually excludes volume and %s, retaining gain through audio operations", async mode => {
    const ui = await mountAudioMove(); fireEvent.click(ui.bar);
    const slider = screen.getByRole("slider", { name: "Audio-Lautstärke" });
    const target = mode === "move" ? ui.bar : screen.getByRole("button", { name: mode === "start" ? "Tonanfang kürzen" : "Tonende kürzen" });
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 500 });
    expect(slider).toBeDisabled();
    fireEvent.change(slider, { target: { value: "30" } });
    fireEvent.pointerCancel(document, { pointerId: 1 });
    expect(slider).toHaveValue("100");
    fireEvent.pointerDown(slider, { pointerId: 2 });
    fireEvent.change(slider, { target: { value: "50" } });
    expect(screen.getByRole("button", { name: "Ton aus" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ton löschen" })).toBeDisabled();
    fireEvent.pointerDown(target, { pointerId: 3, clientX: 500 });
    fireEvent.pointerMove(document, { pointerId: 3, clientX: 550 });
    fireEvent.pointerUp(document, { pointerId: 3 });
    expect(ui.bar).toHaveAttribute("data-timeline-start", "4");
    fireEvent.pointerUp(document, { pointerId: 2 });
    fireEvent.pointerDown(target, { pointerId: 4, clientX: 500 });
    fireEvent.pointerMove(document, { pointerId: 4, clientX: mode === "end" ? 450 : 550 });
    fireEvent.pointerUp(document, { pointerId: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Ton aus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ton an" }));
    expect(slider).toHaveValue("50");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const saved = JSON.parse(mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT")![1].body);
    expect(saved.audioSegments[0].volume).toBe(0.5); expect(saved.audioSegments[1]).toEqual(moveAudio[1]);
    fireEvent.click(screen.getByRole("button", { name: "Ton löschen" }));
    expect(screen.queryByTestId("video-editor-audio-one")).not.toBeInTheDocument();
  });

  async function mountAudioPreview(segments: Array<{ id: string; sourceVideoId: string; sourceStart: number; sourceEnd: number; timelineStart: number; muted?: boolean; volume?: number }>) {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
      audioSegments: segments.map((segment) => ({ ...segment, sourceClipId: "clip-1" })),
    } };
    const onClose = vi.fn();
    const result = render(<VideoEditorModal videoId="original" duration={10} onClose={onClose} />);
    await waitFor(() => expect(document.querySelector("video")?.src).toContain("original.mp4"));
    const video = document.querySelector("video")!;
    const audio = screen.getByTestId("video-editor-audio-preview") as HTMLAudioElement;
    if (segments.length) await waitFor(() => expect(audio.src).not.toBe(""));
    Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
    fireEvent.loadedMetadata(audio);
    return { ...result, video, audio, onClose };
  }

  it("checks drift from the existing timer without changing video, transport or persisted segments and cleans up", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const check = vi.spyOn(EditorAudioPreview.prototype, "checkDrift");
    const clearTimer = vi.spyOn(window, "clearInterval");
    try {
      const { video, audio, unmount } = await mountAudioPreview([
        { id: "a", sourceVideoId: "original", sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
      ]);
      for (const media of [video, audio]) {
        Object.defineProperty(media, "paused", { configurable: true, value: false });
        Object.defineProperty(media, "readyState", { configurable: true, value: 4 });
      }
      video.currentTime = 1;
      fireEvent.play(video);
      fireEvent.playing(audio);
      audio.currentTime = 11.4;
      const writeVideoTime = vi.spyOn(video, "currentTime", "set");
      const source = audio.src;
      const plays = vi.mocked(audio.play).mock.calls.length;
      const pauses = vi.mocked(audio.pause).mock.calls.length;
      const loads = vi.mocked(audio.load).mock.calls.length;
      const saves = mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").length;
      await waitFor(() => expect(audio.currentTime).toBe(11));
      expect(check).toHaveBeenCalled();
      expect(writeVideoTime).not.toHaveBeenCalled();
      expect(video.currentTime).toBe(1);
      expect(video.muted).toBe(true);
      expect(audio.src).toBe(source);
      expect(audio.playbackRate).toBe(1);
      expect(audio.play).toHaveBeenCalledTimes(plays);
      expect(audio.pause).toHaveBeenCalledTimes(pauses);
      expect(audio.load).toHaveBeenCalledTimes(loads);
      expect(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(saves);
      unmount();
      expect(clearTimer).toHaveBeenCalled();
      const checks = check.mock.calls.length;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      expect(check).toHaveBeenCalledTimes(checks);
    } finally {
      hidden.mockRestore(); check.mockRestore(); clearTimer.mockRestore();
    }
  });

  it("blocks drift for paused, seeking, ended, unready and buffering video", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const check = vi.spyOn(EditorAudioPreview.prototype, "checkDrift");
    try {
      const { video, audio } = await mountAudioPreview([
        { id: "a", sourceVideoId: "original", sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
      ]);
      Object.defineProperty(audio, "paused", { configurable: true, value: false });
      Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
      const state = { paused: false, seeking: false, ended: false, readyState: 4 };
      for (const key of Object.keys(state) as Array<keyof typeof state>) {
        Object.defineProperty(video, key, { configurable: true, get: () => state[key] });
      }
      fireEvent.play(video); fireEvent.playing(audio);
      await waitFor(() => expect(check).toHaveBeenCalled());
      const preview = check.mock.contexts[0] as EditorAudioPreview;
      const write = vi.spyOn(audio, "currentTime", "set");
      let now = performance.now() + 1000;
      for (const key of ["paused", "seeking", "ended", "readyState"] as const) {
        Object.assign(state, { [key]: key === "readyState" ? 2 : true });
        audio.currentTime = 10.5; write.mockClear();
        preview.checkDrift(now); now += 250;
        expect(write).not.toHaveBeenCalled();
        Object.assign(state, { [key]: key === "readyState" ? 4 : false });
      }
      fireEvent.waiting(video);
      audio.currentTime = 10.5; write.mockClear();
      preview.checkDrift(now);
      expect(write).not.toHaveBeenCalled();
    } finally { hidden.mockRestore(); check.mockRestore(); }
  });

  it("plays independent audio, keeps native video permanently muted and pauses both", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "independent", sourceVideoId: "inserted", sourceStart: 12, sourceEnd: 22, timelineStart: 0 },
    ]);
    expect(video.muted).toBe(true);
    video.muted = false;
    video.volume = 1;
    fireEvent.volumeChange(video);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
    video.currentTime = 1.25;
    fireEvent.play(video);
    expect(audio.src).toContain("inserted.mp4");
    expect(video.src).toContain("original.mp4");
    expect(audio.currentTime).toBe(13.25);
    expect(vi.mocked(audio.play).mock.contexts).toContain(audio);
    fireEvent.pause(video);
    expect(vi.mocked(audio.pause).mock.contexts).toContain(audio);
    const calls = vi.mocked(audio.play).mock.calls.length;
    fireEvent.loadedMetadata(audio);
    expect(vi.mocked(audio.play).mock.calls.length).toBe(calls);
  });

  it("native seeks select the audio segment rather than the visible source", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 4, sourceEnd: 6, timelineStart: 0 },
      { id: "b", sourceVideoId: "inserted", sourceStart: 20, sourceEnd: 28, timelineStart: 2 },
    ]);
    fireEvent.play(video);
    fireEvent.seeking(video);
    video.currentTime = 3;
    fireEvent.seeked(video);
    await waitFor(() => expect(audio.src).toContain("inserted.mp4"));
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(21);
    expect(video.src).toContain("original.mp4");
  });

  it("timeline and keyboard seeks update audio while preserving paused playback", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
    ]);
    const timeline = screen.getByTestId("video-editor-timeline");
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    fireEvent.click(timeline, { clientX: 500 });
    await waitFor(() => expect(video.currentTime).toBe(5));
    expect(audio.currentTime).toBe(15);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(audio.currentTime).toBeCloseTo(15.1));
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(0);
  });

  it("segment transitions and gaps do not switch or stop the visible video", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 0, sourceEnd: 2, timelineStart: 0 },
      { id: "b", sourceVideoId: "original", sourceStart: 7, sourceEnd: 9, timelineStart: 4 },
    ]);
    fireEvent.play(video);
    video.currentTime = 3;
    fireEvent.timeUpdate(video);
    const videoPauses = vi.mocked(video.pause).mock.contexts.filter((item) => item === video).length;
    expect(vi.mocked(audio.pause).mock.contexts).toContain(audio);
    video.currentTime = 4.25;
    fireEvent.timeUpdate(video);
    expect(audio.currentTime).toBe(7.25);
    expect(vi.mocked(video.pause).mock.contexts.filter((item) => item === video)).toHaveLength(videoPauses);
    expect(mockApiFetch.mock.calls.filter(([path]) => path === "/api/videos/original/download")).toHaveLength(1);
  });

  it("pause during an outstanding audio URL load prevents a delayed start", async () => {
    let resolveUrl!: (value: { downloadUrl: string }) => void;
    const pending = new Promise<{ downloadUrl: string }>((resolve) => { resolveUrl = resolve; });
    const originalApi = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path, options) => path === "/api/videos/inserted/download"
      ? pending : originalApi(path, options));
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 0, sourceEnd: 2, timelineStart: 0 },
      { id: "b", sourceVideoId: "inserted", sourceStart: 10, sourceEnd: 18, timelineStart: 2 },
    ]);
    fireEvent.play(video);
    video.currentTime = 3;
    fireEvent.seeking(video);
    fireEvent.seeked(video);
    fireEvent.pause(video);
    const plays = vi.mocked(audio.play).mock.contexts.filter((item) => item === audio).length;
    await act(async () => { resolveUrl({ downloadUrl: "https://media.example/inserted.mp4" }); await pending; });
    fireEvent.loadedMetadata(audio);
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(plays);
    expect(audio.src).toContain("original.mp4");
  });

  it("video buffering suspends audio and resynchronizes on continued playback", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
    ]);
    fireEvent.play(video);
    fireEvent.waiting(video);
    video.currentTime = 1.5;
    const plays = vi.mocked(audio.play).mock.contexts.filter((item) => item === audio).length;
    fireEvent.timeUpdate(video);
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(plays);
    fireEvent.playing(video);
    expect(audio.currentTime).toBe(11.5);
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(plays + 1);
  });

  it("a video source transition keeps using an independent audio source and pause still works", async () => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [
        { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 2, duration: 2 },
        { id: "clip-2", sourceId: "inserted", sourceStart: 8, sourceEnd: 16, duration: 8 },
      ],
      audioSegments: [{ id: "a", sourceClipId: "clip-1", sourceVideoId: "original", sourceStart: 20, sourceEnd: 30, timelineStart: 0 }],
    } };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    const audio = await screen.findByTestId("video-editor-audio-preview") as HTMLAudioElement;
    await waitFor(() => expect(audio.src).toContain("original.mp4"));
    const video = document.querySelector("video")!;
    Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.loadedMetadata(audio);
    fireEvent.play(video);
    video.currentTime = 2.01;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(video.src).toContain("inserted.mp4"));
    fireEvent.pause(video); // Internal pause while changing the visible source.
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(video.currentTime).toBe(8));
    await waitFor(() => expect(audio.currentTime).toBe(22));
    expect(audio.src).toContain("original.mp4");
    fireEvent.pause(video); // Real pause after the source transition.
    const plays = vi.mocked(audio.play).mock.contexts.filter((item) => item === audio).length;
    video.currentTime = 8.5;
    fireEvent.timeUpdate(video);
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(plays);
  });

  it("a contiguous video split does not pause, reload or restart its contiguous audio", async () => {
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: {
      version: 1,
      clips: [
        { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 2, duration: 2 },
        { id: "clip-2", sourceId: "original", sourceStart: 2, sourceEnd: 10, duration: 8 },
      ],
      audioSegments: [
        { id: "a", sourceClipId: "clip-1", sourceVideoId: "original", sourceStart: 0, sourceEnd: 2, timelineStart: 0 },
        { id: "b", sourceClipId: "clip-2", sourceVideoId: "original", sourceStart: 2, sourceEnd: 10, timelineStart: 2 },
      ],
    } };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    const audio = await screen.findByTestId("video-editor-audio-preview") as HTMLAudioElement;
    await waitFor(() => expect(audio.src).toContain("original.mp4"));
    const video = document.querySelector("video")!;
    Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.loadedMetadata(audio);
    fireEvent.play(video);
    vi.mocked(audio.pause).mockClear();
    vi.mocked(audio.load).mockClear();
    const plays = vi.mocked(audio.play).mock.contexts.filter((item) => item === audio).length;
    video.currentTime = 1.96;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(1.96); // Do not skip the last 50 ms of a clip.
    audio.currentTime = 2.01;
    video.currentTime = 2.01;
    await act(async () => { fireEvent.timeUpdate(video); });
    expect(audio.currentTime).toBe(2.01);
    expect(video.currentTime).toBe(2.01);
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(plays);
    expect(vi.mocked(audio.pause).mock.contexts.filter((item) => item === audio)).toHaveLength(0);
    expect(vi.mocked(audio.load).mock.contexts.filter((item) => item === audio)).toHaveLength(0);
  });

  it("explicitly empty audio segments keep video silent without a fallback", async () => {
    const { video, audio } = await mountAudioPreview([]);
    fireEvent.play(video);
    video.currentTime = 3;
    fireEvent.timeUpdate(video);
    expect(video.muted).toBe(true);
    expect(audio.getAttribute("src")).toBeNull();
    expect(vi.mocked(audio.play).mock.contexts.filter((item) => item === audio)).toHaveLength(0);
  });

  it("offers an explicit user-action retry when the browser blocks audio playback", async () => {
    const { video, audio } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
    ]);
    vi.spyOn(audio, "play").mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    fireEvent.play(video);
    const retry = await screen.findByRole("button", { name: "Wiedergabe mit Ton starten" });
    expect(screen.getByRole("alert")).toHaveTextContent("Browser blockiert");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(video.muted).toBe(true);
  });

  it("close and unmount stop audio even when the parent does not immediately remove the editor", async () => {
    const { video, audio, onClose, unmount } = await mountAudioPreview([
      { id: "a", sourceVideoId: "original", sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
    ]);
    fireEvent.play(video);
    vi.mocked(audio.pause).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalled();
    expect(vi.mocked(audio.pause).mock.contexts).toContain(audio);
    unmount();
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("suppresses only the symbol tooltip while its popover is open and restores it on close", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    const button = screen.getByRole("button", { name: "Symbol hinzufügen" });
    const tooltip = () => document.getElementById("video-editor-tooltip-symbol");
    await user.hover(button);
    expect(tooltip()).toHaveClass("video-editor-tool-tooltip");
    expect(button).toHaveAttribute("aria-describedby", "video-editor-tooltip-symbol");
    await user.unhover(button);
    act(() => button.focus());
    expect(button).toHaveFocus();
    expect(tooltip()).toHaveTextContent("Symbol hinzufügen");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Symbol auswählen" })).toBeInTheDocument();
    expect(tooltip()).not.toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(document.getElementById("video-editor-tooltip-arrow")).toHaveClass("video-editor-tool-tooltip");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Symbol auswählen" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(tooltip()).toHaveClass("video-editor-tool-tooltip");
    expect(button).toHaveAttribute("aria-describedby", "video-editor-tooltip-symbol");
    await user.hover(button);
    expect(tooltip()).toHaveTextContent("Symbol hinzufügen");
    await user.click(button);
    expect(tooltip()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Haken" }));
    expect(tooltip()).toHaveClass("video-editor-tool-tooltip");
  });

  it("creates all eight local symbols and preserves color and free rotation through copy and reload", async () => {
    const user = userEvent.setup();
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    const choices = [["check", "Haken"], ["cross", "Kreuz"], ["warning", "Warnung"], ["info", "Info"], ["star", "Stern"], ["pointer", "Hand"], ["plus", "Plus"], ["question", "Fragezeichen"]];
    for (const [index, [id, label]] of choices.entries()) {
      await user.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
      expect(screen.getByRole("dialog", { name: "Symbol auswählen" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: label }));
      expect(screen.queryByRole("dialog", { name: "Symbol auswählen" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Symbol ${index + 1}` })).toHaveAttribute("aria-pressed", "true");
      const shape = screen.getByTestId("video-editor-overlay-frame").querySelector(`[data-symbol="${id}"]`)!;
      expect(shape).toHaveAttribute("fill", "none");
      expect(shape.children.length).toBeGreaterThan(0);
      expect(shape.closest("svg")).toHaveStyle({ pointerEvents: "none" });
    }
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    const selected = frame.querySelector('[data-symbol="question"]')!.closest("svg")!.parentElement as HTMLElement;
    const point = (angle: number) => ({
      clientX: (parseFloat(selected.style.left) + parseFloat(selected.style.width) / 2) * 10 + Math.cos(angle * Math.PI / 180) * parseFloat(selected.style.width) * 5,
      clientY: (parseFloat(selected.style.top) + parseFloat(selected.style.height) / 2) * 5 + Math.sin(angle * Math.PI / 180) * parseFloat(selected.style.height) * 2.5,
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Symbol drehen" }), point(0));
    fireEvent.pointerMove(document, point(20));
    fireEvent.pointerMove(document, point(37));
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbolrichtung")).toHaveValue("37");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol 8" }));
    expect(screen.getByLabelText("Symbolrichtung")).toHaveValue("0");
    fireEvent.change(screen.getByLabelText("Symbolrichtung"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Symbolfarbe"), { target: { value: "#123abc" } });
    expect(frame.querySelector('[data-symbol="question"]')!.parentElement?.parentElement).toHaveStyle({ color: "#123abc" });
    expect(frame.querySelector('[data-symbol="check"]')!.parentElement?.parentElement).toHaveStyle({ color: "#FC2667" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol 8" }));
    expect(screen.getByLabelText("Symbolfarbe")).toHaveValue("#fc2667");
    fireEvent.change(screen.getByLabelText("Symbolfarbe"), { target: { value: "#123abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Symbol kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Symbol einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations.map((a: { symbol: string }) => a.symbol)).toEqual([...choices.map(([id]) => id), "question"]);
    expect(timeline.annotations[8]).toEqual({ ...timeline.annotations[7], id: timeline.annotations[8].id });
    expect(timeline.annotations[8].id).not.toBe(timeline.annotations[7].id);
    view.unmount(); editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Symbol 9" });
    fireEvent.click(screen.getByRole("button", { name: "Symbol 9" }));
    expect(screen.getByLabelText("Symbolfarbe")).toHaveValue("#123abc");
    expect(screen.getByLabelText("Symbolrichtung")).toHaveValue("45");
  });

  it("creates symbols with independent numbering, copy/paste, deletion, reload and undo", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    const ring = view.container.querySelector('[data-symbol="check"]')!;
    expect(ring).toHaveAttribute("fill", "none");
    expect(ring.parentElement?.parentElement).toHaveStyle({ color: "#FC2667" });
    expect(screen.getByLabelText("Symbol drehen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pfeilfarbe")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pfeil drehen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    expect(screen.getByRole("button", { name: "Symbol 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Symbol kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Symbol einfügen" }));
    expect(screen.getByRole("button", { name: "Symbol 3" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[3]).toEqual({ ...timeline.annotations[2], id: timeline.annotations[3].id });
    expect(timeline.annotations[3].id).not.toBe(timeline.annotations[2].id);
    fireEvent.click(screen.getByRole("button", { name: "Symbol löschen" }));
    expect(screen.queryByRole("button", { name: "Symbol 3" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "Symbol 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Symbol 3" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Symbol 2" })).not.toBeInTheDocument();
    view.unmount();
    editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Symbol 3" });
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
  });

  it("drags and resizes a symbol into an oval with frame bounds and one undo per gesture", async () => {
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    const rect = vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    const symbol = () => frame.querySelector('[data-testid^="video-editor-symbol-"]') as HTMLElement;
    const originalWidth = symbol().style.width;
    fireEvent.pointerDown(symbol(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);
    expect(symbol()).toHaveStyle({ left: "55%", top: "55%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(symbol()).toHaveStyle({ left: "35%", top: "35%" });
    fireEvent.click(screen.getByRole("button", { name: "Symbol 1" }));
    const resize = () => frame.querySelector('[data-testid^="video-editor-symbol-resize-"]')!;
    fireEvent.pointerDown(resize(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 0 });
    fireEvent.pointerUp(document);
    expect(symbol().style.width).not.toBe(originalWidth);
    expect(symbol()).toHaveStyle({ height: "18%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(symbol().style.width).toBe(originalWidth);
    // A resized video frame must change pointer-to-percent conversion.
    rect.mockReturnValue({ left: 0, top: 0, width: 500, height: 250 } as DOMRect);
    fireEvent.pointerDown(symbol(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 50, clientY: 25 });
    fireEvent.pointerUp(document);
    expect(symbol()).toHaveStyle({ left: "45%", top: "45%" });
    fireEvent.pointerDown(resize(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(symbol()).toHaveStyle({ width: "55%", height: "55%" });
    fireEvent.pointerDown(symbol(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(document);
    expect(symbol()).toHaveStyle({ left: "0%", top: "0%" });
  });

  it("resizes and moves symbol timeline windows with live preview, undo and persistence", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    const track = view.container.querySelector('[data-testid^="video-editor-symbol-track-"]')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: -100, width: 2000 } as DOMRect);
    const start = view.container.querySelector('[data-testid^="video-editor-symbol-start-"]')!;
    const end = view.container.querySelector('[data-testid^="video-editor-symbol-end-"]')!;
    const video = view.container.querySelector("video")!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(1);
    expect(view.container.querySelector('[data-symbol="check"]')).toBeNull();
    video.currentTime = 2; fireEvent.timeUpdate(video);
    expect(view.container.querySelector('[data-symbol="check"]')).not.toBeNull();
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Symbol 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 800 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(5);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(10);
    expect(view.container.querySelector('[data-symbol="check"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol 1" }));
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(1);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Symbol 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(0);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "Symbol kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations.map((a: { start: number; end: number }) => [a.start, a.end])).toEqual([[0, 5], [0, 5]]);
    view.unmount(); editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Symbol 2" });
    fireEvent.click(screen.getByRole("button", { name: "Symbol 2" }));
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(5);
  });

  it("clamps symbol timeline handles without changing another symbol", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Haken" }));
    const tracks = view.container.querySelectorAll('[data-testid^="video-editor-symbol-track-"]');
    vi.spyOn(tracks[0], "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    const start = tracks[0].querySelector('[data-testid^="video-editor-symbol-start-"]')!;
    const end = tracks[0].querySelector('[data-testid^="video-editor-symbol-end-"]')!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(0);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(4.9);
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(5);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "Symbol 2" }));
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(0);
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol 1" }));
    expect(screen.getByLabelText("Symbol Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Symbol 1" }));
    expect(screen.getByLabelText("Symbol Start")).toHaveValue(0);
  });


  it.each([0, 180, 90, 270, 45, 37, 217].flatMap((angle) => [[angle, 1000, 500], [angle, 640, 800]]))(
    "resizes a %s-degree line along its screen axis at %sx%s with a fixed endpoint",
    async (angle, frameWidth, frameHeight) => {
      const original = { id: "line-axis", type: "line" as const, x: 30, y: 30, width: 30, height: 20, start: 0, end: 5, rotation: angle, color: "#123abc" };
      editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline: {
        version: 1, clips: [{ id: "clip", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
        annotations: [original, { ...original, id: "line-other", rotation: 23 }],
      }};
      const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
      await screen.findByRole("button", { name: "Linie 1" });
      const frame = screen.getByTestId("video-editor-overlay-frame");
      vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 17, top: 29, width: frameWidth, height: frameHeight } as DOMRect);
      fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
      const geometry = () => {
        const e = screen.getByTestId("video-editor-line-line-axis");
        return { x: parseFloat(e.style.left), y: parseFloat(e.style.top), width: parseFloat(e.style.width), height: parseFloat(e.style.height) };
      };
      const ends = () => {
        const g = geometry(), r = angle * Math.PI / 180;
        return [-.42, .42].map((sign) => ({
          x: 17 + (g.x + g.width * (.5 + sign * Math.cos(r))) * frameWidth / 100,
          y: 29 + (g.y + g.height * (.5 + sign * Math.sin(r))) * frameHeight / 100,
        }));
      };
      const [fixed, moving] = ends();
      const length = Math.hypot(moving.x-fixed.x, moving.y-fixed.y);
      const ux = (moving.x-fixed.x)/length, uy = (moving.y-fixed.y)/length;
      // Grabbing slightly off-center must not cause an initial jump.
      const start = { clientX: moving.x+2, clientY: moving.y-3 };
      const drag = (distance: number, normal = 0) => fireEvent.pointerMove(document, {
        clientX: start.clientX + ux*distance - uy*normal,
        clientY: start.clientY + uy*distance + ux*normal,
      });
      const assertEnds = (distance: number) => {
        const [a,b] = ends();
        expect(a.x).toBeCloseTo(fixed.x, 7); expect(a.y).toBeCloseTo(fixed.y, 7);
        expect(b.x).toBeCloseTo(moving.x+ux*distance, 7); expect(b.y).toBeCloseTo(moving.y+uy*distance, 7);
        expect(screen.getByLabelText("Linienrichtung")).toHaveValue(String(angle));
      };
      fireEvent.pointerDown(screen.getByTestId("video-editor-line-resize-line-axis"), start);
      drag(0); assertEnds(0);
      drag(0, 10); assertEnds(0);
      expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
      drag(1); assertEnds(1);
      drag(20, 10); assertEnds(20);
      drag(100000);
      const clamped = geometry();
      const limit = (a: number, d: number, low: number, high: number) => Math.abs(d) < 1e-10 ? Infinity : ((d > 0 ? high : low) - a) / d;
      const maxLength = Math.min(limit(fixed.x, ux, 17, 17+frameWidth), limit(fixed.y, uy, 29, 29+frameHeight));
      expect(ends()[1].x).toBeCloseTo(fixed.x + ux * maxLength, 7);
      expect(ends()[1].y).toBeCloseTo(fixed.y + uy * maxLength, 7);
      expect(ends()[1].x).toBeGreaterThanOrEqual(17-1e-8);
      expect(ends()[1].x).toBeLessThanOrEqual(17+frameWidth+1e-8);
      expect(ends()[1].y).toBeGreaterThanOrEqual(29-1e-8);
      expect(ends()[1].y).toBeLessThanOrEqual(29+frameHeight+1e-8);
      expect(ends()[0].x).toBeCloseTo(fixed.x, 7); expect(ends()[0].y).toBeCloseTo(fixed.y, 7);
      drag(200000); expect(geometry()).toEqual(clamped);
      drag(-10); assertEnds(-10);
      drag(20); assertEnds(20);
      fireEvent.pointerUp(document);
      expect(screen.getByTestId("video-editor-line-line-other")).toHaveStyle({ left: "30%", top: "30%", width: "30%", height: "20%" });
      fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
      fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
      assertEnds(0);
      expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
      fireEvent.pointerDown(screen.getByTestId("video-editor-line-resize-line-axis"), start);
      drag(100000); fireEvent.pointerUp(document);
      const savedGeometry = geometry();
      await waitFor(() => {
        const call = mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT").at(-1);
        expect(call).toBeDefined();
        expect(JSON.parse(call![1].body).annotations[0].width).toBeCloseTo(savedGeometry.width);
      });
      const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT").at(-1)![1].body);
      view.unmount(); editorState = { ...emptyEditorState, timeline };
      render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
      await screen.findByRole("button", { name: "Linie 1" });
      fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
      expect(geometry()).toEqual(savedGeometry);
      expect(ends()[1].x).toBeCloseTo(fixed.x + ux * maxLength, 7);
      expect(ends()[1].y).toBeCloseTo(fixed.y + uy * maxLength, 7);
    });

  it("edits line length, rotation and color without changing stroke width, preserving copy and reload", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    const rect = vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    const shape = () => frame.querySelector("line")!;
    const box = () => shape().closest("svg")!.parentElement as HTMLElement;
    const hit = () => frame.querySelector('[data-testid^="video-editor-line-hit-"]')!;
    const grip = () => frame.querySelector('[data-testid^="video-editor-line-resize-"]')!;
    const before = [box().style.width,box().style.height];
    const rotationGrip = screen.getByRole("button", { name: "Linie drehen" });
    expect(rotationGrip).toHaveStyle({ width: "12px", height: "12px", pointerEvents: "auto" });
    expect(rotationGrip.style.left).toBe("calc(50% - 6px)");
    expect(rotationGrip.style.top).toBe("calc(50% - 20px)");
    expect(rotationGrip.previousElementSibling).toHaveStyle({ height: "8px", left: "50%", top: "50%", pointerEvents: "none" });
    // Rotation is near the middle, length remains at the endpoint.
    expect(grip()).not.toBe(rotationGrip);
    expect((grip() as HTMLElement).style.left).toBe("calc(92% - 6px)");
    expect((grip() as HTMLElement).style.top).toBe("calc(50% - 6px)");
    expect(box()).toHaveStyle({ pointerEvents: "none" });
    expect(box().style.border).not.toContain("solid");
    expect(hit()).toHaveStyle({ pointerEvents: "stroke" });
    fireEvent.pointerDown(hit(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 50 });
    fireEvent.pointerUp(document);
    expect(box()).toHaveStyle({ left: "45%", top: "45%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(box()).toHaveStyle({ left: "35%", top: "35%" });
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    fireEvent.pointerDown(grip(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 10, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 20, clientY: 0 });
    fireEvent.pointerUp(document);
    expect(parseFloat(box().style.width)).toBeGreaterThan(parseFloat(before[0]));
    expect(parseFloat(box().style.width)/parseFloat(box().style.height)).toBeCloseTo(parseFloat(before[0])/parseFloat(before[1]));
    expect(shape()).toHaveAttribute("stroke-width", "3");
    expect(shape()).toHaveAttribute("vector-effect", "non-scaling-stroke");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect([box().style.width,box().style.height]).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    const point = (angle: number) => ({
      clientX: (35 + parseFloat(before[0])/2)*10 + Math.cos(angle*Math.PI/180)*parseFloat(before[0])*5,
      clientY: (35 + parseFloat(before[1])/2)*5 + Math.sin(angle*Math.PI/180)*parseFloat(before[1])*2.5,
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Linie drehen" }), point(0));
    fireEvent.pointerMove(document, point(20));fireEvent.pointerMove(document, point(37));fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linienrichtung")).toHaveValue("37");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(screen.getByLabelText("Linienrichtung")).toHaveValue("0");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Linie drehen" }), point(0));
    fireEvent.pointerMove(document, point(37));fireEvent.pointerUp(document);
    fireEvent.change(screen.getByLabelText("Linienfarbe"), { target: { value: "#123abc" } });
    expect(shape()).toHaveAttribute("stroke", "#123abc");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(shape()).toHaveAttribute("stroke", "#FC2667");
    fireEvent.change(screen.getByLabelText("Linienfarbe"), { target: { value: "#123abc" } });
    rect.mockReturnValue({ left: 0, top: 0, width: 500, height: 250 } as DOMRect);
    fireEvent.pointerDown(hit(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });fireEvent.pointerUp(document);
    expect(parseFloat(box().style.left)+parseFloat(box().style.width)*(.5+.42*Math.cos(37*Math.PI/180))).toBeCloseTo(100);
    expect(parseFloat(box().style.top)+parseFloat(box().style.height)*(.5+.42*Math.sin(37*Math.PI/180))).toBeCloseTo(100);
    fireEvent.click(screen.getByRole("button", { name: "Linie kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    expect(screen.queryByRole("button", { name: "Linie drehen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Linie einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([,o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[1]).toEqual({...timeline.annotations[0], id: timeline.annotations[1].id});
    expect(timeline.annotations[1].id).not.toBe(timeline.annotations[0].id);
    view.unmount();editorState = {...emptyEditorState,timeline};
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Linie 2" });
    fireEvent.click(screen.getByRole("button", { name: "Linie 2" }));
    expect(screen.getByLabelText("Linienfarbe")).toHaveValue("#123abc");
    expect(screen.getByLabelText("Linienrichtung")).toHaveValue("37");
    fireEvent.change(screen.getByLabelText("Linienfarbe"), { target: { value: "#ff0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(screen.getByLabelText("Linienfarbe")).toHaveValue("#123abc");
  });

  it("creates lines with independent numbering, copy/paste, deletion, reload and undo", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    const ring = view.container.querySelector("line")!;
    expect(ring).toHaveAttribute("fill", "none");
    expect(ring).toHaveAttribute("stroke", "#FC2667");
    expect(ring).toHaveAttribute("vector-effect", "non-scaling-stroke");
    expect(screen.queryByLabelText("Pfeilfarbe")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pfeil drehen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    expect(screen.getByRole("button", { name: "Linie 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Linie kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Linie einfügen" }));
    expect(screen.getByRole("button", { name: "Linie 3" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[3]).toEqual({ ...timeline.annotations[2], id: timeline.annotations[3].id });
    expect(timeline.annotations[3].id).not.toBe(timeline.annotations[2].id);
    fireEvent.click(screen.getByRole("button", { name: "Linie löschen" }));
    expect(screen.queryByRole("button", { name: "Linie 3" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "Linie 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Linie 3" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Linie 2" })).not.toBeInTheDocument();
    view.unmount();
    editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Linie 3" });
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
  });

  it("resizes and moves line timeline windows with live preview, undo and persistence", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    const track = view.container.querySelector('[data-testid^="video-editor-line-track-"]')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: -100, width: 2000 } as DOMRect);
    const start = view.container.querySelector('[data-testid^="video-editor-line-start-"]')!;
    const end = view.container.querySelector('[data-testid^="video-editor-line-end-"]')!;
    const video = view.container.querySelector("video")!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Start")).toHaveValue(1);
    expect(view.container.querySelector("line")).toBeNull();
    video.currentTime = 2; fireEvent.timeUpdate(video);
    expect(view.container.querySelector("line")).not.toBeNull();
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Linie 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 800 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Start")).toHaveValue(5);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(10);
    expect(view.container.querySelector("line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(screen.getByLabelText("Linie Start")).toHaveValue(1);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Linie 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Start")).toHaveValue(0);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "Linie kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations.map((a: { start: number; end: number }) => [a.start, a.end])).toEqual([[0, 5], [0, 5]]);
    view.unmount(); editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Linie 2" });
    fireEvent.click(screen.getByRole("button", { name: "Linie 2" }));
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(5);
  });

  it("clamps line timeline handles without changing another line", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie hinzufügen" }));
    const tracks = view.container.querySelectorAll('[data-testid^="video-editor-line-track-"]');
    vi.spyOn(tracks[0], "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    const start = tracks[0].querySelector('[data-testid^="video-editor-line-start-"]')!;
    const end = tracks[0].querySelector('[data-testid^="video-editor-line-end-"]')!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Linie Start")).toHaveValue(0);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Start")).toHaveValue(4.9);
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(5);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "Linie 2" }));
    expect(screen.getByLabelText("Linie Start")).toHaveValue(0);
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(screen.getByLabelText("Linie Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Linie 1" }));
    expect(screen.getByLabelText("Linie Start")).toHaveValue(0);
  });


  it("creates circles with independent numbering, copy/paste, deletion, reload and undo", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    const ring = view.container.querySelector("ellipse")!;
    expect(ring).toHaveAttribute("fill", "none");
    expect(ring).toHaveAttribute("stroke", "#FC2667");
    expect(ring).toHaveAttribute("vector-effect", "non-scaling-stroke");
    expect(screen.queryByLabelText("Pfeilfarbe")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pfeil drehen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    expect(screen.getByRole("button", { name: "Kreis 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Kreis kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Kreis einfügen" }));
    expect(screen.getByRole("button", { name: "Kreis 3" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[3]).toEqual({ ...timeline.annotations[2], id: timeline.annotations[3].id });
    expect(timeline.annotations[3].id).not.toBe(timeline.annotations[2].id);
    fireEvent.click(screen.getByRole("button", { name: "Kreis löschen" }));
    expect(screen.queryByRole("button", { name: "Kreis 3" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "Kreis 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Kreis 3" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Kreis 2" })).not.toBeInTheDocument();
    view.unmount();
    editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Kreis 3" });
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toBeInTheDocument();
  });

  it("drags and resizes a circle into an oval with frame bounds and one undo per gesture", async () => {
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    const rect = vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    const circle = () => frame.querySelector('[data-testid^="video-editor-circle-"]') as HTMLElement;
    const originalWidth = circle().style.width;
    fireEvent.pointerDown(circle(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);
    expect(circle()).toHaveStyle({ left: "55%", top: "55%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(circle()).toHaveStyle({ left: "35%", top: "35%" });
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    const resize = () => frame.querySelector('[data-testid^="video-editor-circle-resize-"]')!;
    fireEvent.pointerDown(resize(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 0 });
    fireEvent.pointerUp(document);
    expect(circle().style.width).not.toBe(originalWidth);
    expect(circle()).toHaveStyle({ height: "30%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(circle().style.width).toBe(originalWidth);
    // A resized video frame must change pointer-to-percent conversion.
    rect.mockReturnValue({ left: 0, top: 0, width: 500, height: 250 } as DOMRect);
    fireEvent.pointerDown(circle(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 50, clientY: 25 });
    fireEvent.pointerUp(document);
    expect(circle()).toHaveStyle({ left: "45%", top: "45%" });
    fireEvent.pointerDown(resize(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(circle()).toHaveStyle({ width: "55%", height: "55%" });
    fireEvent.pointerDown(circle(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(document);
    expect(circle()).toHaveStyle({ left: "0%", top: "0%" });
  });

  it("resizes and moves circle timeline windows with live preview, undo and persistence", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    const track = view.container.querySelector('[data-testid^="video-editor-circle-track-"]')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: -100, width: 2000 } as DOMRect);
    const start = view.container.querySelector('[data-testid^="video-editor-circle-start-"]')!;
    const end = view.container.querySelector('[data-testid^="video-editor-circle-end-"]')!;
    const video = view.container.querySelector("video")!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(1);
    expect(view.container.querySelector("ellipse")).toBeNull();
    video.currentTime = 2; fireEvent.timeUpdate(video);
    expect(view.container.querySelector("ellipse")).not.toBeNull();
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Kreis 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 800 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(5);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(10);
    expect(view.container.querySelector("ellipse")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(1);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Kreis 1" }), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(0);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "Kreis kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations.map((a: { start: number; end: number }) => [a.start, a.end])).toEqual([[0, 5], [0, 5]]);
    view.unmount(); editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Kreis 2" });
    fireEvent.click(screen.getByRole("button", { name: "Kreis 2" }));
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(5);
  });

  it("clamps circle timeline handles without changing another circle", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis hinzufügen" }));
    const tracks = view.container.querySelectorAll('[data-testid^="video-editor-circle-track-"]');
    vi.spyOn(tracks[0], "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    const start = tracks[0].querySelector('[data-testid^="video-editor-circle-start-"]')!;
    const end = tracks[0].querySelector('[data-testid^="video-editor-circle-end-"]')!;
    fireEvent.pointerDown(start, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(0);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(4.9);
    fireEvent.pointerDown(end, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(5);
    fireEvent.pointerMove(document, { clientX: 5000 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "Kreis 2" }));
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(0);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(0);
  });

  it("colors circles independently, undoes changes and preserves color through copy and reload", async () => {
    const original = { id: "circle-old", type: "circle" as const, x: 12, y: 23, width: 30, height: 18, start: 0, end: 4, rotation: 0 };
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline: {
      version: 1, clips: [{ id: "clip", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
      annotations: [original, { ...original, id: "circle-other", color: "#123abc" }],
    } };
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Kreis 1" });
    const ring = (id: string) => screen.getByTestId(`video-editor-circle-${id}`).querySelector("ellipse");
    expect(screen.queryByLabelText("Kreisfarbe")).not.toBeInTheDocument();
    expect(ring("circle-old")).toHaveAttribute("stroke", "#FC2667");
    expect(ring("circle-other")).toHaveAttribute("stroke", "#123abc");
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    expect(screen.getByLabelText("Kreisfarbe")).toHaveValue("#fc2667");
    fireEvent.change(screen.getByLabelText("Kreisfarbe"), { target: { value: "#ff9900" } });
    expect(ring("circle-old")).toHaveAttribute("stroke", "#ff9900");
    expect(ring("circle-old")).toHaveAttribute("fill", "none");
    expect(ring("circle-other")).toHaveAttribute("stroke", "#123abc");
    expect(screen.getByTestId("video-editor-circle-circle-old")).toHaveStyle({ border: "1px solid #FC2667", left: "12%", top: "23%", width: "30%", height: "18%" });
    expect(screen.getByTestId("video-editor-circle-resize-circle-old")).toHaveStyle({ background: "#FC2667" });
    expect(screen.getByLabelText("Kreis Start")).toHaveValue(0);
    expect(screen.getByLabelText("Kreis Ende")).toHaveValue(4);
    fireEvent.change(screen.getByLabelText("Kreisfarbe"), { target: { value: "#ffffff" } });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ring("circle-old")).toHaveAttribute("stroke", "#ff9900");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(ring("circle-old")).toHaveAttribute("stroke", "#FC2667");
    fireEvent.click(screen.getByRole("button", { name: "Kreis 1" }));
    fireEvent.change(screen.getByLabelText("Kreisfarbe"), { target: { value: "#ff9900" } });
    fireEvent.click(screen.getByRole("button", { name: "Kreis kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    expect(screen.queryByLabelText("Kreisfarbe")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Kreis einfügen" }));
    expect(screen.getByLabelText("Kreisfarbe")).toHaveValue("#ff9900");
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, o]) => o?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[0]).toEqual({ ...original, color: "#ff9900" });
    expect(timeline.annotations[2]).toEqual({ ...original, color: "#ff9900", id: timeline.annotations[2].id });
    expect(timeline.annotations[2].id).not.toBe(original.id);
    view.unmount(); editorState = { ...emptyEditorState, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Kreis 3" });
    expect(ring(timeline.annotations[2].id)).toHaveAttribute("stroke", "#ff9900");
    expect(ring("circle-other")).toHaveAttribute("stroke", "#123abc");
    fireEvent.click(screen.getByRole("button", { name: "Kreis 3" }));
    expect(screen.getByLabelText("Kreisfarbe")).toHaveValue("#ff9900");
  });

  it("colors legacy arrows independently and undoes color without changing geometry or timing", async () => {
    const original = { id: "legacy", type: "arrow" as const, x: 10, y: 20, width: 25, height: 25, start: 0, end: 5, rotation: 37 };
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline: {
      version: 1, clips: [{ id: "clip", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
      annotations: [original, { ...original, id: "colored", color: "#123abc" }],
    } };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 1" });
    const polygon = (id: string) => screen.getByTestId(`video-editor-arrow-${id}`).querySelector("polygon");
    expect(polygon("legacy")).toHaveAttribute("fill", "#FC2667");
    expect(polygon("colored")).toHaveAttribute("fill", "#123abc");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeilfarbe")).toHaveValue("#fc2667");
    fireEvent.change(screen.getByLabelText("Pfeilfarbe"), { target: { value: "#ff9900" } });
    expect(polygon("legacy")).toHaveAttribute("fill", "#ff9900");
    expect(polygon("legacy")).toHaveAttribute("transform", "rotate(37 50 50)");
    expect(polygon("colored")).toHaveAttribute("fill", "#123abc");
    expect(screen.getByTestId("video-editor-arrow-resize-legacy")).toHaveStyle({ background: "#FC2667" });
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(0);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(5);
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(payload.annotations[0]).toEqual({ ...original, color: "#ff9900" });
    fireEvent.change(screen.getByLabelText("Pfeilfarbe"), { target: { value: "#ffffff" } });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(polygon("legacy")).toHaveAttribute("fill", "#ff9900");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(polygon("legacy")).toHaveAttribute("fill", "#FC2667");
  });

  it("adds an independent arrow and undoes direction, timing and creation", async () => {
    const { container } = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    expect(screen.getByRole("button", { name: "Pfeil 1" })).toHaveAttribute("aria-pressed", "true");
    const polygon = () => container.querySelector('polygon')!;
    expect(polygon()).toHaveAttribute("fill", "#FC2667");
    expect(polygon()).toHaveAttribute("transform", "rotate(0 50 50)");
    fireEvent.change(screen.getByLabelText("Pfeilrichtung"), { target: { value: "90" } });
    expect(polygon()).toHaveAttribute("transform", "rotate(90 50 50)");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(polygon()).toHaveAttribute("transform", "rotate(0 50 50)");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.change(screen.getByLabelText("Pfeil Start"), { target: { value: "2" } });
    expect(polygon()).toBeNull();
    const video = container.querySelector("video")!;
    video.currentTime = 3; fireEvent.timeUpdate(video);
    expect(polygon()).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Pfeil Ende"), { target: { value: "4" } });
    video.currentTime = 5; fireEvent.timeUpdate(video);
    expect(polygon()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(0);
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Pfeil 1" })).not.toBeInTheDocument();
  });

  it("persists arrows, copies their complete data after deselection and restores them on reload", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    fireEvent.change(screen.getByLabelText("Pfeilrichtung"), { target: { value: "225" } });
    fireEvent.change(screen.getByLabelText("Pfeilfarbe"), { target: { value: "#12ab34" } });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    expect(screen.queryByLabelText("Pfeil löschen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const payload = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(payload.annotations).toHaveLength(2);
    expect(payload.annotations[0].color).toBe("#12ab34");
    expect(payload.annotations[1]).toEqual({ ...payload.annotations[0], id: payload.annotations[1].id });
    expect(payload.annotations[1].id).not.toBe(payload.annotations[0].id);
    expect(payload.overlays).toEqual([]);
    view.unmount();
    editorState = { ...emptyEditorState, timeline: payload };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 2" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 2" }));
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("225");
    expect(screen.getByLabelText("Pfeilfarbe")).toHaveValue("#12ab34");
    expect(screen.getByTestId(`video-editor-arrow-${payload.annotations[1].id}`).querySelector("polygon")).toHaveAttribute("fill", "#12ab34");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil löschen" }));
    expect(screen.queryByRole("button", { name: "Pfeil 2" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getByRole("button", { name: "Pfeil 2" })).toBeInTheDocument();
  });

  it("bounds arrow drag and resize to the shared frame and keeps one undo step per gesture", async () => {
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    const arrow = () => frame.querySelector('[data-testid^="video-editor-arrow-"]')!;
    const resize = () => frame.querySelector('[data-testid^="video-editor-arrow-resize-"]')!;
    fireEvent.pointerDown(arrow(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(arrow()).toHaveStyle({ left: "70%", top: "80%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(arrow()).toHaveStyle({ left: "35%", top: "35%" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.pointerDown(resize(), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(arrow()).toHaveStyle({ width: "65%", height: "65%" });
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(arrow()).toHaveStyle({ width: "30%", height: "20%" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByRole("button", { name: "Pfeil 2" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    expect(screen.queryByLabelText("Pfeilrichtung")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil löschen" }));
    expect(screen.getByText("Abdeckung 1")).toBeInTheDocument();
  });

  it.each([
    [35, 35], [0, 35], [70, 35], [35, 0], [35, 80], [70, 80],
    // A stale/out-of-bounds clipboard position must not escape on paste.
    [90, 95], [-2, -3],
  ])("keeps pasted arrow geometry inside the frame from (%s,%s)", async (x, y) => {
    const original = { id: "edge-arrow", type: "arrow" as const, x, y, width: 30, height: 20, rotation: 315, start: 0, end: 5 };
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline: {
      version: 1,
      clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 }],
      annotations: [original],
    } };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 1" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const { annotations: saved } = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(original);
    const copy = saved[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy).toEqual({ ...original, id: copy.id, x: Math.max(0, Math.min(70, x)), y: Math.max(0, Math.min(80, y)) });
    expect(copy.x).toBeGreaterThanOrEqual(0);
    expect(copy.y).toBeGreaterThanOrEqual(0);
    expect(copy.x + copy.width).toBeLessThanOrEqual(100);
    expect(copy.y + copy.height).toBeLessThanOrEqual(100);
    const element = screen.getByTestId(`video-editor-arrow-${copy.id}`);
    expect(element.parentElement).toBe(screen.getByTestId("video-editor-overlay-frame"));
    expect(element).toHaveStyle({ left: `${copy.x}%`, top: `${copy.y}%`, width: "30%", height: "20%" });
    expect(element.querySelector("polygon")).toHaveAttribute("transform", "rotate(315 50 50)");
  });

  async function renderArrowTimeline(trackWidth = 1000) {
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline: {
      version: 1,
      clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }],
      annotations: [
        { id: "timed-a", type: "arrow", x: 10, y: 10, width: 20, height: 20, start: 2, end: 6, rotation: 90 },
        { id: "timed-b", type: "arrow", x: 60, y: 60, width: 20, height: 20, start: 1, end: 8, rotation: 0 },
      ],
    } };
    const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 1" });
    vi.spyOn(screen.getByTestId("video-editor-arrow-track-timed-a"), "getBoundingClientRect")
      .mockReturnValue({ left: -100, width: trackWidth } as DOMRect);
    return view;
  }

  it("resizes arrow start/end independently with one undo step per pointer gesture", async () => {
    await renderArrowTimeline();
    const undo = screen.getByRole("button", { name: "↶ Rückgängig" });
    fireEvent.pointerDown(screen.getByTestId("video-editor-arrow-start-timed-a"), { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 250 });
    fireEvent.pointerMove(document, { clientX: 300 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(6);
    fireEvent.pointerDown(screen.getByTestId("video-editor-arrow-end-timed-a"), { clientX: 600 });
    fireEvent.pointerMove(document, { clientX: 700 });
    fireEvent.pointerMove(document, { clientX: 800 });
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
    fireEvent.click(undo);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(6);
    fireEvent.click(undo);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(2);
    expect(undo).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 2" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(1);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
  });

  it("clamps arrow time handles to duration and minimum gap on a zoomed/scrolled track", async () => {
    await renderArrowTimeline(2000);
    const start = screen.getByTestId("video-editor-arrow-start-timed-a");
    const end = screen.getByTestId("video-editor-arrow-end-timed-a");
    fireEvent.pointerDown(start, { clientX: 300 });
    fireEvent.pointerMove(document, { clientX: 500 });
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(0);
    fireEvent.pointerMove(document, { clientX: 5000 });
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(5.9);
    fireEvent.pointerUp(document);
    fireEvent.pointerDown(end, { clientX: 1100 });
    fireEvent.pointerMove(document, { clientX: -5000 });
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(6);
    fireEvent.pointerMove(document, { clientX: 5000 });
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(10);
    fireEvent.pointerCancel(document);
    fireEvent.pointerMove(document, { clientX: 1100 });
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(10);
  });

  it("updates arrow preview immediately and persists dragged times for reload and copy/paste", async () => {
    const view = await renderArrowTimeline();
    const video = view.container.querySelector("video")!;
    video.currentTime = 2.5; fireEvent.timeUpdate(video);
    expect(screen.getByTestId("video-editor-arrow-timed-a")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId("video-editor-arrow-start-timed-a"), { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 300 });
    expect(screen.queryByTestId("video-editor-arrow-timed-a")).not.toBeInTheDocument();
    fireEvent.pointerUp(document);
    video.currentTime = 7; fireEvent.timeUpdate(video);
    fireEvent.pointerDown(screen.getByTestId("video-editor-arrow-end-timed-a"), { clientX: 600 });
    fireEvent.pointerMove(document, { clientX: 800 });
    expect(screen.getByTestId("video-editor-arrow-timed-a")).toBeInTheDocument();
    fireEvent.pointerUp(document);
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[0]).toMatchObject({ start: 3, end: 8 });
    expect(timeline.annotations[1]).toMatchObject({ start: 1, end: 8 });
    view.unmount();
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 1" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    expect(screen.getByRole("button", { name: "Pfeil 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(3);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
  });

  it.each([1000, 2000])("moves the complete arrow window at track width %s with constant duration and one undo step", async (width) => {
    await renderArrowTimeline(width);
    const bar = screen.getByRole("button", { name: "Pfeil 1" });
    const undo = screen.getByRole("button", { name: "↶ Rückgängig" });
    const times = (start: number, end: number) => {
      expect(screen.getByLabelText("Pfeil Start")).toHaveValue(start);
      expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(end);
      const actualStart = Number((screen.getByLabelText("Pfeil Start") as HTMLInputElement).value);
      const actualEnd = Number((screen.getByLabelText("Pfeil Ende") as HTMLInputElement).value);
      expect(actualEnd - actualStart).toBe(4);
    };
    fireEvent.pointerDown(bar, { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 500 });
    fireEvent.pointerUp(document);
    expect(undo).toBeDisabled();
    fireEvent.pointerDown(bar, { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 500 + width * 0.2 });
    times(4, 8);
    fireEvent.pointerMove(document, { clientX: 500 + width * 0.3 });
    times(5, 9);
    fireEvent.pointerUp(document);
    fireEvent.click(undo);
    fireEvent.click(bar);
    times(2, 6);
    expect(undo).toBeDisabled();
    fireEvent.pointerDown(bar, { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 500 - width * 0.1 });
    times(1, 5);
    fireEvent.pointerMove(document, { clientX: -5000 });
    times(0, 4);
    fireEvent.pointerUp(document);
    fireEvent.pointerDown(bar, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 5000 });
    times(6, 10);
    fireEvent.pointerCancel(document);
    fireEvent.pointerMove(document, { clientX: 0 });
    times(6, 10);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 2" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(1);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
  });

  it("updates preview during arrow timeline move and restores/copies the shifted window", async () => {
    const view = await renderArrowTimeline();
    const video = view.container.querySelector("video")!;
    video.currentTime = 3.5; fireEvent.timeUpdate(video);
    expect(screen.getByTestId("video-editor-arrow-timed-a")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pfeil 1" }), { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 700 });
    expect(screen.queryByTestId("video-editor-arrow-timed-a")).not.toBeInTheDocument();
    video.currentTime = 7.5; fireEvent.timeUpdate(video);
    expect(screen.getByTestId("video-editor-arrow-timed-a")).toBeInTheDocument();
    fireEvent.pointerUp(document);
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations[0]).toEqual({ id: "timed-a", type: "arrow", x: 10, y: 10, width: 20, height: 20, start: 4, end: 8, rotation: 90 });
    expect(timeline.annotations[1]).toMatchObject({ id: "timed-b", start: 1, end: 8 });
    view.unmount();
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline };
    render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 1" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(4);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    expect(screen.getByRole("button", { name: "Pfeil 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Pfeil Start")).toHaveValue(4);
    expect(screen.getByLabelText("Pfeil Ende")).toHaveValue(8);
  });

  async function setupArrowRotation() {
    const view = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-timeline");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 1000, height: 500 } as DOMRect);
    const point = (angle: number) => ({ clientX: 600 + 150 * Math.cos(angle * Math.PI / 180), clientY: 275 + 50 * Math.sin(angle * Math.PI / 180) });
    return { ...view, frame, point };
  }

  it("rotates about the arrow center continuously with a single undo step and isolated selection", async () => {
    const { frame, point } = await setupArrowRotation();
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    expect(screen.queryByRole("button", { name: "Pfeil drehen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pfeil drehen" }), point(0));
    fireEvent.pointerMove(document, point(37));
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("37");
    fireEvent.pointerMove(document, point(82));
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("82");
    fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("0");
    fireEvent.click(screen.getByRole("button", { name: "Pfeil hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 1" }));
    fireEvent.change(screen.getByLabelText("Pfeilrichtung"), { target: { value: "45" } });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pfeil drehen" }), point(45));
    fireEvent.pointerMove(document, point(37));
    fireEvent.pointerUp(document);
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("37");
    const arrows = frame.querySelectorAll('[data-testid^="video-editor-arrow-"] > svg');
    expect(arrows[0].querySelector("polygon")).toHaveAttribute("transform", "rotate(37 50 50)");
    expect(arrows[1].querySelector("polygon")).toHaveAttribute("transform", "rotate(0 50 50)");
    fireEvent.pointerDown(arrows[0].parentElement!, { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(document, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(document);
    expect(arrows[0].parentElement).toHaveStyle({ left: "70%", top: "80%" });
    fireEvent.pointerDown(frame.querySelector('[data-testid^="video-editor-arrow-resize-"]')!, { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(document, { clientX: 450, clientY: 225 });
    fireEvent.pointerUp(document);
    expect(arrows[0].parentElement).toHaveStyle({ width: "25%", height: "15%" });
    expect(arrows[0].querySelector("polygon")).toHaveAttribute("transform", "rotate(37 50 50)");
    // Check the actual rotated polygon, not just the unrotated selection box.
    const vertices = arrows[0].querySelector("polygon")!.getAttribute("points")!.split(" ").map((p) => p.split(",").map(Number));
    for (let angle = 0; angle < 360; angle++) {
      const radians = angle * Math.PI / 180;
      for (const [x, y] of vertices) {
        const rx = 50 + (x - 50) * Math.cos(radians) - (y - 50) * Math.sin(radians);
        const ry = 50 + (x - 50) * Math.sin(radians) + (y - 50) * Math.cos(radians);
        expect(rx).toBeGreaterThanOrEqual(0); expect(rx).toBeLessThanOrEqual(100);
        expect(ry).toBeGreaterThanOrEqual(0); expect(ry).toBeLessThanOrEqual(100);
      }
    }
  });

  it("persists and copies exact free rotation and restores it after reload", async () => {
    const view = await setupArrowRotation();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pfeil drehen" }), view.point(0));
    fireEvent.pointerMove(document, view.point(37));
    fireEvent.pointerUp(document);
    fireEvent.click(screen.getByRole("button", { name: "Pfeil kopieren" }));
    fireEvent.click(screen.getByTestId("video-editor-annotation-tracks"));
    fireEvent.click(screen.getByRole("button", { name: "Pfeil einfügen" }));
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const timeline = JSON.parse(mockApiFetch.mock.calls.filter(([, options]) => options?.method === "PUT").at(-1)![1].body);
    expect(timeline.annotations.map((a: { rotation: number }) => a.rotation)).toEqual([37, 37]);
    view.unmount();
    editorState = { renderStatus: "none", renderError: null, renderedVideoId: null, timeline };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Pfeil 2" });
    fireEvent.click(screen.getByRole("button", { name: "Pfeil 2" }));
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("37");
    fireEvent.change(screen.getByLabelText("Pfeilrichtung"), { target: { value: "90" } });
    expect(screen.getByLabelText("Pfeilrichtung")).toHaveValue("90");
  });

  async function renderWithInsertedVideo() {
    const user = userEvent.setup();
    libraryVideos = [
      {
        id: "inserted",
        title: "Inserted source",
        status: "ready",
        duration: 30,
      },
    ];

    const { container } = render(
      <VideoEditorModal
        videoId="original"
        duration={120}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: /Video einfügen/ }));
    await user.click(await screen.findByRole("button", { name: /Inserted source/ }));
    await user.click(screen.getByRole("button", { name: "Hier einfügen" }));

    const video = container.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 30 });
    await waitFor(() => expect(video.src).toBe("https://media.example/inserted.mp4"));
    fireEvent.loadedMetadata(video);

    const timeline = screen.getByTestId("video-editor-timeline");
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 64,
      width: 1000,
      height: 64,
      toJSON: () => ({}),
    });

    return { container, timeline };
  }

  it("loads the clicked clip source at its corresponding source time", async () => {
    const { container } = await renderWithInsertedVideo();

    fireEvent.click(screen.getByText("Eingefügt: Inserted source"), { clientX: 100 });

    const video = container.querySelector("video")!;

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/videos/inserted/download");
      expect(video.src).toBe("https://media.example/inserted.mp4");
      expect(video.currentTime).toBeCloseTo(15, 3);
    });
  });

  it("steps across a clip boundary with ArrowRight", async () => {
    const { container } = await renderWithInsertedVideo();

    fireEvent.click(screen.getByText("Eingefügt: Inserted source"), { clientX: 100 });

    const video = container.querySelector("video")!;
    await waitFor(() =>
      expect(video.src).toBe("https://media.example/inserted.mp4"),
    );

    video.currentTime = 29.95;
    fireEvent.timeUpdate(video);

    fireEvent.keyDown(document, { key: "ArrowRight" });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/videos/original/download");
      expect(video.src).toBe("https://media.example/original.mp4");
    });
  });

  it("continues with the next clip when the active clip ends", async () => {
    const { container } = await renderWithInsertedVideo();

    fireEvent.click(screen.getByText("Eingefügt: Inserted source"), { clientX: 100 });
    const video = container.querySelector("video")!;
    await waitFor(() => expect(video.currentTime).toBeCloseTo(15, 3));

    Object.defineProperty(video, "paused", { configurable: true, value: false });
    video.currentTime = 30;
    fireEvent.timeUpdate(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });
    await waitFor(() => expect(video.src).toBe("https://media.example/original.mp4"));
    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(video.currentTime).toBe(0));
  });

  it("ignores stale metadata callbacks during rapid source changes", async () => {
    const { container } = await renderWithInsertedVideo();
    const video = container.querySelector("video")!;

    fireEvent.click(screen.getByText("Clip 2"), { clientX: 500 });
    fireEvent.click(screen.getByText("Eingefügt: Inserted source"), { clientX: 100 });

    Object.defineProperty(video, "duration", { configurable: true, value: 30 });
    fireEvent.loadedMetadata(video);

    await waitFor(() => {
      expect(video.src).toBe("https://media.example/inserted.mp4");
      expect(video.currentTime).toBeCloseTo(15, 3);
    });
  });

  it("shows source loading errors in the existing error area", async () => {
    const { container } = await renderWithInsertedVideo();
    libraryVideos = [
      {
        id: "broken",
        title: "Broken source",
        status: "ready",
        duration: 20,
      },
    ];
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Video einfügen/ }));
    await user.click(await screen.findByRole("button", { name: /Broken source/ }));
    sourceLoadError = new Error("Quelle ist nicht erreichbar");
    await user.click(screen.getByRole("button", { name: "Hier einfügen" }));

    expect(container.querySelector("video")).not.toBeNull();

    expect(await screen.findByText("Quelle ist nicht erreichbar")).toBeInTheDocument();
  });

  it("restores a persisted multi-source timeline", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-7", sourceId: "original", sourceStart: 5, sourceEnd: 10, duration: 5 },
          { id: "clip-8", sourceId: "inserted", sourceStart: 12, sourceEnd: 20, duration: 8 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    expect(await screen.findByTestId("video-editor-clip-clip-7")).toBeInTheDocument();
    expect(screen.getByTestId("video-editor-clip-clip-8")).toBeInTheDocument();
    expect(screen.getByText("0:13")).toBeInTheDocument();
  });

  it("restores all persisted cover overlays and keeps deletion working", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-saved-1", x: 5, y: 10, width: 25, height: 20, start: 0, end: 15 },
          { id: "cover-saved-2", x: 45, y: 30, width: 35, height: 40, start: 0, end: 30 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const firstOverlay = await screen.findByTestId("video-editor-cover-overlay-cover-saved-1");
    const secondOverlay = screen.getByTestId("video-editor-cover-overlay-cover-saved-2");
    expect(firstOverlay).toHaveStyle({ left: "5%", top: "10%", width: "25%", height: "20%" });
    expect(secondOverlay).toHaveStyle({ left: "45%", top: "30%", width: "35%", height: "40%" });

    expect(screen.getByText("Abdeckung 1")).toHaveStyle({ left: "0%", width: "12.5%" });
    expect(screen.getByText("Abdeckung 2")).toHaveStyle({ left: "0%", width: "25%" });

    fireEvent.click(screen.getByText("Abdeckung 2"));
    await user.click(screen.getByRole("button", { name: "Abdeckung löschen" }));

    expect(screen.getByTestId("video-editor-cover-overlay-cover-saved-1")).toBeInTheDocument();
    expect(screen.queryByTestId("video-editor-cover-overlay-cover-saved-2")).not.toBeInTheDocument();
  });

  it("treats legacy overlays as cover and toggles mode without changing identity or geometry", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "legacy-cover", x: 12, y: 18, width: 32, height: 24, start: 0, end: 19 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const overlay = await screen.findByTestId("video-editor-cover-overlay-legacy-cover");
    await user.click(screen.getByTestId("video-editor-cover-badge-legacy-cover"));
    const mode = screen.getByRole("combobox", { name: "Abdeckungstyp" });
    const originalGeometry = {
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
      height: overlay.style.height,
    };

    expect(mode).toHaveValue("cover");
    expect(overlay).toHaveStyle({ background: "#000" });
    expect(screen.getByText("Abdeckung 1")).toBeInTheDocument();
    expect(screen.getByTestId("video-editor-cover-badge-legacy-cover")).toHaveTextContent("1");

    await user.selectOptions(mode, "blur");
    expect(mode).toHaveValue("blur");
    expect(overlay.style.backdropFilter).toBe("blur(12px)");
    expect({
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
      height: overlay.style.height,
    }).toEqual(originalGeometry);
    expect(screen.getByRole("spinbutton", { name: /Start/ })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: /Ende/ })).toHaveValue(19);
    expect(screen.getByTestId("video-editor-overlay-row-legacy-cover")).toHaveAttribute("data-selected", "true");

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-legacy-cover"));
    expect(screen.getByRole("combobox", { name: "Abdeckungstyp" })).toHaveValue("cover");

    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "blur");
    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "cover");
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-legacy-cover"));
    expect(screen.getByRole("combobox", { name: "Abdeckungstyp" })).toHaveValue("blur");
  });

  it("persists, restores and copies blur mode through the existing overlay timeline", async () => {
    vi.useFakeTimers();
    try {
      editorState = {
        timeline: {
          version: 1,
          clips: [
            { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
          ],
          overlays: [
            { id: "blur-saved", x: 8, y: 9, width: 30, height: 25, start: 0, end: 20, mode: "blur" },
          ],
        },
        renderStatus: "none",
        renderError: null,
        renderedVideoId: null,
      };

      const firstRender = render(
        <VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />,
      );
      await vi.waitFor(() => expect(screen.getByTestId("video-editor-cover-overlay-blur-saved")).toBeInTheDocument());
      expect(screen.getByTestId("video-editor-cover-overlay-blur-saved").style.backdropFilter).toBe("blur(12px)");
      fireEvent.click(screen.getByTestId("video-editor-cover-badge-blur-saved"));
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));
      await vi.advanceTimersByTimeAsync(400);

      const saveCall = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      const savedTimeline = JSON.parse((saveCall?.[1] as RequestInit).body as string);
      expect(savedTimeline.overlays).toHaveLength(2);
      expect(savedTimeline.overlays.map((overlay: { mode: string }) => overlay.mode)).toEqual(["blur", "blur"]);

      firstRender.unmount();
      editorState = {
        timeline: savedTimeline,
        renderStatus: "none",
        renderError: null,
        renderedVideoId: null,
      };
      render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(screen.getAllByTestId(/video-editor-cover-overlay-/)).toHaveLength(2));
      for (const restoredOverlay of screen.getAllByTestId(/video-editor-cover-overlay-/)) {
        expect(restoredOverlay.style.backdropFilter).toBe("blur(12px)");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses black for legacy covers and preserves a custom color across blur and undo", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "colored-cover", x: 8, y: 9, width: 30, height: 25, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const overlay = await screen.findByTestId("video-editor-cover-overlay-colored-cover");
    await user.click(screen.getByTestId("video-editor-cover-badge-colored-cover"));
    const colorInput = screen.getByLabelText("Cover-Farbe");
    expect(colorInput).toHaveValue("#000000");
    expect(overlay).toHaveStyle({ background: "#000000" });

    fireEvent.change(colorInput, { target: { value: "#123456" } });
    expect(overlay).toHaveStyle({ background: "#123456" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-colored-cover"));
    expect(screen.getByLabelText("Cover-Farbe")).toHaveValue("#000000");

    fireEvent.change(screen.getByLabelText("Cover-Farbe"), {
      target: { value: "#123456" },
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "blur");
    expect(screen.queryByLabelText("Cover-Farbe")).not.toBeInTheDocument();
    expect(overlay.style.backdropFilter).toBe("blur(12px)");
    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "cover");
    expect(screen.getByLabelText("Cover-Farbe")).toHaveValue("#123456");
    expect(overlay).toHaveStyle({ background: "#123456" });
  });

  it("edits cover text as one undo step and hides it only in blur mode", async () => {
    const user = userEvent.setup();
    editorState = {
      renderStatus: "none", renderError: null, renderedVideoId: null,
      timeline: {
        version: 1,
        clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 }],
        overlays: [{ id: "text-cover", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20, color: "#ff0000", opacity: 0.4 }],
      },
    };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await user.click(await screen.findByTestId("video-editor-cover-badge-text-cover"));
    expect(screen.queryByTestId("video-editor-cover-text-text-cover")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Cover-Text")).toHaveAttribute("maxlength", "120");
    await user.type(screen.getByLabelText("Cover-Text"), "Hier klicken");
    const text = screen.getByTestId("video-editor-cover-text-text-cover");
    expect(text).toHaveTextContent("Hier klicken");
    expect(text).toHaveStyle({ opacity: "1", pointerEvents: "none", overflow: "hidden", left: "10%", width: "20%" });
    expect(screen.getByTestId("video-editor-cover-overlay-text-cover")).toHaveStyle({ opacity: "0.4" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByTestId("video-editor-cover-text-text-cover")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("video-editor-cover-badge-text-cover"));
    await user.type(screen.getByLabelText("Cover-Text"), "Nur intern");
    await user.selectOptions(screen.getByLabelText("Abdeckungstyp"), "blur");
    expect(screen.queryByLabelText("Cover-Text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("video-editor-cover-text-text-cover")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Abdeckungstyp"), "cover");
    expect(screen.getByLabelText("Cover-Text")).toHaveValue("Nur intern");
    expect(screen.getByTestId("video-editor-cover-text-text-cover")).toHaveTextContent("Nur intern");
  });

  it("saves edited text, copies it after deselection and restores both independent covers", async () => {
    const user = userEvent.setup();
    editorState = {
      renderStatus: "none", renderError: null, renderedVideoId: null,
      timeline: {
        version: 1,
        clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 }],
        overlays: [{ id: "text-cover", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20, color: "#ff0000", opacity: 0.4 }],
      },
    };
    const first = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await user.click(await screen.findByTestId("video-editor-cover-badge-text-cover"));
    await user.type(screen.getByLabelText("Cover-Text"), "Schritt 2");
    await user.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
    await user.click(screen.getByTestId("video-editor-overlay-scroll"));
    await user.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));
    await waitFor(() => {
      const saves = mockApiFetch.mock.calls.filter(([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT");
      const saved = JSON.parse(saves.at(-1)?.[1].body ?? "{}");
      expect(saved.overlays).toHaveLength(2);
    });
    const saved = JSON.parse(mockApiFetch.mock.calls.filter(([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT").at(-1)![1].body);
    expect(saved.overlays[0].id).not.toBe(saved.overlays[1].id);
    for (const overlay of saved.overlays) expect(overlay).toMatchObject({ text: "Schritt 2", color: "#ff0000", opacity: 0.4, mode: "cover" });
    first.unmount();
    editorState = { ...emptyEditorState, timeline: saved };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId(/video-editor-cover-text-/)).toHaveLength(2));
    await user.click(screen.getByTestId("video-editor-cover-badge-text-cover"));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) });
    fireEvent.pointerDown(screen.getByTestId("video-editor-cover-interaction-text-cover"), { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-cover-text-text-cover")).toHaveStyle({ left: "20%", top: "20%" });
    fireEvent.pointerDown(screen.getByTestId("video-editor-cover-resize-text-cover"), { clientX: 400, clientY: 200 });
    fireEvent.pointerMove(document, { clientX: 500, clientY: 250 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-cover-text-text-cover")).toHaveStyle({ width: "30%", height: "30%" });
  });

  it("defaults legacy covers to full opacity and preserves opacity across blur and undo", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "opacity-cover", x: 8, y: 9, width: 30, height: 25, start: 0, end: 20, color: "#e6467a" },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const overlay = await screen.findByTestId("video-editor-cover-overlay-opacity-cover");
    await user.click(screen.getByTestId("video-editor-cover-badge-opacity-cover"));
    const opacityInput = screen.getByRole("slider", { name: "Cover-Deckkraft" });
    expect(opacityInput).toHaveValue("100");
    expect(screen.getByTestId("video-editor-cover-opacity-value")).toHaveTextContent("100 %");
    expect(overlay).toHaveStyle({ background: "#e6467a", opacity: "1" });

    fireEvent.pointerDown(opacityInput);
    fireEvent.change(opacityInput, { target: { value: "90" } });
    fireEvent.change(opacityInput, { target: { value: "70" } });
    fireEvent.change(opacityInput, { target: { value: "50" } });
    fireEvent.pointerUp(opacityInput);
    expect(overlay).toHaveStyle({ background: "#e6467a", opacity: "0.5" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-opacity-cover"));
    expect(screen.getByRole("slider", { name: "Cover-Deckkraft" })).toHaveValue("100");

    fireEvent.pointerDown(screen.getByRole("slider", { name: "Cover-Deckkraft" }));
    fireEvent.change(screen.getByRole("slider", { name: "Cover-Deckkraft" }), {
      target: { value: "50" },
    });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "Cover-Deckkraft" }));

    fireEvent.pointerDown(screen.getByRole("slider", { name: "Cover-Deckkraft" }));
    fireEvent.change(screen.getByRole("slider", { name: "Cover-Deckkraft" }), {
      target: { value: "70" },
    });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "Cover-Deckkraft" }));
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-opacity-cover"));
    expect(screen.getByRole("slider", { name: "Cover-Deckkraft" })).toHaveValue("50");
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    await user.click(screen.getByTestId("video-editor-cover-badge-opacity-cover"));
    expect(screen.getByRole("slider", { name: "Cover-Deckkraft" })).toHaveValue("100");

    fireEvent.pointerDown(screen.getByRole("slider", { name: "Cover-Deckkraft" }));
    fireEvent.change(screen.getByRole("slider", { name: "Cover-Deckkraft" }), {
      target: { value: "50" },
    });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "Cover-Deckkraft" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "blur");
    expect(screen.queryByRole("slider", { name: "Cover-Deckkraft" })).not.toBeInTheDocument();
    expect(overlay.style.opacity).toBe("");
    await user.selectOptions(screen.getByRole("combobox", { name: "Abdeckungstyp" }), "cover");
    expect(screen.getByRole("slider", { name: "Cover-Deckkraft" })).toHaveValue("50");
    expect(overlay).toHaveStyle({ opacity: "0.5" });
  });

  it("persists, reloads and copies cover opacity through the existing overlay timeline", async () => {
    vi.useFakeTimers();
    try {
      editorState = {
        timeline: {
          version: 1,
          clips: [
            { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
          ],
          overlays: [
            { id: "opacity-cover", x: 8, y: 9, width: 30, height: 25, start: 0, end: 20, mode: "cover", color: "#e6467a", opacity: 0.5 },
          ],
        },
        renderStatus: "none",
        renderError: null,
        renderedVideoId: null,
      };

      const firstRender = render(
        <VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />,
      );
      await vi.waitFor(() => expect(screen.getByTestId("video-editor-cover-overlay-opacity-cover")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("video-editor-cover-badge-opacity-cover"));
      expect(screen.getByRole("slider", { name: "Cover-Deckkraft" })).toHaveValue("50");
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
      const pasteButton = screen.getByRole("button", { name: "Abdeckung einfügen" });
      expect(pasteButton).toBeEnabled();
      fireEvent.click(screen.getByTestId("video-editor-overlay-scroll"));
      expect(screen.queryByRole("button", { name: "Abdeckung kopieren" })).not.toBeInTheDocument();
      expect(pasteButton).toBeInTheDocument();
      expect(pasteButton).toBeEnabled();
      fireEvent.click(pasteButton);
      await vi.advanceTimersByTimeAsync(400);

      const saveCall = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      const savedTimeline = JSON.parse((saveCall?.[1] as RequestInit).body as string);
      expect(savedTimeline.overlays.map((overlay: { opacity: number }) => overlay.opacity)).toEqual([0.5, 0.5]);
      for (const copiedOverlay of screen.getAllByTestId(/video-editor-cover-overlay-/)) {
        expect(copiedOverlay).toHaveStyle({ background: "#e6467a", opacity: "0.5" });
      }

      firstRender.unmount();
      editorState = {
        timeline: savedTimeline,
        renderStatus: "none",
        renderError: null,
        renderedVideoId: null,
      };
      render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(screen.getAllByTestId(/video-editor-cover-overlay-/)).toHaveLength(2));
      for (const restoredOverlay of screen.getAllByTestId(/video-editor-cover-overlay-/)) {
        expect(restoredOverlay).toHaveStyle({ opacity: "0.5" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists, reloads and copies a cover color through the existing overlay timeline", async () => {
    vi.useFakeTimers();
    try {
      editorState = {
        timeline: {
          version: 1,
          clips: [
            { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
          ],
          overlays: [
            { id: "colored-cover", x: 8, y: 9, width: 30, height: 25, start: 0, end: 20, color: "#e6467a" },
          ],
        },
        renderStatus: "none",
        renderError: null,
        renderedVideoId: null,
      };

      render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(screen.getByTestId("video-editor-cover-overlay-colored-cover")).toBeInTheDocument());
      expect(screen.getByTestId("video-editor-cover-overlay-colored-cover")).toHaveStyle({ background: "#e6467a" });
      fireEvent.click(screen.getByTestId("video-editor-cover-badge-colored-cover"));
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));
      await vi.advanceTimersByTimeAsync(400);

      const saveCall = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      const savedTimeline = JSON.parse((saveCall?.[1] as RequestInit).body as string);
      expect(savedTimeline.overlays.map((overlay: { color: string }) => overlay.color)).toEqual([
        "#e6467a", "#e6467a",
      ]);
      for (const copiedOverlay of screen.getAllByTestId(/video-editor-cover-overlay-/)) {
        expect(copiedOverlay).toHaveStyle({ background: "#e6467a" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "black cover", mode: "cover" as const, color: undefined },
    { label: "colored cover", mode: "cover" as const, color: "#123456" },
    { label: "blur", mode: "blur" as const, color: "#123456" },
  ])("copies and enables pasting for a $label", async ({ mode, color }) => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          {
            id: "copy-source",
            x: 11,
            y: 12,
            width: 31,
            height: 22,
            start: 0,
            end: 20,
            mode,
            ...(color ? { color } : {}),
          },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await user.click(await screen.findByTestId("video-editor-cover-badge-copy-source"));
    expect(screen.queryByRole("button", { name: "Abdeckung einfügen" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
    const pasteButton = screen.getByRole("button", { name: "Abdeckung einfügen" });
    expect(pasteButton).toBeEnabled();
    await user.click(screen.getByTestId("video-editor-overlay-scroll"));
    expect(screen.queryByRole("button", { name: "Abdeckung kopieren" })).not.toBeInTheDocument();
    expect(pasteButton).toBeInTheDocument();
    expect(pasteButton).toBeEnabled();
    await user.click(pasteButton);

    const surfaces = screen.getAllByTestId(/video-editor-cover-overlay-/);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]).toHaveStyle({ left: "11%", top: "12%", width: "31%", height: "22%" });
    expect(surfaces[1]).toHaveStyle({ left: "11%", top: "12%", width: "31%", height: "22%" });
    if (mode === "blur") {
      expect(surfaces[1].style.backdropFilter).toBe("blur(12px)");
    } else {
      expect(surfaces[1]).toHaveStyle({ background: color ?? "#000000" });
    }
  });

  it("pastes an independent colored cover that remains movable", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "copy-source", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20, mode: "cover", color: "#123456" },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await user.click(await screen.findByTestId("video-editor-cover-badge-copy-source"));
    await user.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
    await user.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));

    const surfaces = screen.getAllByTestId(/video-editor-cover-overlay-/);
    const original = surfaces[0];
    const pasted = surfaces[1];
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500,
      width: 1000, height: 500, toJSON: () => ({}),
    });
    const pastedID = pasted.dataset.testid?.replace("video-editor-cover-overlay-", "");
    expect(pastedID).toBeTruthy();
    expect(pastedID).not.toBe("copy-source");
    fireEvent.pointerDown(screen.getByTestId(`video-editor-cover-interaction-${pastedID}`), {
      clientX: 100,
      clientY: 50,
    });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);

    expect(original).toHaveStyle({ left: "10%", top: "10%", background: "#123456" });
    expect(pasted).toHaveStyle({ left: "20%", top: "20%", background: "#123456" });
  });

  it("keeps video badges aligned with timeline numbering after delete and copy", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-a", x: 5, y: 5, width: 20, height: 20, start: 0, end: 20 },
          { id: "cover-b", x: 30, y: 30, width: 20, height: 20, start: 0, end: 20 },
          { id: "cover-c", x: 55, y: 55, width: 20, height: 20, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    expect(await screen.findByTestId("video-editor-cover-badge-cover-a")).toHaveTextContent("1");
    expect(screen.getByTestId("video-editor-cover-badge-cover-b")).toHaveTextContent("2");
    expect(screen.getByTestId("video-editor-cover-badge-cover-c")).toHaveTextContent("3");
    expect(screen.getByText("Abdeckung 1")).toBeInTheDocument();
    expect(screen.getByText("Abdeckung 2")).toBeInTheDocument();
    expect(screen.getByText("Abdeckung 3")).toBeInTheDocument();
    expect(screen.getByTestId("video-editor-cover-badge-cover-a")).toHaveStyle({
      pointerEvents: "auto",
    });

    await user.click(screen.getByText("Abdeckung 2"));
    await user.click(screen.getByRole("button", { name: "Abdeckung löschen" }));
    expect(screen.getByTestId("video-editor-cover-badge-cover-a")).toHaveTextContent("1");
    expect(screen.getByTestId("video-editor-cover-badge-cover-c")).toHaveTextContent("2");
    expect(screen.getByText("Abdeckung 1")).toBeInTheDocument();
    expect(screen.getByText("Abdeckung 2")).toBeInTheDocument();
    expect(screen.queryByText("Abdeckung 3")).not.toBeInTheDocument();

    await user.click(screen.getByText("Abdeckung 1"));
    await user.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
    await user.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));
    const badges = screen.getAllByTestId(/video-editor-cover-badge-cover-/);
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2", "3"]);
    expect(screen.getByText("Abdeckung 3")).toBeInTheDocument();
  });

  it("renders overlapping badges together in a pointer-transparent layer above all overlays", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-lower", x: 10, y: 10, width: 40, height: 40, start: 0, end: 20 },
          { id: "cover-partial", x: 15, y: 15, width: 40, height: 40, start: 0, end: 20 },
          { id: "cover-identical", x: 10, y: 10, width: 40, height: 40, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const layer = await screen.findByTestId("video-editor-cover-badge-layer");
    const lowerBadge = screen.getByTestId("video-editor-cover-badge-cover-lower");
    const partialBadge = screen.getByTestId("video-editor-cover-badge-cover-partial");
    const identicalBadge = screen.getByTestId("video-editor-cover-badge-cover-identical");
    expect(layer).toHaveStyle({ zIndex: "5", pointerEvents: "none" });
    expect(layer).toContainElement(lowerBadge);
    expect(layer).toContainElement(partialBadge);
    expect(layer).toContainElement(identicalBadge);
    expect([lowerBadge.textContent, partialBadge.textContent, identicalBadge.textContent]).toEqual([
      "1", "2", "3",
    ]);
    expect(lowerBadge).toHaveStyle({ left: "10%", top: "10%" });
    expect(identicalBadge).toHaveStyle({ left: "10%", top: "10%" });
    expect(lowerBadge.style.transform).not.toBe(identicalBadge.style.transform);
  });

  it("edits a fully covered overlay through its badge without reordering surfaces", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          ...Array.from({ length: 3 }, (_, index) => ({
            id: `cover-${index + 1}`,
            x: 5,
            y: 5,
            width: 20,
            height: 20,
            start: 30,
            end: 40,
          })),
          { id: "cover-4", x: 10, y: 10, width: 40, height: 40, start: 0, end: 20, mode: "blur" },
          { id: "cover-5", x: 10, y: 10, width: 40, height: 40, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const badge4 = await screen.findByTestId("video-editor-cover-badge-cover-4");
    const badge5 = screen.getByTestId("video-editor-cover-badge-cover-5");
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500,
      width: 1000, height: 500, toJSON: () => ({}),
    });
    const surfaceOrder = () =>
      Array.from(frame.querySelectorAll<HTMLElement>("[data-testid^='video-editor-cover-overlay-']"))
        .map((overlay) => overlay.dataset.testid);

    expect(badge4).toHaveTextContent("4");
    expect(screen.getByTestId("video-editor-cover-overlay-cover-4").style.backdropFilter).toBe("blur(12px)");
    expect(badge5).toHaveTextContent("5");
    expect(surfaceOrder()).toEqual([
      "video-editor-cover-overlay-cover-4",
      "video-editor-cover-overlay-cover-5",
    ]);

    await user.click(badge4);
    expect(screen.getByTestId("video-editor-overlay-row-cover-4")).toHaveAttribute(
      "data-selected",
      "true",
    );
    const resizeHandle = screen.getByTestId("video-editor-cover-resize-cover-4");
    fireEvent.pointerDown(resizeHandle, { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(document, { clientX: 600, clientY: 350 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-cover-overlay-cover-4")).toHaveStyle({
      width: "50%", height: "60%",
    });
    expect(screen.getByTestId("video-editor-cover-overlay-cover-5")).toHaveStyle({
      width: "40%", height: "40%",
    });

    const interaction = screen.getByTestId("video-editor-cover-interaction-cover-4");
    fireEvent.pointerDown(interaction, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-cover-overlay-cover-4")).toHaveStyle({
      left: "20%", top: "20%",
    });
    expect(screen.getByTestId("video-editor-cover-overlay-cover-5")).toHaveStyle({
      left: "10%", top: "10%",
    });
    expect(surfaceOrder()).toEqual([
      "video-editor-cover-overlay-cover-4",
      "video-editor-cover-overlay-cover-5",
    ]);

    await user.click(badge5);
    expect(screen.getByTestId("video-editor-overlay-row-cover-5")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await user.click(screen.getByTestId("video-editor-cover-badge-cover-4"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-4")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("fits the overlay layer to the visible video frame and updates it on resize", async () => {
    let resizeCallback: ResizeObserverCallback = () => undefined;
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-frame", x: 80, y: 80, width: 20, height: 20, start: 0, end: 20 },
        ],
        annotations: [
          { id: "arrow-frame", type: "arrow", x: 80, y: 80, width: 20, height: 20, start: 0, end: 20, rotation: 37 },
          { id: "circle-frame", type: "circle", x: 80, y: 80, width: 20, height: 20, start: 0, end: 20, rotation: 0 },
          { id: "line-frame", type: "line", x: 80, y: 80, width: 20, height: 20, start: 0, end: 20, rotation: 37 },
          { id: "symbol-frame", type: "symbol", symbol: "star", x: 80, y: 80, width: 20, height: 20, start: 0, end: 20, rotation: 37 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    try {
      const { container } = render(
        <VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />,
      );
      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
      const video = container.querySelector("video")!;
      const preview = screen.getByTestId("video-editor-preview");
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
      Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
      vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600,
        width: 1000, height: 600, toJSON: () => ({}),
      });
      const videoRect = vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600,
        width: 1000, height: 600, toJSON: () => ({}),
      });

      fireEvent.loadedMetadata(video);
      const frame = screen.getByTestId("video-editor-overlay-frame");
      expect(frame).toHaveStyle({ left: "0px", top: "18.75px", width: "1000px", height: "562.5px" });
      expect(screen.getByTestId("video-editor-arrow-arrow-frame").parentElement).toBe(frame);
      expect(screen.getByTestId("video-editor-circle-circle-frame").parentElement).toBe(frame);
      expect(screen.getByTestId("video-editor-line-line-frame").parentElement).toBe(frame);
      expect(screen.getByTestId("video-editor-symbol-symbol-frame").parentElement).toBe(frame);
      expect(screen.getByTestId("video-editor-symbol-symbol-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-circle-circle-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-arrow-arrow-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-cover-overlay-cover-frame")).toHaveStyle({
        left: "80%", top: "80%", width: "20%", height: "20%",
      });
      expect(screen.getByTestId("video-editor-cover-badge-cover-frame")).toHaveStyle({
        left: "80%", top: "80%",
      });

      videoRect.mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 600,
        width: 600, height: 600, toJSON: () => ({}),
      });
      act(() => resizeCallback([], {} as ResizeObserver));
      expect(frame).toHaveStyle({ left: "0px", top: "131.25px", width: "600px", height: "337.5px" });
      expect(screen.getByTestId("video-editor-circle-circle-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-arrow-arrow-frame").querySelector("polygon")).toHaveAttribute("transform", "rotate(37 50 50)");
      expect(screen.getByTestId("video-editor-line-line-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-line-line-frame").querySelector("line")).toHaveAttribute("stroke-width", "3");
      expect(screen.getByTestId("video-editor-symbol-symbol-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-symbol-symbol-frame").querySelector("svg > g")).toHaveAttribute("transform", "rotate(37 50 50)");
      expect(screen.getByTestId("video-editor-arrow-arrow-frame")).toHaveStyle({ left: "80%", top: "80%", width: "20%", height: "20%" });
      expect(screen.getByTestId("video-editor-cover-badge-cover-frame")).toHaveStyle({
        left: "80%", top: "80%",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reserves badge and resize space for text and hides text when the cover becomes too small", async () => {
    editorState = {
      renderStatus: "none", renderError: null, renderedVideoId: null,
      timeline: {
        version: 1,
        clips: [{ id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 }],
        overlays: [
          { id: "large", x: 0, y: 0, width: 40, height: 30, start: 0, end: 20, text: "Hallo" },
          { id: "small", x: 50, y: 50, width: 6, height: 6, start: 0, end: 20, text: "Hallo langer Text" },
          { id: "tiny", x: 70, y: 70, width: 3, height: 3, start: 0, end: 20, text: "Hallo" },
        ],
      },
    };
    const { container } = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-cover-text-large");
    const video = container.querySelector("video")!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) };
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(screen.getByTestId("video-editor-preview"), "getBoundingClientRect").mockReturnValue(rect);
    fireEvent.loadedMetadata(video);
    for (const id of ["large", "small"]) {
      const content = screen.getByTestId(`video-editor-text-content-${id}`);
      expect(content).toHaveStyle({ left: "22px", right: "12px", top: "4px", bottom: "4px", visibility: "visible", overflow: "hidden" });
      expect(content.firstChild).toHaveStyle({ textOverflow: "ellipsis", whiteSpace: "nowrap" });
      expect(screen.getByTestId(`video-editor-cover-text-${id}`)).toHaveStyle({ pointerEvents: "none", opacity: "1" });
    }
    expect(screen.getByTestId("video-editor-text-content-tiny")).toHaveStyle({ visibility: "hidden" });
    fireEvent.click(screen.getByTestId("video-editor-cover-badge-small"));
    const frame = screen.getByTestId("video-editor-overlay-frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect);
    fireEvent.pointerDown(screen.getByTestId("video-editor-cover-interaction-small"), { clientX: 500, clientY: 250 });
    fireEvent.pointerMove(document, { clientX: 510, clientY: 255 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-cover-text-small")).toHaveStyle({ left: "51%", top: "51%" });
    fireEvent.pointerDown(screen.getByTestId("video-editor-cover-resize-small"), { clientX: 570, clientY: 285 });
    fireEvent.pointerMove(document, { clientX: 540, clientY: 270 });
    fireEvent.pointerUp(document);
    expect(screen.getByTestId("video-editor-text-content-small")).toHaveStyle({ visibility: "hidden" });
  });

  it("keeps overlay dragging and resizing within the measured video frame", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-bounds", x: 60, y: 60, width: 20, height: 20, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const overlay = await screen.findByTestId("video-editor-cover-overlay-cover-bounds");
    expect(screen.getByTestId("video-editor-cover-badge-cover-bounds")).toHaveStyle({
      pointerEvents: "auto",
    });
    const frame = overlay.parentElement!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500,
      width: 1000, height: 500, toJSON: () => ({}),
    });

    fireEvent.pointerDown(overlay, { clientX: 600, clientY: 300 });
    fireEvent.pointerMove(document, { clientX: 1600, clientY: 800 });
    fireEvent.pointerUp(document);
    expect(overlay).toHaveStyle({ left: "80%", top: "80%" });

    const resizeHandle = screen.getByTestId("video-editor-cover-resize-cover-bounds");
    fireEvent.pointerDown(resizeHandle, { clientX: 800, clientY: 400 });
    fireEvent.pointerMove(document, { clientX: 1800, clientY: 900 });
    fireEvent.pointerUp(document);
    expect(overlay).toHaveStyle({ width: "20%", height: "20%" });
  });

  it("renders identical cover overlays in stable separate selectable rows", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-first", x: 5, y: 5, width: 20, height: 20, start: 10, end: 30 },
          { id: "cover-second", x: 50, y: 50, width: 20, height: 20, start: 10, end: 30 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const track = await screen.findByTestId("video-editor-overlay-track");
    expect(Array.from(track.children).map((row) => row.getAttribute("data-testid"))).toEqual([
      "video-editor-overlay-row-cover-first",
      "video-editor-overlay-row-cover-second",
    ]);
    expect(screen.getByText("Abdeckung 1")).toHaveStyle({
      left: "8.333333333333332%",
      width: "16.666666666666664%",
    });
    expect(screen.getByText("Abdeckung 2")).toHaveStyle({
      left: "8.333333333333332%",
      width: "16.666666666666664%",
    });

    fireEvent.click(screen.getByText("Abdeckung 2"));
    await user.click(screen.getByRole("button", { name: "Abdeckung löschen" }));

    expect(screen.getByTestId("video-editor-overlay-row-cover-first")).toBeInTheDocument();
    expect(screen.queryByTestId("video-editor-overlay-row-cover-second")).not.toBeInTheDocument();
  });

  it("shows up to four cover overlay rows without vertical scrolling", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 4 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const overlayScroll = await screen.findByTestId("video-editor-overlay-scroll");
    expect(overlayScroll).toHaveStyle({ maxHeight: "164px", overflowY: "visible" });
    expect(screen.getAllByTestId(/video-editor-overlay-row-/)).toHaveLength(4);
  });

  it("scrolls only the cover overlay rows from the fifth overlay onward", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 5 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const overlayScroll = await screen.findByTestId("video-editor-overlay-scroll");
    const clipTrack = screen.getByTestId("video-editor-timeline");
    expect(overlayScroll).toHaveStyle({ maxHeight: "164px", overflowY: "auto" });
    expect(screen.getAllByTestId(/video-editor-overlay-row-/)).toHaveLength(5);
    expect(overlayScroll).not.toContainElement(clipTrack);
    expect(overlayScroll.nextElementSibling).toBe(clipTrack);
  });

  it("switches the selected overlay reliably across scrolled rows", async () => {
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 6 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Abdeckung 5"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-5")).toHaveAttribute(
      "data-selected",
      "true",
    );

    fireEvent.click(screen.getByText("Abdeckung 3"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-3")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("video-editor-overlay-row-cover-5")).toHaveAttribute(
      "data-selected",
      "false",
    );

    fireEvent.click(screen.getByText("Abdeckung 6"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-6")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("video-editor-overlay-row-cover-3")).toHaveAttribute(
      "data-selected",
      "false",
    );
  });

  it("clears the selected overlay on free timeline space without deleting it", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 6 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const actionsSlot = screen.getByTestId("video-editor-cover-actions");
    await user.click(await screen.findByText("Abdeckung 5"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-5")).toHaveAttribute(
      "data-selected",
      "true",
    );

    await user.click(screen.getByTestId("video-editor-timeline"));
    expect(screen.getByTestId("video-editor-cover-actions")).toBe(actionsSlot);
    for (const row of screen.getAllByTestId(/video-editor-overlay-row-/)) {
      expect(row).toHaveAttribute("data-selected", "false");
    }
    expect(screen.getAllByTestId(/video-editor-overlay-row-/)).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Abdeckung löschen" })).not.toBeInTheDocument();

    await user.click(screen.getByText("Abdeckung 3"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-3")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("selects lower overlay rows directly after each deselection", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 6 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const timeline = await screen.findByTestId("video-editor-timeline");

    await user.click(screen.getByText("Abdeckung 6"));
    await user.click(timeline);
    await user.click(screen.getByText("Abdeckung 5"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-5")).toHaveAttribute(
      "data-selected",
      "true",
    );

    await user.click(timeline);
    await user.click(screen.getByText("Abdeckung 6"));
    expect(screen.getByTestId("video-editor-overlay-row-cover-6")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("selects overlays in arbitrary order with and without deselection", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: Array.from({ length: 6 }, (_, index) => ({
          id: `cover-${index + 1}`,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          start: index * 5,
          end: index * 5 + 10,
        })),
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };

    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const timeline = await screen.findByTestId("video-editor-timeline");

    for (const overlayNumber of [6, 2, 5, 1, 4, 3, 6]) {
      await user.click(screen.getByText(`Abdeckung ${overlayNumber}`));
      expect(screen.getByTestId(`video-editor-overlay-row-cover-${overlayNumber}`)).toHaveAttribute(
        "data-selected",
        "true",
      );
    }

    for (const overlayNumber of [2, 6, 1, 5, 3, 4]) {
      await user.click(timeline);
      await user.click(screen.getByText(`Abdeckung ${overlayNumber}`));
      expect(screen.getByTestId(`video-editor-overlay-row-cover-${overlayNumber}`)).toHaveAttribute(
        "data-selected",
        "true",
      );
    }
  });

  it("autosaves added, changed, copied and deleted cover overlays", async () => {
    vi.useFakeTimers();
    try {
      render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
      await vi.waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith("/api/videos/original/editor");
      });

      fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
      await vi.advanceTimersByTimeAsync(400);

      const addedSave = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      expect(addedSave).toBeDefined();
      const addedPayload = JSON.parse((addedSave?.[1] as RequestInit).body as string);
      expect(addedPayload.overlays).toHaveLength(1);
      expect(addedPayload.overlays[0]).toMatchObject({
        x: 30, y: 30, width: 40, height: 20, start: 0, end: 5,
      });

      const overlay = screen.getByTestId(`video-editor-cover-overlay-${addedPayload.overlays[0].id}`);
      const preview = overlay.parentElement!;
      vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500,
        width: 1000, height: 500, toJSON: () => ({}),
      });
      fireEvent.pointerDown(overlay, { clientX: 300, clientY: 150 });
      fireEvent.pointerMove(document, { clientX: 400, clientY: 250 });
      fireEvent.pointerUp(document);
      await vi.advanceTimersByTimeAsync(400);

      const movedSave = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      const movedPayload = JSON.parse((movedSave?.[1] as RequestInit).body as string);
      expect(movedPayload.overlays[0]).toMatchObject({ x: 40, y: 50 });

      const resizeHandle = screen.getByTestId(
        `video-editor-cover-resize-${addedPayload.overlays[0].id}`,
      );
      fireEvent.pointerDown(resizeHandle, { clientX: 400, clientY: 250 });
      fireEvent.pointerMove(document, { clientX: 500, clientY: 350 });
      fireEvent.pointerUp(document);

      const overlayTrack = screen.getByTestId(
        `video-editor-overlay-row-${addedPayload.overlays[0].id}`,
      );
      vi.spyOn(overlayTrack, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 38,
        width: 1000, height: 38, toJSON: () => ({}),
      });
      fireEvent.pointerDown(screen.getByTitle("Start der Abdeckung ziehen"), { clientX: 0 });
      fireEvent.pointerMove(document, { clientX: 20 });
      fireEvent.pointerUp(document);
      fireEvent.pointerDown(screen.getByTitle("Ende der Abdeckung ziehen"), { clientX: 40 });
      fireEvent.pointerMove(document, { clientX: 500 });
      fireEvent.pointerUp(document);
      await vi.advanceTimersByTimeAsync(400);

      const resizedSave = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      const resizedPayload = JSON.parse((resizedSave?.[1] as RequestInit).body as string);
      expect(resizedPayload.overlays[0]).toMatchObject({
        width: 50, height: 40, start: 2.4, end: 60,
      });

      fireEvent.click(screen.getByRole("button", { name: "Abdeckung kopieren" }));
      fireEvent.click(screen.getByRole("button", { name: "Abdeckung einfügen" }));
      await vi.advanceTimersByTimeAsync(400);
      const copiedSave = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      expect(JSON.parse((copiedSave?.[1] as RequestInit).body as string).overlays).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "Abdeckung löschen" }));
      await vi.advanceTimersByTimeAsync(400);
      const deletedSave = mockApiFetch.mock.calls.filter(
        ([path, options]) => path === "/api/videos/original/editor" && options?.method === "PUT",
      ).at(-1);
      expect(JSON.parse((deletedSave?.[1] as RequestInit).body as string).overlays).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("undoes creating a cover overlay", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    await screen.findByTestId("video-editor-timeline");
    await user.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    expect(screen.getByText("Abdeckung 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByText("Abdeckung 1")).not.toBeInTheDocument();
  });

  it("undoes copying and deleting among multiple cover overlays", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-a", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20 },
          { id: "cover-b", x: 50, y: 50, width: 30, height: 30, start: 30, end: 50 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Abdeckung 1"));
    const copyButton = screen.getByRole("button", { name: "Abdeckung kopieren" });
    expect(screen.queryByRole("button", { name: "Abdeckung einfügen" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Start/ })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Ende/ })).toBeInTheDocument();
    expect(screen.getByText("Abdeckung kopieren")).toHaveAttribute("role", "tooltip");
    expect(screen.getByText("Abdeckung löschen")).toHaveAttribute("role", "tooltip");

    await user.click(copyButton);
    const pasteButton = screen.getByRole("button", { name: "Abdeckung einfügen" });
    expect(pasteButton).toBeEnabled();
    expect(screen.getByText("Abdeckung einfügen")).toHaveAttribute("role", "tooltip");
    await user.click(pasteButton);
    expect(screen.getAllByText(/Abdeckung \d/)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getAllByText(/Abdeckung \d/)).toHaveLength(2);

    fireEvent.click(screen.getByText("Abdeckung 2"));
    await user.click(screen.getByRole("button", { name: "Abdeckung löschen" }));
    expect(screen.getAllByText(/Abdeckung \d/)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.getAllByText(/Abdeckung \d/)).toHaveLength(2);
    expect(screen.getByTestId("video-editor-cover-overlay-cover-a")).toBeInTheDocument();
  });

  it("undoes overlay position, size, start and end changes independently", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-a", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const overlay = await screen.findByTestId("video-editor-cover-overlay-cover-a");
    const preview = overlay.parentElement!;
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500,
      width: 1000, height: 500, toJSON: () => ({}),
    });

    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document);
    expect(overlay).toHaveStyle({ left: "20%", top: "20%" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(overlay).toHaveStyle({ left: "10%", top: "10%" });

    await user.click(screen.getByTestId("video-editor-cover-badge-cover-a"));
    const resizeHandle = screen.getByTestId("video-editor-cover-resize-cover-a");
    fireEvent.pointerDown(resizeHandle, { clientX: 300, clientY: 150 });
    fireEvent.pointerMove(document, { clientX: 400, clientY: 250 });
    fireEvent.pointerUp(document);
    expect(overlay).toHaveStyle({ width: "30%", height: "40%" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(overlay).toHaveStyle({ width: "20%", height: "20%" });

    const track = screen.getByTestId("video-editor-overlay-row-cover-a");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 38,
      width: 1200, height: 38, toJSON: () => ({}),
    });
    const timelineOverlay = screen.getByText("Abdeckung 1");

    fireEvent.pointerDown(timelineOverlay, { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 100 });
    fireEvent.pointerUp(document);
    expect(timelineOverlay).toHaveStyle({ left: "8.333333333333332%" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(timelineOverlay).toHaveStyle({ left: "0%", width: "16.666666666666664%" });

    fireEvent.pointerDown(screen.getByTitle("Start der Abdeckung ziehen"), { clientX: 0 });
    fireEvent.pointerMove(document, { clientX: 50 });
    fireEvent.pointerUp(document);
    expect(timelineOverlay).toHaveStyle({ left: "4.166666666666666%" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(timelineOverlay).toHaveStyle({ left: "0%" });

    fireEvent.pointerDown(screen.getByTitle("Ende der Abdeckung ziehen"), { clientX: 200 });
    fireEvent.pointerMove(document, { clientX: 300 });
    fireEvent.pointerUp(document);
    expect(timelineOverlay).toHaveStyle({ width: "25%" });
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(timelineOverlay).toHaveStyle({ width: "16.666666666666664%" });
  });

  it.each([false, true])("loads stored audio exactly, including explicitly empty arrays (%s)", async (empty) => {
    const audioSegments = empty ? [] : [{ id: "custom-audio", sourceClipId: "saved", sourceVideoId: "original", sourceStart: 3, sourceEnd: 8, timelineStart: 2 }];
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: { version: 1,
      clips: [{ id: "saved", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }], audioSegments } };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-clip-saved");
    const track = screen.getByTestId("video-editor-audio-track");
    expect(track.children).toHaveLength(empty ? 0 : 1);
    if (!empty) {
      expect(track.children[0]).toHaveAttribute("data-audio-id", "custom-audio");
      expect(track.children[0]).toHaveStyle({ left: "20%", width: "50%" });
    }
    fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    await waitFor(() => {
      const save = mockApiFetch.mock.calls.filter(([,o]) => o?.method === "PUT").at(-1);
      expect(save).toBeDefined();
      expect(JSON.parse(save![1].body).audioSegments).toEqual(audioSegments);
    });
    fireEvent.click(screen.getByRole("button", { name: "Als neues Video rendern" }));
    const request = mockApiFetch.mock.calls.find(([path]) => path === "/api/videos/original/editor/render");
    expect(JSON.parse(request![1].body).audioSegments).toEqual(audioSegments);
  });

  it("deletes coupled audio with its clip and restores both with one undo", async () => {
    const user = userEvent.setup();
    await renderWithInsertedVideo();
    expectCoupledAudio();
    const before = Array.from(screen.getByTestId("video-editor-audio-track").children).map((e) => e.getAttribute("data-audio-id"));
    // Insertion selects the inserted clip.
    await user.click(screen.getByRole("button", { name: "Clip löschen" }));
    expectCoupledAudio();
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expectCoupledAudio();
    expect(Array.from(screen.getByTestId("video-editor-audio-track").children).map((e) => e.getAttribute("data-audio-id"))).toEqual(before);
  });

  it("includes derived audio in the pending keepalive save and restores it on reload", async () => {
    const view = render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-audio-clip-1");
    fireEvent.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    view.unmount();
    const call = mockApiFetch.mock.calls.find(([,o]) => o?.method === "PUT" && o.keepalive);
    expect(call).toBeDefined();
    const timeline = JSON.parse(call![1].body);
    expect(timeline.audioSegments).toEqual([{ geometryLinked: true, id: "audio:clip-1", sourceClipId: "clip-1", sourceVideoId: "original", sourceStart: 0, sourceEnd: 120, timelineStart: 0 }]);
    editorState = { ...emptyEditorState, renderStatus: "none", timeline };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    expect(await screen.findByTestId("video-editor-audio-clip-1")).toHaveAttribute("data-audio-id", "audio:clip-1");
  });

  it("derives stable original audio from clip IDs including repeated sources", async () => {
    const clips = [
      { id: "one", sourceId: "original", sourceStart: 2, sourceEnd: 7, duration: 5 },
      { id: "two", sourceId: "inserted", sourceStart: 4, sourceEnd: 14, duration: 10 },
      { id: "three", sourceId: "original", sourceStart: 20, sourceEnd: 25, duration: 5 },
    ];
    editorState = { ...emptyEditorState, renderStatus: "none", timeline: { version: 1, clips } };
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    await screen.findByTestId("video-editor-audio-three");
    expectCoupledAudio();
    for (const clip of clips) {
      const segment = screen.getByTestId(`video-editor-audio-${clip.id}`);
      expect(segment).toHaveAttribute("data-source-video-id", clip.sourceId);
      expect(segment).toHaveAttribute("data-source-start", String(clip.sourceStart));
      expect(segment).toHaveAttribute("data-source-end", String(clip.sourceEnd));
      expect(segment).toHaveAttribute("data-audio-id", `audio:${clip.id}`);
    }
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    expectCoupledAudio();
    expect(screen.getByTestId("video-editor-audio-track")).toHaveStyle({ width: "200%" });
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(document.querySelector("audio")).not.toHaveAttribute("controls");
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });

  it("keeps overlays intact when undoing an existing clip action", async () => {
    const user = userEvent.setup();
    editorState = {
      timeline: {
        version: 1,
        clips: [
          { id: "clip-1", sourceId: "original", sourceStart: 0, sourceEnd: 120, duration: 120 },
        ],
        overlays: [
          { id: "cover-a", x: 10, y: 10, width: 20, height: 20, start: 0, end: 20 },
        ],
      },
      renderStatus: "none",
      renderError: null,
      renderedVideoId: null,
    };
    libraryVideos = [
      { id: "inserted", title: "Inserted source", status: "ready", duration: 30 },
    ];
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    await screen.findByTestId("video-editor-cover-overlay-cover-a");
    await user.click(screen.getByRole("button", { name: /Video einfügen/ }));
    await user.click(await screen.findByRole("button", { name: /Inserted source/ }));
    await user.click(screen.getByRole("button", { name: "Hier einfügen" }));
    expect(screen.getByText("Eingefügt: Inserted source")).toBeInTheDocument();
    expectCoupledAudio();
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByText("Eingefügt: Inserted source")).not.toBeInTheDocument();
    expectCoupledAudio();
    expect(screen.getByTestId("video-editor-audio-track").children).toHaveLength(1);
    expect(screen.getByTestId("video-editor-cover-overlay-cover-a")).toBeInTheDocument();
  });

  it("sends the complete ordered timeline when rendering starts", async () => {
    const user = userEvent.setup();
    await renderWithInsertedVideo();

    await user.click(screen.getByRole("button", { name: "Als neues Video rendern" }));

    await waitFor(() => {
      const renderCall = mockApiFetch.mock.calls.find(
        ([path]) => path === "/api/videos/original/editor/render",
      );
      expect(renderCall).toBeDefined();
      const payload = JSON.parse((renderCall?.[1] as RequestInit).body as string);
      expect(payload.version).toBe(1);
      expect(payload.clips.map((clip: { sourceId: string }) => clip.sourceId)).toEqual([
        "inserted",
        "original",
      ]);
    expect(payload.clips[0]).toMatchObject({
        sourceId: "inserted",
        sourceStart: 0,
        sourceEnd: 30,
        duration: 30,
      });
      expect(payload.audioSegments).toHaveLength(payload.clips.length);
      let offset = 0;
      for (const [index, clip] of payload.clips.entries()) {
        expect(payload.audioSegments[index]).toMatchObject({ sourceClipId: clip.id, sourceVideoId: clip.sourceId,
          sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, timelineStart: offset });
        offset += clip.duration;
      }
    });
    expect(screen.getByRole("button", { name: "Video wird gerendert..." })).toBeDisabled();
  });

  it("offers Fit, 2x, 5x and 10x zoom without changing timeline data", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const timeline = await screen.findByTestId("video-editor-timeline");
    const slider = screen.getByRole("slider", { name: "Timeline-Zoom" });
    const fitButton = screen.getByRole("button", { name: "Ansicht einpassen" });
    const zoomOutButton = screen.getByRole("button", { name: "Verkleinern" });
    const zoomInButton = screen.getByRole("button", { name: "Vergrößern" });

    for (const button of [fitButton, zoomOutButton, zoomInButton]) {
      expect(button).toHaveClass("video-editor-tool-button");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).toHaveAttribute("aria-describedby");
    }
    expect(screen.getByText("Ansicht einpassen")).toHaveClass(
      "video-editor-tool-tooltip--left-edge",
    );
    expect(screen.getByText("Verkleinern")).toHaveAttribute("role", "tooltip");
    expect(screen.getByText("Vergrößern")).toHaveAttribute("role", "tooltip");

    expect(timeline).toHaveAttribute("data-zoom", "1");
    expect(zoomOutButton).toBeDisabled();
    await user.click(zoomInButton);
    expect(timeline).toHaveAttribute("data-zoom", "2");
    await user.click(zoomInButton);
    expect(timeline).toHaveAttribute("data-zoom", "5");
    await user.click(zoomInButton);
    expect(timeline).toHaveAttribute("data-zoom", "10");
    expect(slider).toHaveValue("3");

    await user.click(zoomOutButton);
    expect(timeline).toHaveAttribute("data-zoom", "5");
    await user.click(fitButton);
    expect(timeline).toHaveAttribute("data-zoom", "1");
    expect(screen.getAllByText("2:00")).not.toHaveLength(0);
  });

  it("keeps all five icon toolbar actions accessible with tooltips", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    await screen.findByTestId("video-editor-timeline");
    const toolbarButtons = [
      screen.getByRole("button", { name: "Trimmen" }),
      screen.getByRole("button", { name: "Teilen" }),
      screen.getByRole("button", { name: "+ Abdeckung" }),
      screen.getByRole("button", { name: "Video einfügen" }),
      screen.getByRole("button", { name: "↶ Rückgängig" }),
    ];

    for (const button of toolbarButtons) {
      expect(button).toHaveClass("video-editor-tool-button");
      const icon = button.querySelector("svg");
      expect(icon).toHaveAttribute("width", "16");
      expect(icon).toHaveAttribute("height", "16");
      expect(icon).toHaveAttribute("viewBox", "0 0 16 16");
      expect(icon).toHaveAttribute("fill", "none");
      expect(icon).toHaveAttribute("stroke", "currentColor");
    }
    expect(toolbarButtons.every((button) => button.textContent === "")).toBe(true);
    expect(screen.getAllByRole("tooltip", { hidden: true }).map((tooltip) => tooltip.textContent?.trim())).toEqual([
      "Trimmen",
      "Teilen",
      "Abdeckung hinzufügen",
      "Pfeil hinzufügen",
      "Kreis hinzufügen",
      "Symbol hinzufügen",
      "Linie hinzufügen",
      "Video einfügen",
      "Rückgängig",
      "Ansicht einpassen",
      "Verkleinern",
      "Vergrößern",
    ]);
    expect(toolbarButtons[4]).toBeDisabled();

    await user.click(toolbarButtons[2]);
    expect(toolbarButtons[4]).toBeEnabled();
    await user.click(toolbarButtons[4]);
    expect(screen.queryByText("Abdeckung 1")).not.toBeInTheDocument();
  });

  it("deletes only the selected cover overlay", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);

    const timeline = await screen.findByTestId("video-editor-timeline");
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 64,
      width: 1000, height: 64, toJSON: () => ({}),
    });

    await user.click(screen.getByRole("button", { name: "+ Abdeckung" }));
    fireEvent.click(timeline, { clientX: 500 });
    await user.click(screen.getByRole("button", { name: "+ Abdeckung" }));

    fireEvent.click(screen.getByText("Abdeckung 1"));
    await user.click(screen.getByRole("button", { name: "Abdeckung löschen" }));

    expect(screen.queryByText("Abdeckung 2")).not.toBeInTheDocument();
    expect(screen.getAllByText("Abdeckung 1")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Abdeckung löschen" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Als neues Video rendern" }));
    await waitFor(() => {
      const renderCall = mockApiFetch.mock.calls.find(
        ([path]) => path === "/api/videos/original/editor/render",
      );
      const payload = JSON.parse((renderCall?.[1] as RequestInit).body as string);
      expect(payload.overlays).toHaveLength(1);
      expect(payload.overlays[0].start).toBeCloseTo(60, 3);
    });
  });

  it("uses finer time markers as the timeline is zoomed", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={8} onClose={vi.fn()} />);

    const ruler = await screen.findByTestId("video-editor-timeline-ruler");
    expect(ruler).toHaveAttribute("data-tick-step", "1");

    await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    expect(ruler).toHaveAttribute("data-tick-step", "0.5");
    await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    expect(ruler).toHaveAttribute("data-tick-step", "0.5");
    await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    expect(ruler).toHaveAttribute("data-tick-step", "0.1");
  });

  it("maps clicks against the zoomed timeline width", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />,
    );
    const timeline = await screen.findByTestId("video-editor-timeline");
    await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      x: -250,
      y: 0,
      left: -250,
      top: 0,
      right: 1750,
      bottom: 64,
      width: 2000,
      height: 64,
      toJSON: () => ({}),
    });

    fireEvent.click(timeline, { clientX: 750 });
    await waitFor(() => {
      expect(container.querySelector("video")?.currentTime).toBeCloseTo(60, 3);
    });
  });

  it("splits precisely at the playhead while zoomed to 10x", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const timeline = await screen.findByTestId("video-editor-timeline");
    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    }
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 10000, bottom: 64,
      width: 10000, height: 64, toJSON: () => ({}),
    });

    fireEvent.click(timeline, { clientX: 3333.333 });
    await user.click(screen.getByRole("button", { name: "Teilen" }));

    expect(screen.getByText("Clip 1")).toHaveStyle({ width: "33.33333%" });
    expect(screen.getByText("Clip 2")).toHaveStyle({ width: "66.66667%" });
    expectCoupledAudio();
    const audioSegments = screen.getByTestId("video-editor-audio-track").children;
    expect(audioSegments).toHaveLength(2);
    expect(audioSegments[0]).toHaveAttribute("data-source-video-id", "original");
    expect(audioSegments[1]).toHaveAttribute("data-source-video-id", "original");
    expect(audioSegments[0].getAttribute("data-source-end")).toBe(audioSegments[1].getAttribute("data-source-start"));
  });

  it("keeps trim dragging precise while zoomed to 10x", async () => {
    const user = userEvent.setup();
    render(<VideoEditorModal videoId="original" duration={120} onClose={vi.fn()} />);
    const timeline = await screen.findByTestId("video-editor-timeline");
    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: "Vergrößern" }));
    }
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 10000, bottom: 64,
      width: 10000, height: 64, toJSON: () => ({}),
    });

    fireEvent.mouseDown(screen.getByTitle("Trim-Anfang"));
    fireEvent.mouseMove(document, { clientX: 1000 });
    fireEvent.mouseUp(document);

    expect(screen.getByText("Anfang: 0:12")).toBeInTheDocument();
  });
});
