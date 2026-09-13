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
      }>;
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
      expect(screen.getByTestId("video-editor-cover-badge-cover-frame")).toHaveStyle({
        left: "80%", top: "80%",
      });
    } finally {
      vi.unstubAllGlobals();
    }
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
