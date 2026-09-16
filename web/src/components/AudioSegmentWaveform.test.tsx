import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AudioSegmentWaveform, type AudioWaveformCache } from "./AudioSegmentWaveform";
import { loadAudioWaveformPeaks } from "./editorAudioWaveform";

vi.mock("./editorAudioWaveform", async importOriginal => ({
  ...await importOriginal<typeof import("./editorAudioWaveform")>(), loadAudioWaveformPeaks: vi.fn(),
}));

describe("audio segment waveform visualization", () => {
  const peaks = { min: new Float32Array([0, -0.25, -0.5, -1]), max: new Float32Array([0, 0.25, 0.5, 1]),
    sampleRate: 1000, sampleCount: 4000, samplesPerPeak: 1000 };
  let cache: AudioWaveformCache;
  let loadUrl: ReturnType<typeof vi.fn<(id: string) => string | Promise<string>>>;
  let fillRect: ReturnType<typeof vi.fn>;
  let resize: () => void;
  let disconnect: ReturnType<typeof vi.fn>;
  let width: number;
  beforeEach(() => {
    cache = new Map(); loadUrl = vi.fn<(id: string) => string | Promise<string>>(id => `https://media.example/${id}`);
    vi.mocked(loadAudioWaveformPeaks).mockReset().mockResolvedValue(peaks);
    fillRect = vi.fn(); width = 2; disconnect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect, clearRect: vi.fn(), fillStyle: "" } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 20 } as DOMRect));
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const view = (id = "one", start = 1, end = 3, zoom = 1) =>
    <AudioSegmentWaveform sourceVideoId={id} sourceStart={start} sourceEnd={end} zoom={zoom} cache={cache} loadUrl={loadUrl} />;

  it("draws precisely the segment source interval with fixed amplitude and no pointer events", async () => {
    render(view());
    const canvas = await screen.findByTestId("audio-waveform");
    expect(canvas.style.pointerEvents).toBe("none");
    // The canvas can be committed before its passive drawing effect has run.
    await waitFor(() => expect(fillRect.mock.calls).toEqual([[0, 8, 1, 4], [1, 6, 1, 8]]));
  });
  it("deduplicates simultaneous segments of one source and loads other sources separately", async () => {
    render(<>{view()}{view("one", 0, 1)}{view("two")}</>);
    await waitFor(() => expect(screen.getAllByTestId("audio-waveform")).toHaveLength(3));
    expect(loadUrl.mock.calls).toEqual([["one"], ["two"]]);
    expect(loadAudioWaveformPeaks).toHaveBeenCalledTimes(2);
  });
  it("redraws on zoom, resize and draft trimming without analyzing again", async () => {
    const rendered = render(view());
    await screen.findByTestId("audio-waveform");
    fillRect.mockClear();
    rendered.rerender(view("one", 2, 4, 10));
    expect(fillRect.mock.calls).toEqual([[0, 6, 1, 8], [1, 2, 1, 16]]);
    width = 4; vi.stubGlobal("devicePixelRatio", 2);
    act(() => resize());
    const canvas = screen.getByTestId("audio-waveform") as HTMLCanvasElement;
    expect(canvas.width).toBe(8); expect(canvas.height).toBe(40);
    expect(loadAudioWaveformPeaks).toHaveBeenCalledTimes(1);
  });
  it("keeps segment selection and resize controls usable after analysis failure", async () => {
    vi.mocked(loadAudioWaveformPeaks).mockRejectedValue(new Error("decode"));
    const move = vi.fn(), trim = vi.fn();
    render(<div onPointerDown={move} data-testid="segment">{view()}<button onPointerDown={e => { e.stopPropagation(); trim(); }}>Trim</button></div>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("audio-waveform")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("segment"));
    fireEvent.pointerDown(screen.getByText("Trim"));
    expect(move).toHaveBeenCalledTimes(1); expect(trim).toHaveBeenCalledTimes(1);
  });
  it("shows no waveform while loading and ignores completion after unmount", async () => {
    let resolve!: (value: typeof peaks) => void;
    vi.mocked(loadAudioWaveformPeaks).mockReturnValue(new Promise(done => { resolve = done; }));
    const rendered = render(view());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("audio-waveform")).toBeNull();
    rendered.unmount();
    await act(async () => resolve(peaks));
    expect(fillRect).not.toHaveBeenCalled();
  });
  it("does not analyze empty intervals", () => {
    render(view("one", 2, 2));
    expect(screen.queryByTestId("audio-waveform")).toBeNull();
    expect(loadUrl).not.toHaveBeenCalled();
  });
  it("does not reuse one source's waveform while another source loads", async () => {
    const rendered = render(view()); await screen.findByTestId("audio-waveform");
    vi.mocked(loadAudioWaveformPeaks).mockReturnValue(new Promise(() => {}));
    rendered.rerender(view("two"));
    expect(screen.queryByTestId("audio-waveform")).toBeNull();
  });
  it("cleans resize observation on unmount and retains source data only in the supplied cache", async () => {
    const rendered = render(view()); await screen.findByTestId("audio-waveform");
    rendered.unmount(); expect(disconnect).toHaveBeenCalled();
    cache = new Map(); render(view()); await screen.findByTestId("audio-waveform");
    expect(loadAudioWaveformPeaks).toHaveBeenCalledTimes(2);
  });
});
