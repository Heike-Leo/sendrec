import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoEditorModal } from "./VideoEditorModal";
import type { EditorAnnotation, TextAnnotation } from "./editorAnnotations";

const api = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ apiFetch: api }));
vi.mock("./editorAudioWaveform", async original => ({
  ...await original<typeof import("./editorAudioWaveform")>(), loadAudioWaveformPeaks: vi.fn().mockRejectedValue(new Error("unused")),
}));
const text = (patch: Partial<TextAnnotation> = {}): TextAnnotation => ({ id: "text-a", type: "text", text: "Hinweis", x: 10, y: 20, width: 40, height: 10, fontSize: 32, start: 0, end: 5, ...patch });
type Timeline = { version: number; clips: { id: string; sourceId: string; sourceStart: number; sourceEnd: number; duration: number }[]; annotations: EditorAnnotation[]; audioSegments: never[] };
let timeline: Timeline;
const callbacks = new Set<ResizeObserverCallback>();
const rect = (width: number, height: number, left = 0, top = 0): DOMRect => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) });
const undo = () => fireEvent.click(screen.getByRole("button", { name: "↶ Rückgängig" }));
const select = (index = 1) => fireEvent.click(screen.getByRole("button", { name: `Text ${index}` }));
const content = (id = "text-a") => screen.getByTestId(`video-editor-annotation-text-content-${id}`);
function drag(target: HTMLElement, dx: number, dy = 0) {
  fireEvent.pointerDown(target, { clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { clientX: dx / 2, clientY: dy / 2 });
  fireEvent.pointerMove(document, { clientX: dx, clientY: dy });
  fireEvent.pointerUp(document);
}
async function open(sourceWidth = 1920, sourceHeight = 1080) {
  const view = render(<VideoEditorModal videoId="original" duration={10} onClose={vi.fn()} />);
  await screen.findByTestId("video-editor-preview");
  const video = view.container.querySelector("video")!;
  Object.defineProperty(video, "videoWidth", { configurable: true, value: sourceWidth });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: sourceHeight });
  const bounds = vi.spyOn(video, "getBoundingClientRect").mockReturnValue(rect(960, 540));
  vi.spyOn(screen.getByTestId("video-editor-preview"), "getBoundingClientRect").mockReturnValue(rect(960, 540));
  fireEvent.loadedMetadata(video);
  return { ...view, video, bounds };
}
beforeEach(() => {
  callbacks.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: ResizeObserverCallback) { callbacks.add(cb); }
    observe() {} unobserve() {} disconnect() { callbacks.delete(this.cb); }
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  timeline = { version: 1, clips: [{ id: "clip", sourceId: "original", sourceStart: 0, sourceEnd: 10, duration: 10 }], annotations: [], audioSegments: [] };
  api.mockReset().mockImplementation((path: string, options?: RequestInit) => {
    if (path.endsWith("/download")) return Promise.resolve({ downloadUrl: "https://media.example/video.mp4" });
    if (!options && path.endsWith("/editor")) return Promise.resolve({ timeline, renderStatus: "none", renderError: null, renderedVideoId: null });
    if (options?.method === "PUT") { timeline = JSON.parse(String(options.body)); return Promise.resolve(); }
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("text annotation preview", () => {
  it("enters two and three lines with Enter in one undo session, without growing the box", async () => {
    const user = userEvent.setup();
    timeline.annotations = [text()]; await open(); select();
    const input = screen.getByLabelText("Textinhalt");
    expect(input.tagName).toBe("TEXTAREA");
    const box = content().parentElement!;
    const initialSize = { width: box.style.width, height: box.style.height };
    await user.clear(input);
    await user.type(input, "Grüße aus Oldenburg{Enter}äöü ÄÖÜ ß");
    expect(input).toHaveValue("Grüße aus Oldenburg\näöü ÄÖÜ ß");
    expect(content().textContent).toBe("Grüße aus Oldenburg\näöü ÄÖÜ ß");
    await user.type(input, "{Enter}Zeile 3");
    expect(content().textContent).toBe("Grüße aus Oldenburg\näöü ÄÖÜ ß\nZeile 3");
    expect(content()).toHaveStyle({ whiteSpace: "pre", overflow: "hidden", lineHeight: "1.2" });
    expect(box).toHaveStyle(initialSize);
    await user.tab(); undo();
    expect(content().textContent).toBe("Hinweis");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  it("clips long single lines and excess explicit lines without wrapping or changing geometry", async () => {
    timeline.annotations = [text({ height: 1 })]; await open(); select();
    const input = screen.getByLabelText("Textinhalt");
    for (const value of ["L".repeat(120), "Zeile\n".repeat(20)]) {
      fireEvent.change(input, { target: { value } });
      expect(content().textContent).toBe(value);
      expect(content()).toHaveStyle({ whiteSpace: "pre", overflow: "hidden", lineHeight: "1.2" });
      expect(content().parentElement).toHaveStyle({ width: "384px", height: "5.4px" });
    }
    fireEvent.change(input, { target: { value: "a".repeat(119) + "\nb" } });
    expect(content().textContent).toBe("a".repeat(119) + "\n");
  });

  it.each(["\n", " \n  \n", "\t\n \t"])("does not persist whitespace-only multiline draft %j", async value => {
    timeline.annotations = [text()]; await open(); select();
    const input = screen.getByLabelText("Textinhalt");
    fireEvent.focus(input); fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(input).toHaveValue("Hinweis");
    expect(content().textContent).toBe("Hinweis");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
    expect(api.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });

  it("preserves newlines through save, reload and copy/paste while keeping render blocked", async () => {
    const multiline = "Zeile 1\nZeile 2\nZeile 3";
    timeline.annotations = [text()]; let view = await open(); select();
    fireEvent.focus(screen.getByLabelText("Textinhalt"));
    fireEvent.change(screen.getByLabelText("Textinhalt"), { target: { value: multiline } });
    fireEvent.blur(screen.getByLabelText("Textinhalt"));
    await waitFor(() => expect((timeline.annotations[0] as TextAnnotation).text).toBe(multiline));
    fireEvent.click(screen.getByRole("button", { name: "Text kopieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Text einfügen" }));
    await waitFor(() => expect(timeline.annotations).toHaveLength(2));
    expect((timeline.annotations[1] as TextAnnotation).text).toBe(multiline);
    expect(timeline.annotations[1].id).not.toBe(timeline.annotations[0].id);
    view.unmount(); view = await open(); select(2);
    expect(screen.getByLabelText("Textinhalt")).toHaveValue(multiline);
    expect(content(timeline.annotations[1].id).textContent).toBe(multiline);
    fireEvent.click(screen.getByRole("button", { name: "Als neues Video rendern" }));
    expect(await screen.findByText("Text annotations are not yet supported for rendering")).toBeVisible();
    expect(api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("adds defaults, selects, clips plain HTML text and undoes creation", async () => {
    const { video } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Text hinzufügen" }));
    expect(screen.getByRole("button", { name: "Text 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Textinhalt")).toHaveValue("Text");
    expect(screen.getByLabelText("Textgröße")).toHaveValue(32);
    expect(screen.getByLabelText("Textfarbe")).toHaveValue("#ffffff");
    expect(screen.queryByLabelText("Textrichtung")).toBeNull();
    const span = screen.getByTestId(/^video-editor-annotation-text-content-/);
    expect(span).toHaveStyle({ fontSize: "16px", pointerEvents: "none", whiteSpace: "pre", overflow: "hidden" });
    expect(span.parentElement).toHaveStyle({ left: "288px", top: "243px", width: "384px", height: "54px" });
    expect(span.parentElement?.querySelector("svg")).toBeNull();
    expect(video.style.aspectRatio).toBe("16 / 9");
    undo();
    expect(screen.queryByRole("button", { name: "Text 1" })).toBeNull();
    expect(video.style.aspectRatio).toBe("");
  });

  it("groups typing into one undo, preserves Unicode and treats markup literally", async () => {
    timeline.annotations = [text()]; await open(); select();
    const input = screen.getByLabelText("Textinhalt");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "äöüÄÖÜß" } });
    fireEvent.change(input, { target: { value: "<b>äöüÄÖÜß</b>" } });
    expect(content().textContent).toBe("<b>äöüÄÖÜß</b>");
    expect(content().querySelector("b")).toBeNull();
    fireEvent.blur(input); undo();
    expect(content()).toHaveTextContent("Hinweis");
    expect(screen.getByRole("button", { name: "↶ Rückgängig" })).toBeDisabled();
  });

  it("caps codepoints and never saves a blank/invalid draft", async () => {
    timeline.annotations = [text()]; await open(); select();
    const input = screen.getByLabelText("Textinhalt");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ä".repeat(121) } });
    expect(content().textContent).toHaveLength(120);
    await waitFor(() => expect((timeline.annotations[0] as TextAnnotation).text).toHaveLength(120));
    fireEvent.change(input, { target: { value: "" } });
    expect(content().textContent).toBe("");
    fireEvent.blur(input);
    expect(content().textContent).toHaveLength(120);
    fireEvent.change(input, { target: { value: "a\u0001" } });
    fireEvent.blur(input);
    expect(content().textContent).toHaveLength(120);
  });

  it("changes font size and color with separate undo and unchanged geometry", async () => {
    timeline.annotations = [text()]; await open(); select();
    fireEvent.focus(screen.getByLabelText("Textgröße"));
    fireEvent.change(screen.getByLabelText("Textgröße"), { target: { value: "64" } });
    fireEvent.blur(screen.getByLabelText("Textgröße"));
    expect(content()).toHaveStyle({ fontSize: "32px", textAlign: "left" });
    expect(content().parentElement).toHaveStyle({ width: "384px", height: "54px" });
    fireEvent.change(screen.getByLabelText("Textfarbe"), { target: { value: "#e6467a" } });
    expect(content()).toHaveStyle({ color: "#e6467a" });
    undo(); expect(content()).toHaveStyle({ color: "#ffffff", fontSize: "32px" });
    undo(); expect(content()).toHaveStyle({ fontSize: "16px" });
    select();
    for (const value of ["0", "257"]) fireEvent.change(screen.getByLabelText("Textgröße"), { target: { value } });
    expect(content()).toHaveStyle({ fontSize: "16px" });
  });

  it.each([[1920,1080,0,0,960,540], [1080,1920,328.125,0,303.75,540], [1920,800,0,70,960,400]])("maps canonical text for source %s×%s without changing shape geometry", async (w,h,left,top,width,height) => {
    timeline.annotations = [text(), { id:"arrow", type:"arrow", x:10,y:20,width:30,height:20,start:0,end:5,rotation:37 }];
    const view = await open(w,h);
    expect(screen.getByTestId("video-editor-text-frame")).toHaveStyle({ left: "0px", top:"0px", width:"960px",height:"540px" });
    expect(content().parentElement).toHaveStyle({ left:"96px",top:"108px",width:"384px",height:"54px" });
    expect(screen.getByTestId("video-editor-overlay-frame")).toHaveStyle({ left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px` });
    expect(screen.getByTestId("video-editor-arrow-arrow")).toHaveStyle({ left:"10%",top:"20%" });
    view.bounds.mockReturnValue(rect(480,270));
    act(() => callbacks.forEach(cb => cb([], {} as ResizeObserver)));
    expect(content()).toHaveStyle({ fontSize:"8px" });
    expect(content().parentElement).toHaveStyle({ left:"48px",top:"54px",width:"192px",height:"27px" });
  });

  it("drags and resizes in canonical pixels with clamping and one undo each", async () => {
    timeline.annotations = [text()]; await open(1080,1920); select();
    vi.spyOn(screen.getByTestId("video-editor-text-frame"),"getBoundingClientRect").mockReturnValue(rect(960,540));
    drag(content().parentElement!,96,54);
    expect(content().parentElement).toHaveStyle({ left:"192px",top:"162px" });
    undo(); expect(content().parentElement).toHaveStyle({ left:"96px",top:"108px" });
    expect(screen.getByRole("button",{name:"↶ Rückgängig"})).toBeDisabled();
    drag(content().parentElement!,9999,9999);
    expect(content().parentElement).toHaveStyle({ left:"576px",top:"486px" });
    undo(); select();
    drag(screen.getByTestId("video-editor-text-resize-text-a"),96,54);
    expect(content().parentElement).toHaveStyle({ width:"480px",height:"108px" });
    expect(content()).toHaveStyle({ fontSize:"16px" });
    undo(); select();
    drag(screen.getByTestId("video-editor-text-resize-text-a"),-9999,-9999);
    expect(content().parentElement).toHaveStyle({ width:"9.6px",height:"5.4px" });
    undo(); select();
    drag(screen.getByTestId("video-editor-text-resize-text-a"),9999,9999);
    expect(content().parentElement).toHaveStyle({ width:"864px",height:"432px" });
    undo();
    drag(content().parentElement!,0,0);
    expect(screen.getByRole("button",{name:"↶ Rückgängig"})).toBeDisabled();
  });

  it("edits timeline edges/move independently, enforces minimum, supports overlap and visibility", async () => {
    timeline.annotations = [text(), text({id:"text-b",text:"Zwei",start:0,end:5})];
    const { video } = await open(); select();
    const track = screen.getByTestId("video-editor-text-track-text-a");
    vi.spyOn(track,"getBoundingClientRect").mockReturnValue(rect(1000,38));
    drag(screen.getByTestId("video-editor-text-start-text-a"),100);
    expect(screen.getByLabelText("Text Start")).toHaveValue(1);
    expect(screen.queryByTestId("video-editor-annotation-text-content-text-a")).toBeNull();
    undo();
    drag(screen.getByTestId("video-editor-text-end-text-a"),-100);
    expect(screen.getByLabelText("Text Ende")).toHaveValue(4);
    undo();
    drag(screen.getByRole("button",{name:"Text 1"}),200);
    expect(screen.getByLabelText("Text Start")).toHaveValue(2);
    expect(screen.getByLabelText("Text Ende")).toHaveValue(7);
    expect(screen.getByRole("button",{name:"Text 2"})).toHaveStyle({left:"0%",width:"50%"});
    video.currentTime=3; fireEvent.timeUpdate(video);
    expect(content()).toBeVisible(); expect(content("text-b")).toBeVisible();
    video.currentTime=8; fireEvent.timeUpdate(video);
    expect(screen.queryByTestId("video-editor-annotation-text-content-text-a")).toBeNull();
    undo();
    drag(screen.getByTestId("video-editor-text-start-text-a"),9999);
    expect(screen.getByLabelText("Text Start")).toHaveValue(4.9);
    undo();
    drag(screen.getByRole("button",{name:"Text 1"}),9999);
    expect(screen.getByLabelText("Text Ende")).toHaveValue(10);
    undo();
    drag(screen.getByRole("button",{name:"Text 1"}),-9999);
    expect(screen.getByLabelText("Text Start")).toHaveValue(0);
  });

  it("copies all fields with new ID and persists/reloads without enabling render", async () => {
    timeline.annotations = [text({fontSize:64,color:"#123456",text:"Änderung ß",start:1,end:6})];
    let view = await open(); select();
    fireEvent.click(screen.getByRole("button",{name:"Text kopieren"}));
    fireEvent.click(screen.getByRole("button",{name:"Text einfügen"}));
    await waitFor(() => expect(timeline.annotations).toHaveLength(2));
    expect(timeline.annotations[1]).toEqual({...timeline.annotations[0],id:expect.any(String)});
    expect(timeline.annotations[1].id).not.toBe(timeline.annotations[0].id);
    fireEvent.click(screen.getByRole("button",{name:"Als neues Video rendern"}));
    expect(await screen.findByText("Text annotations are not yet supported for rendering")).toBeVisible();
    expect(api.mock.calls.some(([,opts]) => opts?.method === "POST")).toBe(false);
    const saved=structuredClone(timeline);
    view.unmount(); view = await open(); select(2);
    expect(screen.getByLabelText("Textinhalt")).toHaveValue("Änderung ß");
    expect(screen.getByLabelText("Textgröße")).toHaveValue(64);
    expect(screen.getByLabelText("Textfarbe")).toHaveValue("#123456");
    expect(screen.getByLabelText("Text Start")).toHaveValue(1);
    expect(screen.getByLabelText("Text Ende")).toHaveValue(6);
    view.video.currentTime=2;fireEvent.timeUpdate(view.video);
    expect(content(saved.annotations[1].id).parentElement).toHaveStyle({left:"96px",top:"108px",width:"384px",height:"54px"});
  });

  it("saves actual content, geometry, time, size and color edits then reloads all fields", async () => {
    timeline.annotations = [text()];
    let view = await open(); select();
    fireEvent.focus(screen.getByLabelText("Textinhalt"));
    fireEvent.change(screen.getByLabelText("Textinhalt"), { target: { value: "Neu äöüß" } });
    fireEvent.blur(screen.getByLabelText("Textinhalt"));
    fireEvent.change(screen.getByLabelText("Textgröße"), { target: { value: "48" } });
    fireEvent.blur(screen.getByLabelText("Textgröße"));
    fireEvent.change(screen.getByLabelText("Textfarbe"), { target: { value: "#e6467a" } });
    vi.spyOn(screen.getByTestId("video-editor-text-frame"), "getBoundingClientRect").mockReturnValue(rect(960,540));
    drag(content().parentElement!,96,54);
    drag(screen.getByTestId("video-editor-text-resize-text-a"),96,54);
    fireEvent.change(screen.getByLabelText("Text Start"),{target:{value:"1"}});
    fireEvent.change(screen.getByLabelText("Text Ende"),{target:{value:"7"}});
    const expected = text({text:"Neu äöüß",fontSize:48,color:"#e6467a",x:20,y:30,width:50,height:20,start:1,end:7});
    await waitFor(() => expect(timeline.annotations).toEqual([expected]));
    view.unmount(); view=await open(); select();
    expect(screen.getByLabelText("Textinhalt")).toHaveValue(expected.text);
    expect(screen.getByLabelText("Textgröße")).toHaveValue(48);
    expect(screen.getByLabelText("Textfarbe")).toHaveValue("#e6467a");
    view.video.currentTime=2; fireEvent.timeUpdate(view.video);
    expect(content().parentElement).toHaveStyle({left:"192px",top:"162px",width:"480px",height:"108px"});
    expect(content()).toHaveStyle({fontSize:"24px"});
  });

  it("uses zoomed track width and does not record an ineffective border drag", async () => {
    timeline.annotations=[text({x:0,y:0})]; await open(); select();
    vi.spyOn(screen.getByTestId("video-editor-text-frame"), "getBoundingClientRect").mockReturnValue(rect(960,540));
    drag(content().parentElement!,-100,-100);
    expect(screen.getByRole("button",{name:"↶ Rückgängig"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Vergrößern"}));
    expect(screen.getByTestId("video-editor-annotation-tracks")).toHaveStyle({width:"200%"});
    vi.spyOn(screen.getByTestId("video-editor-text-track-text-a"),"getBoundingClientRect").mockReturnValue(rect(2000,38));
    drag(screen.getByRole("button",{name:"Text 1"}),200);
    expect(screen.getByLabelText("Text Start")).toHaveValue(1);
    expect(screen.getByLabelText("Text Ende")).toHaveValue(6);
    undo();
    expect(screen.getByRole("button",{name:"Text 1"})).toHaveStyle({left:"0%",width:"50%"});
    expect(screen.getByRole("button",{name:"↶ Rückgängig"})).toBeDisabled();
  });
});
