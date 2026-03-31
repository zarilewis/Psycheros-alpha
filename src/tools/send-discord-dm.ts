/**
 * Send Discord DM Tool
 *
 * Allows the entity to send a Discord DM to the user when they need attention.
 * Uses a Discord bot token to send messages via the Discord REST API.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";

/**
 * The send_discord_dm tool lets the entity send a Discord DM to the user.
 */
export const sendDiscordDmTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "send_discord_dm",
      description:
        "Send a Discord DM to the user. I use this to get the user's attention when I have something important to share and they may not be looking at the chat interface.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "The message to send via Discord DM. Keep it concise and relevant.",
          },
          channel_id: {
            type: "string",
            description:
              "Optional Discord channel/user ID to send to. If omitted, uses the configured default channel.",
          },
        },
        required: ["message"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const message = args.message;
    const overrideChannelId = args.channel_id;

    // Validate message
    if (typeof message !== "string" || message.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'message' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    // Get Discord settings from entity config
    const discordSettings = ctx.config.discordSettings as DiscordSettings | undefined;

    if (!discordSettings || !discordSettings.enabled) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Discord DM is not configured or is disabled. The user needs to set up Discord settings.",
        isError: false,
      };
    }

    if (!discordSettings.botToken) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Discord bot token is not configured. The user needs to set a bot token in Discord settings.",
        isError: true,
      };
    }

    const channelId = (typeof overrideChannelId === "string" && overrideChannelId.trim())
      ? overrideChannelId.trim()
      : discordSettings.defaultChannelId;

    if (!channelId) {
      return {
        toolCallId: ctx.toolCallId,
        content: "No Discord channel ID configured and no channel_id argument provided. The user needs to set a default channel ID in Discord settings.",
        isError: true,
      };
    }

    try {
      const headers = {
        "Authorization": `Bot ${discordSettings.botToken}`,
        "Content-Type": "application/json",
      };

      // The configured ID is a user ID, not a channel ID.
      // Discord requires us to create/open a DM channel first.
      const dmResp = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers,
        body: JSON.stringify({ recipient_id: channelId }),
      });

      if (!dmResp.ok) {
        const body = await dmResp.text();
        if (dmResp.status === 401) {
          return {
            toolCallId: ctx.toolCallId,
            content: "Discord API error: Invalid bot token (401 Unauthorized). The bot token may be incorrect or revoked.",
            isError: true,
          };
        }
        return {
          toolCallId: ctx.toolCallId,
          content: `Discord API error: Could not create DM channel (${dmResp.status}) ${body.substring(0, 200)}`,
          isError: true,
        };
      }

      const dmChannel = await dmResp.json() as { id: string };
      const dmChannelId = dmChannel.id;

      const url = `https://discord.com/api/v10/channels/${dmChannelId}/messages`;

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: message.trim().substring(0, 2000),
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();

        if (resp.status === 401) {
          return {
            toolCallId: ctx.toolCallId,
            content: `Discord API error: Invalid bot token (401 Unauthorized). The bot token may be incorrect or revoked.`,
            isError: true,
          };
        }

        if (resp.status === 403) {
          return {
            toolCallId: ctx.toolCallId,
            content: `Discord API error: Missing access (403 Forbidden). The bot cannot send messages to this channel. Ensure the bot has access to the channel/user.`,
            isError: true,
          };
        }

        if (resp.status === 429) {
          const retryAfter = resp.headers.get("Retry-After");
          const retryInfo = retryAfter ? ` Retry after ${retryAfter}s.` : "";
          return {
            toolCallId: ctx.toolCallId,
            content: `Discord API error: Rate limited (429).${retryInfo} Try again shortly.`,
            isError: true,
          };
        }

        return {
          toolCallId: ctx.toolCallId,
          content: `Discord API error: ${resp.status} ${body.substring(0, 200)}`,
          isError: true,
        };
      }

      const data = await resp.json() as { id: string };
      console.log(`[Discord] DM sent to user ${channelId} via channel ${dmChannelId}, message ID: ${data.id}`);

      return {
        toolCallId: ctx.toolCallId,
        content: `Discord DM sent successfully (message ID: ${data.id})`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Discord] Failed to send DM:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error sending Discord DM: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
