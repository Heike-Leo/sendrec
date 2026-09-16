// New text coordinates refer to the complete output canvas, including source
// padding. Existing annotation geometry is deliberately not changed here.
export const TEXT_REFERENCE_FRAME = { width: 1920, height: 1080 } as const;
export const TEXT_LAYOUT = {
  fontSize: 32, minFontSize: 8, maxFontSize: 256, maxLength: 120,
  width: 40, height: 10, minWidth: 1, minHeight: 1, color: "#FFFFFF",
} as const;
export interface TextBox { x: number; y: number; width: number; height: number }
export interface FrameRect { left: number; top: number; width: number; height: number }

function positive(...values: number[]) {
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError("Invalid frame dimensions");
}

export function validateTextBox(box: TextBox): void {
  if ([box.x, box.y, box.width, box.height].some(value => !Number.isFinite(value)) ||
    box.x < 0 || box.y < 0 || box.width < TEXT_LAYOUT.minWidth || box.height < TEXT_LAYOUT.minHeight ||
    box.x + box.width > 100 || box.y + box.height > 100) throw new RangeError("Invalid text box");
}

// Explicit UI utility, never used to validate or load stored data.
export function clampTextBox(box: TextBox): TextBox {
  if (Object.values(box).some(value => !Number.isFinite(value))) throw new RangeError("Invalid text box");
  const width = Math.max(TEXT_LAYOUT.minWidth, Math.min(100, box.width));
  const height = Math.max(TEXT_LAYOUT.minHeight, Math.min(100, box.height));
  return { x: Math.max(0, Math.min(100 - width, box.x)), y: Math.max(0, Math.min(100 - height, box.y)), width, height };
}

// Continuous contain geometry: no premature rounding. FFmpeg's existing
// force_divisible_by=2 quantizes the source raster separately (not this canvas).
function contain(width: number, height: number, frame: FrameRect): FrameRect {
  positive(width, height, frame.width, frame.height);
  const scale = Math.min(frame.width / width, frame.height / height);
  return { left: frame.left + (frame.width - width * scale) / 2,
    top: frame.top + (frame.height - height * scale) / 2, width: width * scale, height: height * scale };
}

export function textPreviewGeometry(containerWidth: number, containerHeight: number, sourceWidth: number, sourceHeight: number) {
  const frame = contain(1920, 1080, { left: 0, top: 0, width: containerWidth, height: containerHeight });
  const content = contain(sourceWidth, sourceHeight, frame);
  return { frame, content, scale: frame.height / 1080,
    padding: { left: content.left - frame.left, top: content.top - frame.top,
      right: frame.left + frame.width - content.left - content.width,
      bottom: frame.top + frame.height - content.top - content.height } };
}

export function textBoxToPixels(box: TextBox, frame: FrameRect): FrameRect {
  validateTextBox(box);
  positive(frame.width, frame.height);
  if (![frame.left, frame.top].every(Number.isFinite)) throw new RangeError("Invalid frame origin");
  return { left: frame.left + box.x * frame.width / 100, top: frame.top + box.y * frame.height / 100,
    width: box.width * frame.width / 100, height: box.height * frame.height / 100 };
}

export function textPixelsToBox(pixels: FrameRect, frame: FrameRect): TextBox {
  positive(frame.width, frame.height);
  const box = { x: (pixels.left - frame.left) / frame.width * 100, y: (pixels.top - frame.top) / frame.height * 100,
    width: pixels.width / frame.width * 100, height: pixels.height / frame.height * 100 };
  validateTextBox(box);
  return box;
}

export function scaledTextFontSize(fontSize: number, frameHeight: number): number {
  positive(frameHeight);
  if (!Number.isFinite(fontSize) || fontSize < TEXT_LAYOUT.minFontSize || fontSize > TEXT_LAYOUT.maxFontSize) {
    throw new RangeError("Invalid text font size");
  }
  return fontSize * frameHeight / TEXT_REFERENCE_FRAME.height;
}
