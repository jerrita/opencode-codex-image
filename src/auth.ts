/**
 * Codex CLI auth.json credential loader.
 *
 * Reads from ${CODEX_HOME:-$HOME/.codex}/auth.json (or USERPROFILE on Windows).
 * Supports both API key mode and ChatGPT token mode.
 *
 * Fallback: also reads opencode's own ~/.local/share/opencode/auth.json
 * for openai oauth/api credentials when Codex auth is not available.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type CodexTokens = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

export type CodexAuth =
  | { mode: "apikey"; apiKey: string }
  | { mode: "chatgpt"; accessToken: string; accountId?: string; fedramp?: boolean };

type RawAuthJson = {
  auth_mode?: string | null;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens | null;
  last_refresh?: string | null;
};

const codexTokensSchema = z
  .object({
    id_token: z.string().nullable().optional(),
    access_token: z.string().nullable().optional(),
    refresh_token: z.string().nullable().optional(),
    account_id: z.string().nullable().optional(),
  })
  .passthrough();

const codexAuthJsonSchema = z
  .object({
    auth_mode: z.string().nullable().optional(),
    OPENAI_API_KEY: z.string().nullable().optional(),
    tokens: codexTokensSchema.nullable().optional(),
    last_refresh: z.string().nullable().optional(),
  })
  .passthrough();

// opencode's own auth.json schema
// format: { openai: { type: "oauth", access, refresh, expires, accountId } }
//      or { openai: { type: "api", key } }
const opencodeOauthSchema = z.object({
  access: z.string(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
  accountId: z.string().optional(),
});

const opencodeApiKeySchema = z.object({
  key: z.string(),
});

const opencodeAuthJsonSchema = z
  .object({
    openai: z
      .union([
        z.object({ type: z.literal("oauth") }).merge(opencodeOauthSchema),
        z.object({ type: z.literal("api") }).merge(opencodeApiKeySchema),
      ])
      .optional(),
  })
  .passthrough();

function getCodexAuthFilePath(): string {
  const codexHome =
    process.env.CODEX_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".codex");
  return join(codexHome, "auth.json");
}

function getOpencodeAuthFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const payload = parts[1];
    // base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

async function tryLoadOpencodeAuth(): Promise<CodexAuth | null> {
  const authPath = getOpencodeAuthFilePath();
  try {
    const content = await readFile(authPath, "utf-8");
    const parsed = opencodeAuthJsonSchema.safeParse(JSON.parse(content));
    if (!parsed.success || !parsed.data.openai) return null;

    const openai = parsed.data.openai;
    if (openai.type === "api" && openai.key) {
      return { mode: "apikey", apiKey: openai.key };
    }
    if (openai.type === "oauth" && openai.access) {
      return {
        mode: "chatgpt",
        accessToken: openai.access,
        accountId: openai.accountId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadCodexAuth(): Promise<CodexAuth> {
  // Env var takes priority (API key mode)
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return { mode: "apikey", apiKey: envKey };
  }

  const authPath = getCodexAuthFilePath();
  let raw: RawAuthJson | null = null;
  try {
    const content = await readFile(authPath, "utf-8");
    raw = codexAuthJsonSchema.parse(JSON.parse(content)) as RawAuthJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AuthError(
        `Failed to read Codex auth file: ${(err as Error).message}`,
        "Ensure the auth file is valid JSON. Run `codex login` to re-authenticate.",
      );
    }
    // ENOENT: fall through to opencode auth fallback
  }

  if (raw !== null) {
    // API key stored in auth.json
    if (raw.OPENAI_API_KEY) {
      return { mode: "apikey", apiKey: raw.OPENAI_API_KEY };
    }

    // ChatGPT token mode
    const tokens = raw.tokens;
    if (tokens?.access_token) {
      // Determine account_id: prefer explicit field, then id_token claim
      let accountId: string | undefined = tokens.account_id ?? undefined;
      let fedramp = false;

      if (tokens.id_token) {
        const claims = decodeJwtPayload(tokens.id_token);
        if (!accountId && typeof claims.chatgpt_account_id === "string") {
          accountId = claims.chatgpt_account_id;
        }
        if (claims.chatgpt_account_is_fedramp === true) {
          fedramp = true;
        }
      }

      return {
        mode: "chatgpt",
        accessToken: tokens.access_token,
        accountId,
        fedramp,
      };
    }
  }

  // Fallback: try opencode's own auth.json
  const opencodeAuth = await tryLoadOpencodeAuth();
  if (opencodeAuth) {
    return opencodeAuth;
  }

  const codexAuthPath = getCodexAuthFilePath();
  throw new AuthError(
    `No credentials found. Checked Codex auth (${codexAuthPath}) and opencode auth.`,
    "Run `codex login` to authenticate with Codex, or set OPENAI_API_KEY environment variable.",
  );
}

export function buildAuthHeaders(auth: CodexAuth): Record<string, string> {
  const headers: Record<string, string> = {};

  if (auth.mode === "apikey") {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  } else {
    headers.Authorization = `Bearer ${auth.accessToken}`;
    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }
    if (auth.fedramp) {
      headers["X-OpenAI-Fedramp"] = "true";
    }
  }

  return headers;
}
