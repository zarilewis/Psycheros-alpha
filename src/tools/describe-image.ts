/**
 * Image Captioning Tool
 *
 * I use this to get detailed descriptions of images. I can describe images
 * by local file path or by URL. The captioning uses a configurable vision model
 * (Gemini or OpenRouter) separate from image generation providers.
 */

import { join } from "@std/path";
import { uint8ToBase64, getMediaType } from "./generate-image.ts";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { CaptioningSettings } from "../llm/image-gen-settings.ts";

// =============================================================================
// Shared Captioning Functions
// =============================================================================

const CAPTION_PROMPT =
  "Describe this image in detail. Include information about the subjects, " +
  "setting, colors, composition, style, mood, and any other notable details. " +
  "Be thorough and specific.";

/**
 * Caption an image using base64 data via the configured provider.
 */
export function captionImage(
  imageData: string,
  mediaType: string,
  settings: CaptioningSettings,
): Promise<string> {
  switch (settings.provider) {
    case "gemini":
      return captionViaGemini(imageData, mediaType, settings);
    case "openrouter":
      return captionViaOpenRouter(imageData, mediaType, settings);
    default:
      throw new Error(`Unknown captioning provider: ${settings.provider}`);
  }
}

/**
 * Fetch an image from a URL and caption it.
 */
export async function fetchAndCaptionUrl(
  url: string,
  settings: CaptioningSettings,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = uint8ToBase64(new Uint8Array(buffer));
  const mediaType = response.headers.get("content-type") || "image/png";
  return captionImage(base64, mediaType, settings);
}

// =============================================================================
// Gemini Provider
// =============================================================================

async function captionViaGemini(
  imageData: string,
  mediaType: string,
  settings: CaptioningSettings,
): Promise<string> {
  const geminiSettings = settings.gemini;
  if (!geminiSettings) throw new Error("Gemini captioning settings not configured");

  const model = geminiSettings.model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mediaType, data: imageData } },
        { text: CAPTION_PROMPT },
      ],
    }],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiSettings.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini captioning API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<Record<string, unknown>>;
      };
    }>;
  };

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error("Gemini captioning returned no candidates");
  }

  for (const candidate of data.candidates) {
    if (!candidate.content?.parts) continue;
    for (const part of candidate.content.parts) {
      if (part.text && typeof part.text === "string") {
        return part.text;
      }
    }
  }

  throw new Error("Gemini captioning returned no text content");
}

// =============================================================================
// OpenRouter Provider
// =============================================================================

async function captionViaOpenRouter(
  imageData: string,
  mediaType: string,
  settings: CaptioningSettings,
): Promise<string> {
  const orSettings = settings.openrouter;
  if (!orSettings) throw new Error("OpenRouter captioning settings not configured");

  const baseUrl = orSettings.baseUrl || "https://openrouter.ai/api";
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: orSettings.model,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageData}` } },
        { type: "text", text: CAPTION_PROMPT },
      ],
    }],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${orSettings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter captioning API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter captioning returned no content");
  }

  return content;
}

// =============================================================================
// Tool Definition
// =============================================================================

export const describeImageTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "describe_image",
      description:
        "I use this to get a detailed description of an image. " +
        "I can describe images by local path or by URL. " +
        "This is useful for understanding images the user shares, " +
        "examining images I find via web search, or reviewing images I generated.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to a local image file relative to .psycheros/ (e.g. /generated-images/abc.png, /anchors/def.jpg, /chat-attachments/ghi.png)",
          },
          url: {
            type: "string",
            description: "URL of an image to describe",
          },
        },
      },
    },
  },
  execute: executeDescribeImage,
};

async function executeDescribeImage(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { path, url } = args as { path?: string; url?: string };

  if (!path && !url) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: I must provide either 'path' or 'url' to describe an image.",
      isError: true,
    };
  }

  const captioningSettings = ctx.config.imageGenSettings?.captioning;
  if (!captioningSettings?.provider) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: Image captioning is not configured. Configure a captioning provider in Settings > Vision > Generators.",
      isError: true,
    };
  }

  try {
    let description: string;

    if (url) {
      description = await fetchAndCaptionUrl(url, captioningSettings);
    } else if (path) {
      // path is relative to .psycheros/
      // If the path has no extension, look up the actual file in the directory
      let resolvedPath = join(ctx.config.projectRoot, ".psycheros", path);
      try {
        await Deno.stat(resolvedPath);
      } catch {
        // No extension — try to find the actual file by prefix
        const dir = join(ctx.config.projectRoot, ".psycheros", path).replace(/[^/]+$/, "");
        const prefix = path.split("/").pop()!;
        try {
          for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith(prefix)) {
              resolvedPath = join(dir, entry.name);
              break;
            }
          }
        } catch { /* dir doesn't exist */ }
      }
      const fileData = await Deno.readFile(resolvedPath);
      const base64 = uint8ToBase64(fileData);
      const mediaType = getMediaType(resolvedPath);
      description = await captionImage(base64, mediaType, captioningSettings);
    } else {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: I must provide either 'path' or 'url'.",
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `Image description: ${description}`,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Error describing image: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
