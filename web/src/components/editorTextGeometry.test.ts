import { describe, expect, it } from "vitest";
import { clampTextBox, scaledTextFontSize, textBoxToPixels, textPixelsToBox, textPreviewGeometry, validateTextBox } from "./editorTextGeometry";

describe("canonical text geometry", () => {
  const box = { x: 10, y: 20, width: 40, height: 10 };
  it("maps render and half-sized preview pixels without source stretching", () => {
    const full = textPreviewGeometry(1920, 1080, 1920, 1080);
    expect(textBoxToPixels(box, full.frame)).toEqual({ left: 192, top: 216, width: 768, height: 108 });
    const half = textPreviewGeometry(960, 540, 1920, 1080);
    expect(textBoxToPixels(box, half.frame)).toEqual({ left: 96, top: 108, width: 384, height: 54 });
    expect(half.scale).toBe(0.5);
  });
  it("distinguishes portrait source pillarboxes from outer preview margins", () => {
    const result = textPreviewGeometry(960, 960, 1080, 1920);
    expect(result.frame).toEqual({ left: 0, top: 210, width: 960, height: 540 });
    expect(result.content.width).toBe(303.75);
    expect(result.padding).toEqual({ left: 328.125, right: 328.125, top: 0, bottom: 0 });
  });
  it("calculates letterboxing", () => {
    expect(textPreviewGeometry(1920, 1080, 1920, 800).padding).toEqual({ left: 0, right: 0, top: 140, bottom: 140 });
  });
  it("roundtrips fractional coordinates without rounding", () => {
    const input = { x: 12.345, y: 23.456, width: 33.333, height: 17.123 };
    const frame = textPreviewGeometry(837, 611, 640, 480).frame;
    const result = textPixelsToBox(textBoxToPixels(input, frame), frame);
    for (const key of ["x", "y", "width", "height"] as const) expect(result[key]).toBeCloseTo(input[key], 12);
  });
  it("scales font by canonical height", () => {
    expect(scaledTextFontSize(32, 1080)).toBe(32);
    expect(scaledTextFontSize(32, 540)).toBe(16);
  });
  it("separates validation from explicit interactive clamping", () => {
    const input = { x: 95, y: -5, width: 20, height: 0 };
    expect(() => validateTextBox(input)).toThrow();
    expect(clampTextBox(input)).toEqual({ x: 80, y: 0, width: 20, height: 1 });
    expect(input.y).toBe(-5);
    expect(() => textPreviewGeometry(0, 100, 100, 100)).toThrow();
    expect(() => scaledTextFontSize(Infinity, 540)).toThrow();
  });
});
