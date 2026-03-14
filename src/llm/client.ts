/**
 * LLM Client
 *
 * Handles all communication with the Z.ai API using the OpenAI-compatible
 * protocol. Supports streaming requests, tool calling, and chain-of-thought
 * reasoning.
 */

import type { ToolDefinition } from "../types.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponseChunk,
  LLMConfig,
  StreamChunk,
} from "./types.ts";
import { LLMError } from "./types.ts";
import type { MetricsCollector } from "../metrics/mod.ts";
import { recordFirstByte, recordChunk } from "../metrics/mod.ts";

/**
 * Accumulator for building tool calls from streamed chunks.
 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Emit accumulated tool calls as StreamChunks.
 * Clears the accumulator map after emitting.
 */
function* emitAccumulatedToolCalls(
  accumulators: Map<number, ToolCallAccumulator>
): Generator<StreamChunk, void, unknown> {
  for (const [index, acc] of accumulators) {
    if (acc.id && acc.name) {
      yield {
        type: "tool_call",
        toolCall: {
          id: acc.id,
          type: "function",
          function: {
            name: acc.name,
            arguments: acc.arguments,
          },
        },
      };
    }
    accumulators.delete(index);
  }
}

/**
 * Client for communicating with the LLM API.
 */
export class LLMClient {
  private readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Make a streaming chat request.
   *
   * Yields parsed chunks that classify the content type for easy consumption.
   * Tool calls are accumulated across chunks and emitted when complete.
   *
   * @param messages - The conversation messages
   * @param tools - Optional tool definitions
   * @param options - Optional request parameters including metrics collector
   * @yields StreamChunk objects with classified content
   */
  async *chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      metricsCollector?: MetricsCollector;
    },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const request = this.buildRequest(messages, tools, true, options);
    const streamStallTimeout = this.config.streamStallTimeout ?? 60_000;

    // Log the outgoing request for observability
    const toolCount = tools?.length ?? 0;
    const messageCount = messages.length;
    console.log(
      `[LLM] Sending request to ${this.config.baseUrl} — model=${this.config.model}, ` +
      `messages=${messageCount}, tools=${toolCount}, thinking=${this.config.thinkingEnabled}`,
    );
    const requestStart = Date.now();

    const response = await this.makeRequest(request);

    const connectMs = Date.now() - requestStart;
    console.log(`[LLM] Connected in ${connectMs}ms — HTTP ${response.status} ${response.statusText}`);

    // Record first byte timing if metrics collector is provided
    if (options?.metricsCollector) {
      recordFirstByte(options.metricsCollector);
    }

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new LLMError("Response body is null", "NO_BODY");
    }

    // Track tool calls being accumulated across chunks
    const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

    // Track the last finish reason we saw (to use in done event)
    let lastFinishReason: string | null = null;
    // Track if we've already emitted a done event
    let doneEmitted = false;
    // Track content chunks for stall/empty detection
    let contentChunkCount = 0;
    // Track consecutive malformed chunks
    let consecutiveMalformed = 0;
    const MAX_CONSECUTIVE_MALFORMED = 5;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        // Read with stall timeout — if no data arrives for streamStallTimeout ms, abort
        const { done, value } = await this.readWithTimeout(reader, streamStallTimeout);

        if (done) {
          // Flush any remaining bytes from the decoder
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from the buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const chunk = this.parseSSELine(line);

          if (chunk === null) {
            consecutiveMalformed = 0; // Reset on valid (empty/comment) lines
            continue; // Empty line or comment
          }

          if (chunk === "done") {
            const elapsed = Date.now() - requestStart;
            console.log(
              `[LLM] Stream complete — ${contentChunkCount} content chunks in ${elapsed}ms, ` +
              `finish_reason=${lastFinishReason || "stop"}`,
            );
            // Emit any remaining tool calls before done
            yield* emitAccumulatedToolCalls(toolCallAccumulators);
            // Only emit done if we haven't already (from finish_reason)
            if (!doneEmitted) {
              yield { type: "done", finishReason: lastFinishReason || "stop" };
              doneEmitted = true;
            }
            return;
          }

          if (chunk === "malformed") {
            consecutiveMalformed++;
            if (consecutiveMalformed >= MAX_CONSECUTIVE_MALFORMED) {
              throw new LLMError(
                `Received ${MAX_CONSECUTIVE_MALFORMED} consecutive malformed SSE chunks from the API — ` +
                "the upstream response may be corrupted",
                "MALFORMED_STREAM",
              );
            }
            continue;
          }

          consecutiveMalformed = 0; // Reset on valid parsed chunk

          // Process the chunk
          for (const streamChunk of this.processChunk(
            chunk,
            toolCallAccumulators,
          )) {
            // Track finish reason but don't emit done yet - wait for [DONE] signal
            if (streamChunk.type === "done") {
              lastFinishReason = streamChunk.finishReason;
              // Don't yield the done chunk here - we'll emit it when we see [DONE]
              continue;
            }
            if (streamChunk.type === "content" || streamChunk.type === "thinking") {
              contentChunkCount++;
            }
            // Record chunk timing for metrics
            if (options?.metricsCollector) {
              const isContent = streamChunk.type === "content" || streamChunk.type === "thinking";
              recordChunk(options.metricsCollector, isContent);
            }
            yield streamChunk;
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const chunk = this.parseSSELine(buffer);
        if (chunk && chunk !== "done" && chunk !== "malformed") {
          for (const streamChunk of this.processChunk(
            chunk,
            toolCallAccumulators,
          )) {
            if (streamChunk.type === "done") {
              lastFinishReason = streamChunk.finishReason;
              continue;
            }
            if (streamChunk.type === "content" || streamChunk.type === "thinking") {
              contentChunkCount++;
            }
            // Record chunk timing for metrics
            if (options?.metricsCollector) {
              const isContent = streamChunk.type === "content" || streamChunk.type === "thinking";
              recordChunk(options.metricsCollector, isContent);
            }
            yield streamChunk;
          }
        }
      }

      // If we never got a [DONE] signal but the stream ended, emit done now
      if (!doneEmitted) {
        const elapsed = Date.now() - requestStart;
        console.warn(
          `[LLM] Stream ended without [DONE] signal — ${contentChunkCount} content chunks in ${elapsed}ms, ` +
          `finish_reason=${lastFinishReason || "unknown"}`,
        );
        // Emit any remaining tool calls
        yield* emitAccumulatedToolCalls(toolCallAccumulators);
        yield { type: "done", finishReason: lastFinishReason || "stop" };
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after cancel() in timeout path
      }
    }
  }

  /**
   * Read from a stream reader with a stall timeout.
   * If no data arrives within the timeout period, throws an LLMError.
   */
  private readWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Cancel the reader to tear down the underlying TCP connection.
        // This also resolves the pending read() with { done: true },
        // but since our promise is already rejected, that's a no-op.
        reader.cancel().catch(() => {});
        reject(
          new LLMError(
            `LLM stream stalled — no data received for ${Math.round(timeoutMs / 1000)}s. ` +
            "The upstream API may be overloaded or the connection was dropped",
            "STREAM_STALL_TIMEOUT",
          ),
        );
      }, timeoutMs);

      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Build a chat request object.
   */
  private buildRequest(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: { temperature?: number; maxTokens?: number },
  ): ChatRequest {
    const request: ChatRequest = {
      model: this.config.model,
      messages,
      stream,
    };

    if (this.config.thinkingEnabled) {
      request.thinking = { type: "enabled" };
    }

    if (tools && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = "auto";
    }

    // Per-call options override config-level defaults
    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    } else if (this.config.temperature !== undefined) {
      request.temperature = this.config.temperature;
    }

    if (options?.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    } else if (this.config.maxTokens !== undefined) {
      request.max_tokens = this.config.maxTokens;
    }

    if (this.config.topP !== undefined) {
      request.top_p = this.config.topP;
    }

    if (this.config.topK !== undefined && this.config.topK > 0) {
      request.top_k = this.config.topK;
    }

    if (this.config.frequencyPenalty !== undefined) {
      request.frequency_penalty = this.config.frequencyPenalty;
    }

    if (this.config.presencePenalty !== undefined) {
      request.presence_penalty = this.config.presencePenalty;
    }

    return request;
  }

  /**
   * Make the HTTP request to the API with a connection timeout.
   *
   * @throws LLMError on network failures or timeout
   */
  private async makeRequest(request: ChatRequest): Promise<Response> {
    const connectTimeout = this.config.connectTimeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeout);

    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new LLMError(
          `LLM API connection timed out after ${connectTimeout}ms — the upstream API may be down or unreachable`,
          "CONNECT_TIMEOUT",
        );
      }
      // Wrap network errors in LLMError for consistent error handling
      const message =
        error instanceof Error ? error.message : "Unknown network error";
      throw new LLMError(`Network error: ${message}`, "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Handle an error response from the API.
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `API request failed with status ${response.status}`;
    let errorCode: string | undefined;

    try {
      const errorBody = await response.json();
      if (errorBody.error) {
        errorMessage = errorBody.error.message || errorMessage;
        errorCode = errorBody.error.code;
      }
    } catch {
      // If we can't parse the error body, use the status text
      errorMessage = `${errorMessage}: ${response.statusText}`;
    }

    console.error(
      `[LLM] API error — HTTP ${response.status}, code=${errorCode || "none"}, message=${errorMessage}`,
    );

    throw new LLMError(errorMessage, errorCode, response.status);
  }

  /**
   * Parse a single SSE line.
   *
   * @returns The parsed chunk, "done" for end signal, or null for empty/comment lines
   */
  private parseSSELine(line: string): ChatResponseChunk | "done" | "malformed" | null {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(":")) {
      return null;
    }

    // Check for data prefix
    if (!trimmed.startsWith("data:")) {
      return null;
    }

    // Extract the data content
    const data = trimmed.slice(5).trim();

    // Check for done signal
    if (data === "[DONE]") {
      return "done";
    }

    // Parse JSON
    try {
      return JSON.parse(data) as ChatResponseChunk;
    } catch {
      console.warn("[LLM] Failed to parse SSE chunk:", data.substring(0, 200));
      return "malformed";
    }
  }

  /**
   * Process a parsed chunk and yield stream chunks.
   *
   * Note: This yields a "done" chunk when finish_reason is present, but
   * the caller should intercept this to track the finish reason rather
   * than forwarding it directly to consumers. The actual done event
   * should be emitted when the [DONE] SSE signal is received.
   */
  private *processChunk(
    chunk: ChatResponseChunk,
    toolCallAccumulators: Map<number, ToolCallAccumulator>,
  ): Generator<StreamChunk, void, unknown> {
    // Guard against missing or empty choices array
    if (!chunk.choices || chunk.choices.length === 0) {
      return;
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta;

      // Guard against missing delta
      if (!delta) {
        continue;
      }

      // Handle thinking/reasoning content
      if (delta.reasoning_content) {
        yield { type: "thinking", content: delta.reasoning_content };
      }

      // Handle main content
      if (delta.content) {
        yield { type: "content", content: delta.content };
      }

      // Handle tool calls (accumulate across chunks)
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index;

          // Get or create accumulator for this tool call index
          let acc = toolCallAccumulators.get(index);
          if (!acc) {
            acc = { id: "", name: "", arguments: "" };
            toolCallAccumulators.set(index, acc);
          }

          // Accumulate the tool call data
          if (toolCallDelta.id) {
            acc.id = toolCallDelta.id;
          }
          if (toolCallDelta.function?.name) {
            acc.name = toolCallDelta.function.name;
          }
          if (toolCallDelta.function?.arguments) {
            acc.arguments += toolCallDelta.function.arguments;
          }
        }
      }

      // Handle finish reason
      if (choice.finish_reason) {
        // Emit completed tool calls when we hit tool_calls finish reason
        if (choice.finish_reason === "tool_calls") {
          yield* emitAccumulatedToolCalls(toolCallAccumulators);
        }

        // Yield done with the actual finish reason
        // (caller should intercept this and emit later with [DONE])
        yield { type: "done", finishReason: choice.finish_reason };
      }
    }
  }
}

/**
 * Create an LLM client with the default Z.ai configuration.
 *
 * @param options - Optional configuration overrides
 * @throws LLMError if API key is not provided and ZAI_API_KEY env var is not set
 */
export function createDefaultClient(
  options?: Partial<LLMConfig>,
): LLMClient {
  const apiKey = options?.apiKey || Deno.env.get("ZAI_API_KEY");

  if (!apiKey) {
    throw new LLMError(
      "API key is required. Set ZAI_API_KEY environment variable or provide apiKey in options.",
      "MISSING_API_KEY",
    );
  }

  const config: LLMConfig = {
    baseUrl:
      options?.baseUrl ||
      Deno.env.get("ZAI_BASE_URL") ||
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
    apiKey,
    model: options?.model || Deno.env.get("ZAI_MODEL") || "glm-4.7",
    thinkingEnabled: options?.thinkingEnabled ?? true,
  };

  return new LLMClient(config);
}

/**
 * Create an LLM client configured for the worker model.
 *
 * Uses the same API credentials but with a lighter model (ZAI_WORKER_MODEL)
 * suitable for quick tasks like auto-titling conversations.
 *
 * @param options - Optional configuration overrides
 * @throws LLMError if API key is not provided and ZAI_API_KEY env var is not set
 */
export function createWorkerClient(
  options?: Partial<LLMConfig>,
): LLMClient {
  const apiKey = options?.apiKey || Deno.env.get("ZAI_API_KEY");

  if (!apiKey) {
    throw new LLMError(
      "API key is required. Set ZAI_API_KEY environment variable or provide apiKey in options.",
      "MISSING_API_KEY",
    );
  }

  const config: LLMConfig = {
    baseUrl:
      options?.baseUrl ||
      Deno.env.get("ZAI_BASE_URL") ||
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
    apiKey,
    model: options?.model || Deno.env.get("ZAI_WORKER_MODEL") || "GLM-4.5-Air",
    thinkingEnabled: options?.thinkingEnabled ?? false, // Worker model doesn't need thinking
  };

  return new LLMClient(config);
}
