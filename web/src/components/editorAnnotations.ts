import { TEXT_LAYOUT, scaledTextFontSize, validateTextBox, type TextBox } from "./editorTextGeometry";
import { textTypography, type TextTypography } from "./editorTextTypography";

interface AnnotationBase extends TextBox { id: string; start: number; end: number; color?: string }
export type AnnotationSymbol = "check" | "cross" | "warning" | "info" | "star" | "pointer" | "plus" | "question";
export interface GraphicAnnotation extends AnnotationBase {
  type: "arrow" | "circle" | "symbol" | "line";
  symbol?: AnnotationSymbol;
  rotation: number;
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
  }
  return input as EditorAnnotation[];
}
