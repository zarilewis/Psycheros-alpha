/**
 * LLM Client
 *
 * Handles all communication with the Z.ai API using the OpenAI-compatible
 * protocol. Supports both streaming and non-streaming requests, tool calling,
 * and chain-of-thought reasoning.
 */

import type { ToolDefinition } from "../types.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatResponseChunk,
  LLMConfig,
  StreamChunk,
} from "./types.ts";
import { LLMError } from "./types.ts";

/**
 * Client for communicating with the LLM API.
 */
export class LLMClient {
  private readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Make a non-streaming chat request.
   *
   * @param messages - The conversation messages
   * @param tools - Optional tool definitions
   * @param options - Optional request parameters
   * @returns The complete chat response
   */
  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<ChatResponse> {
    const request = this.buildRequest(messages, tools, false, options);
    const response = await this.makeRequest(request);

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const data = (await response.json()) as ChatResponse;
    return data;
  }

  /**
   * Make a streaming chat request.
   *
   * Yields parsed chunks that classify the content type for easy consumption.
   * Tool calls are accumulated across chunks and emitted when complete.
   *
   * @param messages - The conversation messages
   * @param tools - Optional tool definitions
   * @param options - Optional request parameters
   * @yields StreamChunk objects with classified content
   */
  async *chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const request = this.buildRequest(messages, tools, true, options);
    const response = await this.makeRequest(request);

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new LLMError("Response body is null", "NO_BODY");
    }

    // Track tool calls being accumulated across chunks
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    // Track the last finish reason we saw (to use in done event)
    let lastFinishReason: string | null = null;
    // Track if we've already emitted a done event
    let doneEmitted = false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

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
            continue; // Empty line or comment
          }

          if (chunk === "done") {
            // Emit any remaining tool calls before done
            for (const [index, acc] of toolCallAccumulators) {
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
              toolCallAccumulators.delete(index);
            }
            // Only emit done if we haven't already (from finish_reason)
            if (!doneEmitted) {
              yield { type: "done", finishReason: lastFinishReason || "stop" };
              doneEmitted = true;
            }
            return;
          }

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
            yield streamChunk;
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const chunk = this.parseSSELine(buffer);
        if (chunk && chunk !== "done") {
          for (const streamChunk of this.processChunk(
            chunk,
            toolCallAccumulators,
          )) {
            if (streamChunk.type === "done") {
              lastFinishReason = streamChunk.finishReason;
              continue;
            }
            yield streamChunk;
          }
        }
      }

      // If we never got a [DONE] signal but the stream ended, emit done now
      if (!doneEmitted) {
        // Emit any remaining tool calls
        for (const [_index, acc] of toolCallAccumulators) {
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
        }
        yield { type: "done", finishReason: lastFinishReason || "stop" };
      }
    } finally {
      reader.releaseLock();
    }
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

    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    }

    return request;
  }

  /**
   * Make the HTTP request to the API.
   *
   * @throws LLMError on network failures
   */
  private async makeRequest(request: ChatRequest): Promise<Response> {
    try {
      return await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // Wrap network errors in LLMError for consistent error handling
      const message =
        error instanceof Error ? error.message : "Unknown network error";
      throw new LLMError(`Network error: ${message}`, "NETWORK_ERROR");
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

    throw new LLMError(errorMessage, errorCode, response.status);
  }

  /**
   * Parse a single SSE line.
   *
   * @returns The parsed chunk, "done" for end signal, or null for empty/comment lines
   */
  private parseSSELine(line: string): ChatResponseChunk | "done" | null {
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
      // Log but don't throw - malformed chunks can happen
      console.warn("Failed to parse SSE chunk:", data);
      return null;
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
    toolCallAccumulators: Map<
      number,
      { id: string; name: string; arguments: string }
    >,
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

          // Initialize accumulator if this is a new tool call
          if (!toolCallAccumulators.has(index)) {
            toolCallAccumulators.set(index, { id: "", name: "", arguments: "" });
          }

          const acc = toolCallAccumulators.get(index)!;

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
          for (const [index, acc] of toolCallAccumulators) {
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
            toolCallAccumulators.delete(index);
          }
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
