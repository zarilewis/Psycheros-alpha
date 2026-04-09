/**
 * Pulse Tool (Omni)
 *
 * Unified tool for creating, triggering, and deleting Pulses during
 * conversations. Replaces the previous 3 separate pulse tools with a
 * single tool using an operation discriminator.
 *
 * @module
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

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

// =============================================================================
// Tool Definition
// =============================================================================

export const pulseTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "pulse",
      description:
        "Create, trigger, or delete Pulses — scheduled or triggered prompts that I execute autonomously. " +
        "Use this to schedule reminders, follow-ups, or background tasks. " +
        "Entity-created Pulses auto-delete after firing by default.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["create", "trigger", "delete"],
            description: "The operation to perform. 'create' to schedule a new Pulse, 'trigger' to fire one immediately, 'delete' to remove it.",
          },
          pulse_id: {
            type: "string",
            description: "For trigger/delete: the Pulse ID",
          },
          // create fields
          name: {
            type: "string",
            description: "For create: a short descriptive name (e.g., 'Remind about dentist appointment')",
          },
          description: {
            type: "string",
            description: "For create: what this Pulse does and why it was created",
          },
          prompt_text: {
            type: "string",
            description: "For create: the prompt I should process when this Pulse fires. Written in first-person as instructions to myself.",
          },
          trigger_type: {
            type: "string",
            enum: ["cron", "inactivity", "webhook"],
            description: "For create: 'cron' for scheduled, 'inactivity' for after user is idle, 'webhook' for external signals.",
          },
          cron_expression: {
            type: "string",
            description: "For create with cron: schedule (e.g., '0 14 * * *' for 2 PM daily)",
          },
          interval_seconds: {
            type: "number",
            description: "For create with cron: run every N seconds (alternative to cron_expression)",
          },
          inactivity_threshold_seconds: {
            type: "number",
            description: "For create with inactivity: trigger after this many seconds of user inactivity",
          },
          chat_mode: {
            type: "string",
            enum: ["visible", "silent"],
            description: "For create: whether my response appears in chat ('visible') or runs silently ('silent'). Default: 'visible'.",
          },
          auto_delete: {
            type: "boolean",
            description: "For create: delete after firing successfully. Default: true for entity-created Pulses.",
          },
        },
        required: ["operation"],
      },
    },
  },

  execute: (args, ctx): Promise<ToolResult> => {
    const operation = args.operation as string;

    if (!operation) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: 'operation' is required. Use one of: create, trigger, delete.",
        isError: true,
      });
    }

    switch (operation) {
      case "create":
        return executeCreate(args, ctx);
      case "trigger":
        return executeTrigger(args, ctx);
      case "delete":
        return executeDelete(args, ctx);
      default:
        return Promise.resolve({
          toolCallId: ctx.toolCallId,
          content: `Error: Unknown operation '${operation}'. Use one of: create, trigger, delete.`,
          isError: true,
        });
    }
  },
};

// =============================================================================
// Operation Implementations
// =============================================================================

function executeCreate(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const name = args.name;
  const promptText = args.prompt_text;
  const triggerType = args.trigger_type as string;

  if (typeof name !== "string" || !name.trim()) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: "Error: name must be a non-empty string", isError: true });
  }

  if (typeof promptText !== "string" || !promptText.trim()) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: "Error: prompt_text must be a non-empty string", isError: true });
  }

  if (!["cron", "inactivity", "webhook"].includes(triggerType)) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: "Error: trigger_type must be 'cron', 'inactivity', or 'webhook'", isError: true });
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
    autoDelete: args.auto_delete !== false,
  });

  return Promise.resolve({
    toolCallId: ctx.toolCallId,
    content: `Created Pulse "${pulse.name}" (ID: ${pulse.id}). ` +
      `Trigger: ${pulse.triggerType}, Mode: ${pulse.chatMode}, Auto-delete: ${pulse.autoDelete}.`,
  });
}

function executeTrigger(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const pulseId = args.pulse_id;

  if (typeof pulseId !== "string" || !pulseId.trim()) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: "Error: pulse_id must be a non-empty string", isError: true });
  }

  const pulse = ctx.db.getPulse(pulseId);
  if (!pulse) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: `Error: Pulse not found: ${pulseId}`, isError: true });
  }

  if (!pulse.enabled) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: `Error: Pulse "${pulse.name}" is disabled`, isError: true });
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
}

function executeDelete(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const pulseId = args.pulse_id;

  if (typeof pulseId !== "string" || !pulseId.trim()) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: "Error: pulse_id must be a non-empty string", isError: true });
  }

  const pulse = ctx.db.getPulse(pulseId);
  if (!pulse) {
    return Promise.resolve({ toolCallId: ctx.toolCallId, content: `Error: Pulse not found: ${pulseId}`, isError: true });
  }

  ctx.db.deletePulse(pulseId);

  return Promise.resolve({
    toolCallId: ctx.toolCallId,
    content: `Deleted Pulse "${pulse.name}" (${pulseId}).`,
  });
}
