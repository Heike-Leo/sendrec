import { describe, expect, it } from "vitest";
import { requirePreviewAnnotations, validateTextAnnotation, type TextAnnotation } from "./editorAnnotations";
import { serializeTimeline } from "./VideoEditorModal";

const text: TextAnnotation = { id: "text-1", type: "text", text: "äöüÄÖÜß <b>Hinweis</b>", x: 10, y: 20, width: 40, height: 10, start: 1, end: 4, fontSize: 32, color: "#Ab12Cd" };
describe("text annotation contract", () => {
  it("preserves every field through the actual payload serializer and primitive snapshot", () => {
    validateTextAnnotation(text);
    const payload = JSON.parse(serializeTimeline([], [], [{ ...text }]));
    expect(payload.annotations).toEqual([text]);
    validateTextAnnotation(payload.annotations[0]);
    expect(text.text).toContain("<b>"); // Literal data, never markup.
  });
  it.each([
    { text: "" }, { text: "   " }, { text: "\u200b" }, { text: "x".repeat(121) },
    { text: 42 }, { text: "a\u0001" }, { text: "\ud800" },
    { text: "\n" }, { text: " \t\n \n" }, { text: "\t" },
    { fontSize: 0 }, { fontSize: 257 }, { fontSize: NaN }, { fontSize: Infinity },
    { x: -1 }, { x: 90 }, { height: 0 }, { width: Infinity },
    { color: "red" }, { color: "#fff" }, { end: 1 }, { start: NaN },
  ])("rejects invalid stored values: %j", patch => {
    expect(() => validateTextAnnotation({ ...text, ...patch })).toThrow();
  });
  it("accepts optional/default color and font boundaries", () => {
    for (const color of [undefined, "", "#FFFFFF"]) for (const fontSize of [8, 256]) validateTextAnnotation({ ...text, color, fontSize });
  });
  it("preserves manual newlines and counts them toward the codepoint limit", () => {
    const multiline = { ...text, text: "Grüße aus Oldenburg\näöü ÄÖÜ ß\nZeile 3" };
    validateTextAnnotation(multiline);
    expect(JSON.parse(serializeTimeline([], [], [multiline])).annotations[0]).toEqual(multiline);
    validateTextAnnotation({ ...text, text: "ä".repeat(119) + "\n" });
    expect(() => validateTextAnnotation({ ...text, text: "ä".repeat(119) + "\nß" })).toThrow();
  });
  it("loads validated text as text and rejects unknown types", () => {
    expect(requirePreviewAnnotations([text])).toEqual([text]);
    expect(() => requirePreviewAnnotations([{ ...text, text: "" }])).toThrow();
    expect(() => requirePreviewAnnotations([{ ...text, type: "unknown" }])).toThrow("Unknown annotation type");
  });
  it("leaves legacy graphic annotations unchanged", () => {
    const shapes = ["arrow", "circle", "symbol", "line"].map(type => ({ ...text, type, rotation: 0 }));
    expect(requirePreviewAnnotations(shapes)).toBe(shapes);
    expect(requirePreviewAnnotations([])).toEqual([]);
  });
});
