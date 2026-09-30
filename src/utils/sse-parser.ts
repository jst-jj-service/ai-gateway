import { TokenUsageDetails } from '../types';
import { ErrorSanitizerService } from '../services/error-sanitizer.service';

export interface ParsedSseResult {
  rawEvents: string[];
  usage?: TokenUsageDetails;
  hasDone: boolean;
  hasError: boolean;
  errorMessage?: string;
}

/**
 * Parses raw Server-Sent Events buffer chunks from upstream AI gateway.
 * Safely sanitizes errors within the stream and handles CRLF boundaries.
 */
export class SseStreamParser {
  private buffer = '';
  public lastUsage?: TokenUsageDetails;
  public isDone = false;
  public hasError = false;
  public errorMessage?: string;
  public estimatedCompletionTokens = 0;

  /**
   * Feeds a raw binary or text chunk from upstream and returns sanitized events.
   */
  public feed(chunk: string | Buffer): { forwardChunk: string; usageFound?: TokenUsageDetails } {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    // Normalize CRLF to LF to prevent stray \r characters from breaking SSE events
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let forwardChunk = '';
    const lines = this.buffer.split('\n');
    // Retain incomplete last line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        forwardChunk += '\n';
        continue;
      }

      if (trimmed.startsWith('data: ')) {
        const dataPayload = trimmed.slice(6).trim();

        if (dataPayload === '[DONE]') {
          this.isDone = true;
          forwardChunk += `${line}\n`;
          continue;
        }

        try {
          const json = JSON.parse(dataPayload);

          // Check if upstream returned an error payload inside SSE stream
          if (json.error) {
            this.hasError = true;
            this.errorMessage = typeof json.error === 'string' ? json.error : json.error.message;

            // Intercept and sanitize the error inside the stream!
            // NEVER leak upstream's raw error or prompt details!
            const sanitizedEvent = ErrorSanitizerService.streamingErrorEvent(
              'The upstream AI service encountered a temporary error. Please try again with a shorter prompt or retry shortly.'
            );
            forwardChunk += sanitizedEvent;
            continue;
          }

          // Extract token usage if provided (e.g. stream_options: { include_usage: true } or Responses API)
          const usagePayload = json.usage || json.response?.usage;
          if (usagePayload) {
            this.lastUsage = {
              prompt_tokens: usagePayload.prompt_tokens ?? usagePayload.input_tokens ?? 0,
              completion_tokens: usagePayload.completion_tokens ?? usagePayload.output_tokens ?? 0,
              total_tokens: usagePayload.total_tokens ?? ((usagePayload.prompt_tokens ?? usagePayload.input_tokens ?? 0) + (usagePayload.completion_tokens ?? usagePayload.output_tokens ?? 0)),
              prompt_tokens_details: usagePayload.prompt_tokens_details || usagePayload.input_tokens_details
            };
          }

          // Count tokens roughly if usage is not explicitly supplied in chunk
          let deltaText = '';
          if (json.choices && json.choices[0]?.delta?.content) {
            deltaText = json.choices[0].delta.content;
          } else if (typeof json.delta === 'string') {
            deltaText = json.delta;
          } else if (typeof json.delta?.text === 'string') {
            deltaText = json.delta.text;
          } else if (typeof json.delta?.content === 'string') {
            deltaText = json.delta.content;
          } else if (typeof json.text === 'string' && (json.type?.includes('delta') || json.type?.includes('text'))) {
            deltaText = json.text;
          } else if (Array.isArray(json.item?.content)) {
            for (const part of json.item.content) {
              if (typeof part?.text === 'string') deltaText += part.text;
            }
          }

          if (deltaText) {
            this.estimatedCompletionTokens += Math.max(1, Math.ceil(deltaText.length / 3.5));
          }

          forwardChunk += `${line}\n`;
        } catch {
          // If non-JSON data line, pass forward cleanly
          forwardChunk += `${line}\n`;
        }
      } else {
        forwardChunk += `${line}\n`;
      }
    }

    return { forwardChunk, usageFound: this.lastUsage };
  }

  public flushRemaining(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }
}
