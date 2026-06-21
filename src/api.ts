/**
 * Image generation API client.
 *
 * - API key mode  → POST https://api.openai.com/v1/images/generations (gpt-image-2)
 * - ChatGPT/Codex OAuth mode → POST https://chatgpt.com/backend-api/codex/responses
 *   using the Responses API with image_generation tool (SSE stream)
 */

import type { CodexAuth } from "./auth.js";
import { buildAuthHeaders } from "./auth.js";

const IMAGE_API_URL = "https://api.openai.com/v1/images/generations";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const USER_AGENT = "opencode-codex-image/0.1.0";

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageModeration = "auto" | "low";

export type GenerateImageParams = {
  prompt: string;
  size?: string;
  quality?: ImageQuality;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  moderation?: ImageModeration;
};

export type GenerateImageContext = {
  sessionId?: string;
  requestId?: string;
  threadId?: string;
};

export type GenerateImageResult = {
  type: "b64_json";
  data: string;
  mimeType: string;
  transport: "images-api" | "codex-responses";
  revisedPrompt?: string;
};

export class ImageApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ImageApiError";
  }
}

// ---------------------------------------------------------------------------
// API key path: POST /v1/images/generations
// ---------------------------------------------------------------------------

type ImagesApiResponseData = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
};

type ImagesApiResponse = {
  data?: ImagesApiResponseData[];
  error?: { message: string; type?: string; code?: string };
};

async function generateImageApiKey(
  auth: Extract<CodexAuth, { mode: "apikey" }>,
  params: GenerateImageParams,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.apiKey}`,
  };

  const body: Record<string, unknown> = {
    model: "gpt-image-2",
    prompt: params.prompt,
    n: 1,
  };

  if (params.size && params.size !== "auto") {
    body.size = params.size;
  }
  if (params.quality && params.quality !== "auto") {
    body.quality = params.quality;
  }
  if (params.outputFormat) {
    body.output_format = params.outputFormat;
  }
  if (
    params.outputCompression !== undefined &&
    (params.outputFormat === "jpeg" || params.outputFormat === "webp")
  ) {
    body.output_compression = params.outputCompression;
  }
  if (params.moderation && params.moderation !== "auto") {
    body.moderation = params.moderation;
  }

  let response: Response;
  try {
    response = await fetch(IMAGE_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ImageApiError(`Network error calling image API: ${(err as Error).message}`);
  }

  let json: ImagesApiResponse;
  try {
    json = (await response.json()) as ImagesApiResponse;
  } catch {
    throw new ImageApiError(
      `Image API returned non-JSON response (status ${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const errMsg = json.error?.message ?? `HTTP ${response.status}`;
    if (isMissingImageScopeError(errMsg)) {
      throw new ImageApiError(
        `Image generation is not permitted for the current credentials: ${errMsg}`,
        response.status,
        "The loaded credential reached OpenAI, but lacks the api.model.images.request scope. " +
          "Use an OPENAI_API_KEY with image generation permission, or switch to an organization/project role that can request image models.",
      );
    }
    if (response.status === 401) {
      throw new ImageApiError(
        `Authentication failed: ${errMsg}`,
        401,
        "Your token may have expired. Run `codex` to trigger a token refresh, or run `codex login` to re-authenticate.",
      );
    }
    throw new ImageApiError(`Image API error: ${errMsg}`, response.status);
  }

  const item = json.data?.[0];
  if (!item) {
    throw new ImageApiError("Image API returned empty data array");
  }

  if (!item.b64_json) {
    throw new ImageApiError("Image API response contained no b64_json data");
  }

  const mimeType = outputFormatToMime(params.outputFormat ?? "png");
  return {
    type: "b64_json",
    data: item.b64_json,
    mimeType,
    transport: "images-api",
    revisedPrompt: item.revised_prompt,
  };
}

// ---------------------------------------------------------------------------
// ChatGPT/Codex OAuth path: POST /backend-api/codex/responses (SSE)
// ---------------------------------------------------------------------------

// Shape of image_generation_call result in SSE events
type ImageGenResult =
  | string
  | { b64_json: string; mime_type?: string }
  | Array<{ b64_json: string; mime_type?: string }>;

type SseOutputItem = {
  type?: string;
  result?: ImageGenResult;
  revised_prompt?: string;
  content?: Array<{ type?: string; image_url?: { url?: string } }>;
};

type SseEvent = {
  type?: string;
  item?: SseOutputItem;
  response?: {
    output?: SseOutputItem[];
  };
};

function extractB64FromResult(
  result: ImageGenResult,
  fallbackMime: string,
): { data: string; mimeType: string } | null {
  if (typeof result === "string") {
    // Could be a plain base64 string or a data URL
    if (result.startsWith("data:")) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(result);
      if (match) {
        return { data: match[2], mimeType: match[1] };
      }
    }
    // Plain base64
    if (result.length > 0) {
      return { data: result, mimeType: fallbackMime };
    }
    return null;
  }

  if (Array.isArray(result)) {
    const first = result[0];
    if (first?.b64_json) {
      return { data: first.b64_json, mimeType: first.mime_type ?? fallbackMime };
    }
    return null;
  }

  if (result.b64_json) {
    return { data: result.b64_json, mimeType: result.mime_type ?? fallbackMime };
  }

  return null;
}

async function generateImageCodexResponses(
  auth: Extract<CodexAuth, { mode: "chatgpt" }>,
  params: GenerateImageParams,
  ctx: GenerateImageContext,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  const outerModel = process.env.OPENCODE_CODEX_IMAGE_OUTER_MODEL ?? "gpt-5.4";

  const authHeaders = buildAuthHeaders(auth);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: "opencode",
    ...authHeaders,
  };

  if (ctx.sessionId) {
    headers["session-id"] = ctx.sessionId;
    headers["x-client-request-id"] = ctx.requestId ?? ctx.sessionId;
  }
  if (ctx.threadId) {
    headers["thread-id"] = ctx.threadId;
  }

  // Build image_generation tool params (omit "auto" values)
  const toolParams: Record<string, unknown> = {
    model: "gpt-image-2",
  };
  if (params.size && params.size !== "auto") {
    toolParams.size = params.size;
  }
  if (params.quality && params.quality !== "auto") {
    toolParams.quality = params.quality;
  }
  if (params.outputFormat) {
    toolParams.output_format = params.outputFormat;
  }
  if (
    params.outputCompression !== undefined &&
    (params.outputFormat === "jpeg" || params.outputFormat === "webp")
  ) {
    toolParams.output_compression = params.outputCompression;
  }
  if (params.moderation && params.moderation !== "auto") {
    toolParams.moderation = params.moderation;
  }

  const body = {
    model: outerModel,
    instructions:
      "You are a precise image generation orchestrator. Use the image_generation tool to generate exactly one image from the user's prompt.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: params.prompt }],
      },
    ],
    tools: [{ type: "image_generation", ...toolParams }],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ImageApiError(`Network error calling Codex responses API: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const errMsg = await readErrorMessage(response);

    if (response.status === 401 || response.status === 403) {
      throw new ImageApiError(
        `Codex responses API authentication failed (${response.status}): ${errMsg}`,
        response.status,
        "Your Codex/ChatGPT OAuth token may be expired or lack required permissions. " +
          "Run `codex login` or `opencode auth login` to re-authenticate.",
      );
    }
    throw new ImageApiError(`Codex responses API error: ${errMsg}`, response.status);
  }

  // Parse SSE stream
  const fallbackMime = outputFormatToMime(params.outputFormat ?? "png");
  const result = await parseSseStream(response, fallbackMime, signal);
  if (!result) {
    throw new ImageApiError("Codex responses API stream completed without returning image data");
  }
  return { ...result, transport: "codex-responses" };
}

type ParsedImageResult = {
  type: "b64_json";
  data: string;
  mimeType: string;
  revisedPrompt?: string;
};

async function parseSseStream(
  response: Response,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<ParsedImageResult | null> {
  if (!response.body) {
    throw new ImageApiError("Codex responses API returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let next = takeNextSseEvent(buffer);
      while (next) {
        buffer = next.rest;
        const parsed = parseSseEventData(next.rawEvent);
        if (parsed && parsed !== "[DONE]") {
          const image = extractImageFromSseEvent(parsed, fallbackMime);
          if (image) return image;
        }
        next = takeNextSseEvent(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return null;
}

function takeNextSseEvent(buffer: string): { rawEvent: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const candidates = [lfIndex, crlfIndex].filter((index) => index >= 0);
  if (candidates.length === 0) return null;

  const boundary = Math.min(...candidates);
  const separatorLength = boundary === crlfIndex ? 4 : 2;
  return {
    rawEvent: buffer.slice(0, boundary),
    rest: buffer.slice(boundary + separatorLength),
  };
}

function parseSseEventData(rawEvent: string): SseEvent | "[DONE]" | null {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();

  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return null;
  }
}

function extractImageFromSseEvent(event: SseEvent, fallbackMime: string): ParsedImageResult | null {
  // Primary: response.output_item.done with image_generation_call
  if (event.type === "response.output_item.done" && event.item) {
    const extracted = extractImageFromOutputItem(event.item, fallbackMime);
    if (extracted) return extracted;
  }

  // Some implementations emit a direct image-generation event.
  if (event.type === "response.image_generation_call.done" && event.item) {
    const extracted = extractImageFromOutputItem(event.item, fallbackMime);
    if (extracted) return extracted;
  }

  // Fallback: response.completed with full output array
  if (event.type === "response.completed" && event.response?.output) {
    for (const item of event.response.output) {
      const extracted = extractImageFromOutputItem(item, fallbackMime);
      if (extracted) return extracted;
    }
  }

  return null;
}

function extractImageFromOutputItem(
  item: SseOutputItem,
  fallbackMime: string,
): ParsedImageResult | null {
  if (item.type !== "image_generation_call" || item.result === undefined) return null;
  const extracted = extractB64FromResult(item.result, fallbackMime);
  if (!extracted) return null;
  return {
    type: "b64_json",
    ...extracted,
    revisedPrompt: item.revised_prompt,
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text().catch(() => "");
  if (!text) return fallback;

  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message ?? text;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateImage(
  auth: CodexAuth,
  params: GenerateImageParams,
  ctx?: GenerateImageContext,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  if (auth.mode === "apikey") {
    return generateImageApiKey(auth, params, signal);
  }
  return generateImageCodexResponses(auth, params, ctx ?? {}, signal);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMissingImageScopeError(message: string): boolean {
  return message.includes("api.model.images.request") || message.includes("Missing scopes");
}

function outputFormatToMime(format: ImageOutputFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}
