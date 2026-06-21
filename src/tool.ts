/**
 * imagegen tool definition for OpenCode.
 * Generates images via gpt-image-2 using Codex CLI credentials.
 *
 * - API key mode  → OpenAI Images API (api.openai.com/v1/images/generations)
 * - OAuth mode    → Codex Responses API (chatgpt.com/backend-api/codex/responses)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { ImageApiError, generateImage } from "./api.js";
import { AuthError, loadCodexAuth } from "./auth.js";
import { validateSize } from "./size.js";

const SIZE_DESCRIPTION =
  'Image size. Use "auto" or "WIDTHxHEIGHT" (e.g. "1024x1024"). ' +
  "Constraints: both dimensions divisible by 16, each <= 3840, area <= 3840×2160, ratio 1:3 to 3:1.";

export const imagegenTool = tool({
  description:
    "Generate an image using OpenAI gpt-image-2 via Codex CLI credentials. " +
    "Saves the image to disk and returns the file path.",
  args: {
    prompt: z.string().min(1).describe("Text description of the image to generate"),
    outputPath: z
      .string()
      .optional()
      .describe(
        "Output file path. Relative paths are resolved from the project directory. " +
          "Defaults to .opencode/imagegen/<timestamp>.<ext>",
      ),
    size: z.string().optional().default("auto").describe(SIZE_DESCRIPTION),
    quality: z
      .enum(["auto", "low", "medium", "high"])
      .optional()
      .default("auto")
      .describe("Image quality"),
    outputFormat: z
      .enum(["png", "jpeg", "webp"])
      .optional()
      .default("png")
      .describe("Output image format"),
    outputCompression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Compression level 0-100 (only for jpeg/webp)"),
    moderation: z
      .enum(["auto", "low"])
      .optional()
      .default("auto")
      .describe("Content moderation level"),
  },
  async execute(args, context) {
    // Validate size early before making any network calls
    const sizeResult = validateSize(args.size ?? "auto");
    if (!sizeResult.valid) {
      return {
        title: "imagegen: invalid size",
        output: `Error: ${sizeResult.error}`,
      };
    }

    // Resolve output path
    const ext = args.outputFormat ?? "png";
    const defaultRelPath = join(".opencode", "imagegen", `${Date.now()}.${ext}`);
    const rawPath = args.outputPath ?? defaultRelPath;
    const outputPath = isAbsolute(rawPath) ? rawPath : join(context.directory, rawPath);

    // Load credentials
    let auth: Awaited<ReturnType<typeof loadCodexAuth>>;
    try {
      auth = await loadCodexAuth();
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          title: "imagegen: authentication error",
          output: `Error: ${err.message}\n\nHint: ${err.hint}`,
        };
      }
      throw err;
    }

    // Call image API
    let result: Awaited<ReturnType<typeof generateImage>>;
    try {
      result = await generateImage(
        auth,
        {
          prompt: args.prompt,
          size: sizeResult.apiValue,
          quality: args.quality ?? "auto",
          outputFormat: args.outputFormat ?? "png",
          outputCompression: args.outputCompression,
          moderation: args.moderation ?? "auto",
        },
        {
          // Pass session context for Codex Responses API headers
          sessionId: (context as Record<string, unknown>).sessionID as string | undefined,
        },
        context.abort,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw err;
      }
      if (err instanceof ImageApiError) {
        const hint = err.hint ? `\n\nHint: ${err.hint}` : "";
        return {
          title: "imagegen: API error",
          output: `Error: ${err.message}${hint}`,
          metadata: { statusCode: err.statusCode },
        };
      }
      throw err;
    }

    // Write image to disk
    const imageBuffer = Buffer.from(result.data, "base64");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, imageBuffer);

    const fileUrl = pathToFileURL(outputPath).href;
    const filename = basename(outputPath) || `image.${ext}`;

    return {
      title: `imagegen: saved ${filename}`,
      output: `Image generated successfully.\nSaved to: ${outputPath}`,
      metadata: {
        outputPath,
        size: sizeResult.apiValue,
        quality: args.quality ?? "auto",
        outputFormat: ext,
        prompt: args.prompt,
        transport: result.transport,
        source: auth.mode === "apikey" ? "images-api" : "codex-responses",
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      },
      attachments: [
        {
          type: "file" as const,
          mime: result.mimeType,
          url: fileUrl,
          filename,
        },
      ],
    };
  },
});
