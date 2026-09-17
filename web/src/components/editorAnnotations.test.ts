import { describe, expect, it } from "vitest";
import { arrowShaftWidth, arrowPolygonPoints, requirePreviewAnnotations, validateTextAnnotation, type TextAnnotation } from "./editorAnnotations";
import { serializeTimeline } from "./VideoEditorModal";

const text: TextAnnotation = { id: "text-1", type: "text", text: "äöüÄÖÜß <b>Hinweis</b>", x: 10, y: 20, width: 40, height: 10, start: 1, end: 4, fontSize: 32, color: "#Ab12Cd" };
describe("arrow shaft width", () => {
  it("preserves the exact legacy polygon", () => {
    expect(arrowShaftWidth()).toBe(12);
    expect(arrowPolygonPoints()).toBe("8,44 65,44 65,28 94,50 65,72 65,56 8,56");
  });
  it.each([6, 9, 12, 18, 24])("scales shaft and both head dimensions at %s", width => {
    const shoulder = 94 - 29 * width / 12, headHalf = 22 * width / 12;
    expect(arrowPolygonPoints(width)).toBe(`8,${50-width/2} ${shoulder},${50-width/2} ${shoulder},${50-headHalf} 94,50 ${shoulder},${50+headHalf} ${shoulder},${50+width/2} 8,${50+width/2}`);
    for (const point of arrowPolygonPoints(width).split(" ")) {
      const [x, y] = point.split(",").map(Number);
      expect(Math.hypot(x - 50, y - 50)).toBeLessThan(50);
    }
    const a = { ...text, type: "arrow" as const, rotation: 37, shaftWidth: width };
    expect(requirePreviewAnnotations(JSON.parse(serializeTimeline([], [], [a])).annotations)[0]).toEqual(a);
  });
  it.each([0, 5, 25, NaN, Infinity])("rejects invalid width %s", width => {
    expect(() => arrowShaftWidth(width)).toThrow();
    expect(() => requirePreviewAnnotations([{ type: "arrow", shaftWidth: width }])).toThrow();
  });
});
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
