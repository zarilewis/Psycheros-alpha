/**
 * Pulse Tools
 *
 * Tools that allow the entity to create, trigger, and delete Pulses
 * during conversations. This enables the entity to make promises
 * like "I'll remind you in 2 hours" and follow through.
 *
 * @module
 */

import type { ToolResult } from "../types.ts";
import type { Tool } from "./types.ts";

// The PulseEngine instance is set at server startup
let pulseEngine: {
  executePulse(
    pulseId: string,
    triggerSource: "cron" | "webhook" | "filesystem" | "chain" | "manual" | "inactivity",
    chainDepth: number,
    parentRunId: string | null,
  ): Promise<void>;
} | null = null;

/**
 * Set the PulseEngine instance. Called during server initialization.
 */
export function setPulseEngine(engine: typeof pulseEngine): void {
  pulseEngine = engine;
}

/**
 * Tool: Create a new Pulse.
 *
 * The entity can use this to schedule a reminder, follow-up, or
 * background task. Entity-created Pulses default to auto_delete.
 */
export const createPulseTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "create_pulse",
      description:
        "Create a new Pulse — a scheduled or triggered prompt that I execute autonomously. " +
        "Use this to schedule reminders, follow-ups, or background tasks for myself. " +
        "Entity-created Pulses auto-delete after firing by default.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A short descriptive name for this Pulse (e.g., 'Remind about dentist appointment')",
          },
          description: {
            type: "string",
            description: "What this Pulse does and why it was created",
          },
          prompt_text: {
            type: "string",
            description: "The prompt I should process when this Pulse fires. Written in first-person as instructions to myself.",
          },
          trigger_type: {
            type: "string",
            enum: ["cron", "inactivity", "webhook"],
            description: "How this Pulse is triggered. 'cron' for scheduled, 'inactivity' for after user is idle, 'webhook' for external signals.",
          },
          cron_expression: {
            type: "string",
            description: "Cron schedule (e.g., '0 14 * * *' for 2 PM daily). Required if trigger_type is 'cron'.",
          },
          interval_seconds: {
            type: "number",
            description: "Run every N seconds. Alternative to cron_expression.",
          },
          inactivity_threshold_seconds: {
            type: "number",
            description: "Trigger after this many seconds of user inactivity. Required if trigger_type is 'inactivity'.",
          },
          chat_mode: {
            type: "string",
            enum: ["visible", "silent"],
            description: "Whether my response appears in the chat ('visible') or runs silently ('silent'). Default: 'visible'.",
          },
          auto_delete: {
            type: "boolean",
            description: "Delete this Pulse after it fires successfully. Default: true for entity-created Pulses.",
          },
        },
        required: ["name", "prompt_text", "trigger_type"],
      },
    },
  },

  execute: (args, ctx): Promise<ToolResult> => {
    const name = args.name;
    const promptText = args.prompt_text;
    const triggerType = args.trigger_type as string;

    if (typeof name !== "string" || !name.trim()) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: name must be a non-empty string",
        isError: true,
      });
    }

    if (typeof promptText !== "string" || !promptText.trim()) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: prompt_text must be a non-empty string",
        isError: true,
      });
    }

    if (!["cron", "inactivity", "webhook"].includes(triggerType)) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: trigger_type must be 'cron', 'inactivity', or 'webhook'",
        isError: true,
      });
    }

    // Validate trigger-specific fields
    if (triggerType === "cron") {
      const hasCron = typeof args.cron_expression === "string" && args.cron_expression.trim();
      const hasInterval = typeof args.interval_seconds === "number";
      if (!hasCron && !hasInterval) {
        return Promise.resolve({
          toolCallId: ctx.toolCallId,
          content: "Error: cron trigger requires either cron_expression or interval_seconds",
          isError: true,
        });
      }
    }

    if (triggerType === "inactivity" && typeof args.inactivity_threshold_seconds !== "number") {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: inactivity trigger requires inactivity_threshold_seconds",
        isError: true,
      });
    }

    const pulse = ctx.db.createPulse({
      name: name.trim(),
      description: typeof args.description === "string" ? args.description : null,
      promptText: promptText.trim(),
      chatMode: (args.chat_mode === "silent" ? "silent" : "visible") as "visible" | "silent",
      conversationId: ctx.conversationId,
      enabled: true,
      triggerType: triggerType as "cron" | "inactivity" | "webhook",
      cronExpression: typeof args.cron_expression === "string" ? args.cron_expression : null,
      intervalSeconds: typeof args.interval_seconds === "number" ? args.interval_seconds : null,
      inactivityThresholdSeconds: typeof args.inactivity_threshold_seconds === "number"
        ? args.inactivity_threshold_seconds
        : null,
      source: "entity",
      autoDelete: args.auto_delete !== false, // Default true for entity-created
    });

    // Register triggers with the engine
    if (pulseEngine) {
      // The engine is a PulseEngine — we need to trigger trigger registration
      // This is handled via the server's pulse engine reference
    }

    return Promise.resolve({
      toolCallId: ctx.toolCallId,
      content: `Created Pulse "${pulse.name}" (ID: ${pulse.id}). ` +
        `Trigger: ${pulse.triggerType}, Mode: ${pulse.chatMode}, Auto-delete: ${pulse.autoDelete}.`,
    });
  },
};

/**
 * Tool: Trigger an existing Pulse to execute immediately.
 */
export const triggerPulseTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "trigger_pulse",
      description:
        "Trigger an existing Pulse to execute immediately, regardless of its schedule. " +
        "Use this to manually fire a scheduled Pulse when needed.",
      parameters: {
        type: "object",
        properties: {
          pulse_id: {
            type: "string",
            description: "The ID of the Pulse to trigger",
          },
        },
        required: ["pulse_id"],
      },
    },
  },

  execute: (args, ctx): Promise<ToolResult> => {
    const pulseId = args.pulse_id;

    if (typeof pulseId !== "string" || !pulseId.trim()) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: pulse_id must be a non-empty string",
        isError: true,
      });
    }

    const pulse = ctx.db.getPulse(pulseId);
    if (!pulse) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: `Error: Pulse not found: ${pulseId}`,
        isError: true,
      });
    }

    if (!pulse.enabled) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: `Error: Pulse "${pulse.name}" is disabled`,
        isError: true,
      });
    }

    // Fire and forget
    if (pulseEngine) {
      pulseEngine.executePulse(pulseId, "manual", 0, null).catch((err) => {
        console.error(`[Pulse] Tool-triggered execution error:`, err);
      });
    }

    return Promise.resolve({
      toolCallId: ctx.toolCallId,
      content: `Triggered Pulse "${pulse.name}". It will execute asynchronously.`,
    });
  },
};

/**
 * Tool: Delete an existing Pulse.
 */
export const deletePulseTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "delete_pulse",
      description:
        "Delete an existing Pulse. Removes it from the schedule permanently. " +
        "Only delete Pulses I created — do not delete user-created Pulses unless asked.",
      parameters: {
        type: "object",
        properties: {
          pulse_id: {
            type: "string",
            description: "The ID of the Pulse to delete",
          },
        },
        required: ["pulse_id"],
      },
    },
  },

  execute: (args, ctx): Promise<ToolResult> => {
    const pulseId = args.pulse_id;

    if (typeof pulseId !== "string" || !pulseId.trim()) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: pulse_id must be a non-empty string",
        isError: true,
      });
    }

    const pulse = ctx.db.getPulse(pulseId);
    if (!pulse) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: `Error: Pulse not found: ${pulseId}`,
        isError: true,
      });
    }

    ctx.db.deletePulse(pulseId);

    return Promise.resolve({
      toolCallId: ctx.toolCallId,
      content: `Deleted Pulse "${pulse.name}" (${pulseId}).`,
    });
  },
};
