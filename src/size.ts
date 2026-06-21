/**
 * Size validation for gpt-image-2 image generation.
 *
 * Rules:
 * - "auto" is always valid
 * - WIDTHxHEIGHT format
 * - Both dimensions must be positive integers divisible by 16
 * - Aspect ratio between 1:3 and 3:1
 * - Each side <= 3840
 * - Area <= 3840 * 2160
 */

export type SizeValidationResult =
  | { valid: true; apiValue: string }
  | { valid: false; error: string };

const MAX_SIDE = 3840;
const MAX_AREA = 3840 * 2160;
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 3 / 1;

export function validateSize(size: string): SizeValidationResult {
  if (size === "auto") {
    return { valid: true, apiValue: "auto" };
  }

  const match = /^(\d+)x(\d+)$/i.exec(size);
  if (!match) {
    return {
      valid: false,
      error: `Invalid size format "${size}". Use "auto" or "WIDTHxHEIGHT" (e.g. "1024x1024").`,
    };
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);

  if (width <= 0 || height <= 0) {
    return { valid: false, error: "Width and height must be positive integers." };
  }

  if (width % 16 !== 0 || height % 16 !== 0) {
    return {
      valid: false,
      error: `Width (${width}) and height (${height}) must both be divisible by 16.`,
    };
  }

  if (width > MAX_SIDE || height > MAX_SIDE) {
    return {
      valid: false,
      error: `Width and height must each be <= ${MAX_SIDE}. Got ${width}x${height}.`,
    };
  }

  const area = width * height;
  if (area > MAX_AREA) {
    return {
      valid: false,
      error: `Image area (${width}x${height}=${area}px²) exceeds maximum ${MAX_AREA}px² (${MAX_SIDE}x2160).`,
    };
  }

  const ratio = width / height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    return {
      valid: false,
      error: `Aspect ratio ${width}:${height} is out of range. Must be between 1:3 and 3:1.`,
    };
  }

  return { valid: true, apiValue: `${width}x${height}` };
}
