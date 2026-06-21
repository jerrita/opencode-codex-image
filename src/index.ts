/**
 * OpenCode plugin: generate images via gpt-image-2 using Codex CLI credentials.
 *
 * @example
 * // opencode.json
 * {
 *   "plugin": ["opencode-codex-image"]
 * }
 */

import type { Plugin } from "@opencode-ai/plugin";
import { imagegenTool } from "./tool.js";

export default (async (_input, _options) => {
  return {
    tool: {
      imagegen: imagegenTool,
    },
  };
}) satisfies Plugin;
