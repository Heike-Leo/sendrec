import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoEditorModal } from "./VideoEditorModal";

const mockApiFetch = vi.fn();

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
      annotations?: Array<{ id: string; type: "arrow" | "circle"; x: number; y: number; width: number; height: number; start: number; end: number; rotation: number; color?: string }>;
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

    await user.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
    expect(screen.queryByText("Eingefügt: Inserted source")).not.toBeInTheDocument();
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
