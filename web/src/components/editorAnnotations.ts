import { TEXT_LAYOUT, scaledTextFontSize, validateTextBox, type TextBox } from "./editorTextGeometry";
import { textTypography, type TextTypography } from "./editorTextTypography";

interface AnnotationBase extends TextBox { id: string; start: number; end: number; color?: string }
export type AnnotationSymbol = "check" | "cross" | "warning" | "info" | "star" | "pointer" | "plus" | "question";
export interface GraphicAnnotation extends AnnotationBase {
  type: "arrow" | "circle" | "symbol" | "line";
  symbol?: AnnotationSymbol;
  rotation: number;
  shaftWidth?: number;
  strokeWidth?: number;
}
// Line thickness in canonical 1920x1080 output pixels (not SVG viewBox units).
export const LINE_STROKE_WIDTHS = [1, 2, 3, 6, 9] as const;
export function lineStrokeWidth(value?: number): number {
  if (value === undefined) return 3;
  if (!(LINE_STROKE_WIDTHS as readonly number[]).includes(value)) throw new Error("Invalid line stroke width");
  return value;
}
export function linePreviewStrokeWidth(value: number | undefined, frameWidth: number): number {
  return lineStrokeWidth(value) * frameWidth / 1920;
}
// Circle contours use the same canonical-pixel units, independently of lines.
export const CIRCLE_STROKE_WIDTHS = [1, 2, 3, 6, 9] as const;
export function circleStrokeWidth(value?: number): number {
  if (value === undefined) return 3;
  if (!(CIRCLE_STROKE_WIDTHS as readonly number[]).includes(value)) throw new Error("Invalid circle stroke width");
  return value;
}
export function circlePreviewStrokeWidth(value: number | undefined, frameWidth: number): number {
  return circleStrokeWidth(value) * frameWidth / 1920;
}
// Width in the arrow's existing 100x100 viewBox, not screen pixels.
export const ARROW_SHAFT_WIDTHS = [6, 9, 12, 18, 24] as const;
export function arrowShaftWidth(value?: number): number {
  if (value === undefined) return 12;
  if (!Number.isFinite(value) || value < 6 || value > 24) throw new Error("Invalid arrow shaft width");
  return value;
}
export function arrowPolygonPoints(value?: number): string {
  const half = arrowShaftWidth(value) / 2;
  // Scale both head dimensions around the fixed tip; 12 reproduces the
  // original polygon exactly. All vertices remain within the rotation circle.
  const scale = half / 6;
  const shoulder = 94 - 29 * scale;
  const headHalf = 22 * scale;
  return `8,${50-half} ${shoulder},${50-half} ${shoulder},${50-headHalf} 94,50 ${shoulder},${50+headHalf} ${shoulder},${50+half} 8,${50+half}`;
}
export interface TextAnnotation extends AnnotationBase, TextTypography {
  type: "text";
  text: string;
  fontSize: number;
}
export type EditorAnnotation = GraphicAnnotation | TextAnnotation;

export function validateTextAnnotation(input: unknown): asserts input is TextAnnotation {
  if (!input || typeof input !== "object") throw new Error("Invalid text annotation");
  const a = input as TextAnnotation;
  textTypography(a);
  if (a.type !== "text" || typeof a.id !== "string" || !a.id.trim()) throw new Error("Invalid text annotation");
  if (typeof a.text !== "string" || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(a.text) ||
    /[\p{Cc}\p{Cs}]/u.test(a.text.replace(/\n/g, "")) || [...a.text].length > TEXT_LAYOUT.maxLength) throw new Error("Invalid annotation text");
  validateTextBox(a);
  scaledTextFontSize(a.fontSize, 1080);
  if (![a.start, a.end].every(Number.isFinite) || a.start < 0 || a.end <= a.start) throw new Error("Invalid text time range");
  if (a.color !== undefined && a.color !== "" && (typeof a.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(a.color))) throw new Error("Invalid text color");
}

export function requirePreviewAnnotations(input: unknown): EditorAnnotation[] {
  if (!Array.isArray(input)) throw new Error("Invalid annotations");
  for (const annotation of input) {
    if (!annotation || !["arrow", "circle", "symbol", "line", "text"].includes(annotation.type)) {
      throw new Error("Unknown annotation type");
    }
    if (annotation.type === "text") {
      validateTextAnnotation(annotation);
    }
    if (annotation.type === "arrow") arrowShaftWidth(annotation.shaftWidth);
    if (annotation.type === "line") lineStrokeWidth(annotation.strokeWidth);
    if (annotation.type === "circle") circleStrokeWidth(annotation.strokeWidth);
  }
  return input as EditorAnnotation[];
}
