import { FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest } from 'undici';
import { Config } from '../config';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { ErrorSanitizerService } from './error-sanitizer.service';
import { SseStreamParser } from '../utils/sse-parser';
import { AuthenticatedUser } from '../types';
import { selectKeyForModel } from './upstream-keys';

function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 10;
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg?.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (typeof part?.text === 'string') chars += part.text.length;
      }
    }
  }
  return Math.max(8, Math.ceil(chars / 3.5));
}

function estimateResponsesTokens(body: Record<string, unknown>): number {
  const input = body.input || body.prompt || body.messages;
  if (!input) return 10;
  if (typeof input === 'string') return Math.max(8, Math.ceil(input.length / 3.5));
  if (Array.isArray(input)) {
    let chars = 0;
    for (const item of input) {
      if (typeof item === 'string') chars += item.length;
      else if (typeof item?.content === 'string') chars += item.content.length;
      else if (typeof item?.text === 'string') chars += item.text.length;
      else if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') chars += part.text.length;
        }
      }
    }
    return Math.max(8, Math.ceil(chars / 3.5));
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const text = typeof obj.content === 'string' ? obj.content : (typeof obj.text === 'string' ? obj.text : '');
    return Math.max(8, Math.ceil(text.length / 3.5));
  }
  return 10;
}

function estimateCompletionTokens(content: unknown): number {
  if (typeof content !== 'string') return 1;
  return Math.max(1, Math.ceil(content.length / 3.5));
}

export class ProxyService {
  constructor(
    private config: Config,
    private usageService: UsageService,
    private quotaService: QuotaService
  ) {}

  /**
   * Proxies /v1/chat/completions to upstream AI Gateway (https://api.hzapi.vip).
   * Intercepts errors and streams/responses to ensure absolute error sanitization:
   * 1. Never leaks upstream keys, endpoints, or error details.
   * 2. Never leaks user prompt messages in errors.
   * 3. Prevents concurrency race conditions via optimistic reservation and post-response reconciliation.
   */
  public async handleChatCompletion(
    req: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser
  ) {
    const startTime = Date.now();
    const body = (req.body as Record<string, unknown>) || {};

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({
        error: {
          message: 'Invalid request body. JSON object expected.',
          type: 'invalid_request_error',
          code: 'invalid_payload',
          status: 400
        }
      });
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request: "messages" must be a non-empty array.',
          type: 'invalid_request_error',
          code: 'missing_messages',
          status: 400,
          suggestion: 'Please provide a valid "messages" array according to the OpenAI API specification.'
        }
      });
    }

    const isStream = body.stream === true || body.stream === 'true';
    const model = (body.model as string) || 'unknown-model';

    // Validate max_tokens / max_completion_tokens if supplied
    let requestedMaxTokens: number | undefined = undefined;
    const rawMax = typeof body.max_tokens === 'number'
      ? body.max_tokens
      : (typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined);

    if (rawMax !== undefined) {
      if (!Number.isFinite(rawMax) || rawMax < 1) {
        return reply.code(400).send({
          error: {
            message: 'Invalid max_tokens parameter: must be a positive integer.',
            type: 'invalid_request_error',
            code: 'invalid_max_tokens',
            status: 400
          }
        });
      }
      requestedMaxTokens = Math.floor(rawMax);
    }

    // Estimate token reservation budget
    const promptTokensEst = estimatePromptTokens(body.messages);
    const quota = await this.quotaService.getQuota(user.id);
    const remaining = Number(quota.remainingTokens);

    const MIN_COMPLETION_TOKENS = 8;
    if (remaining < promptTokensEst + MIN_COMPLETION_TOKENS) {
      const quotaErr = ErrorSanitizerService.quotaExhaustedError(this.config.NEXT_PUBLIC_SHOP_URL);
      return reply.code(quotaErr.statusCode).send(quotaErr.payload);
    }

    const availableForCompletion = remaining - promptTokensEst;
    const cappedCompletionTokens = requestedMaxTokens !== undefined
      ? Math.min(requestedMaxTokens, availableForCompletion)
      : Math.min(4096, availableForCompletion);

    const reservationBudget = promptTokensEst + cappedCompletionTokens;
    const minRequired = promptTokensEst + MIN_COMPLETION_TOKENS;

    // Optimistically reserve quota before contacting upstream to block concurrent free usage
    const reservation = await this.quotaService.reserveQuota(user.id, reservationBudget, minRequired);
    if (!reservation.success) {
      const quotaErr = ErrorSanitizerService.quotaExhaustedError(this.config.NEXT_PUBLIC_SHOP_URL);
      return reply.code(quotaErr.statusCode).send(quotaErr.payload);
    }

    const maxAllowedTokens = reservation.reservedTokens;
    // Strict safety clamp: upstream can never physically generate more tokens than what was actually reserved
    const upstreamMaxCompletion = Math.min(
      cappedCompletionTokens,
      Math.max(1, maxAllowedTokens - promptTokensEst)
    );

    // Tracking variables for post-response reconciliation
    let actualTokensUsed = 0;
    let cachedTokensUsed = 0;
    let finalStatusCode = 500;

    // Prepare upstream target URL and headers
    const upstreamUrl = `${this.config.UPSTREAM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (isStream) {
      upstreamHeaders['Accept'] = 'text/event-stream';
    }

    const selectedKey = selectKeyForModel(model, this.config.UPSTREAM_KEYS, this.config.UPSTREAM_API_KEY);
    const effectiveApiKey = selectedKey ? selectedKey.apiKey : this.config.UPSTREAM_API_KEY;
    if (!effectiveApiKey) {
      return reply.code(400).send({
        error: {
          message: `The requested model '${model}' is not supported by any configured upstream tier, and no fallback API key is configured.`,
          type: 'invalid_request_error',
          code: 'model_not_supported',
          status: 400
        }
      });
    }

    upstreamHeaders['Authorization'] = `Bearer ${effectiveApiKey}`;

    if (req.headers['openai-organization']) {
      upstreamHeaders['openai-organization'] = String(req.headers['openai-organization']);
    }

    if (req.headers['openai-project']) {
      upstreamHeaders['openai-project'] = String(req.headers['openai-project']);
    }

    // Ensure upstream provides token usage details in streaming mode, and cap max_tokens to prevent free usage
    const proxyBody = { ...body };
    if (typeof body.max_completion_tokens === 'number') {
      proxyBody.max_completion_tokens = upstreamMaxCompletion;
    } else {
      proxyBody.max_tokens = upstreamMaxCompletion;
    }
    if (isStream) {
      const existingOptions = (body.stream_options as Record<string, unknown>) || {};
      proxyBody.stream_options = { ...existingOptions, include_usage: true };
    }

    // Abort controller linked to client connection close
    const abortController = new AbortController();
    const onClose = () => {
      abortController.abort();
    };
    req.raw.on('close', onClose);

    try {
      const upstreamResponse = await undiciRequest(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(proxyBody),
        headersTimeout: this.config.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: this.config.UPSTREAM_TIMEOUT_MS,
        signal: abortController.signal
      });

      const statusCode = upstreamResponse.statusCode;
      finalStatusCode = statusCode;
      const contentType = String(upstreamResponse.headers['content-type'] || '');

      // Handle upstream HTTP error status
      if (statusCode < 200 || statusCode >= 300) {
        let rawErrorBody = '';
        try {
          rawErrorBody = await upstreamResponse.body.text();
        } catch {
          // ignore
        }

        const sanitized = ErrorSanitizerService.sanitize(
          statusCode,
          `Upstream returned HTTP ${statusCode} for model ${model}: ${rawErrorBody}`
        );

        actualTokensUsed = 0;
        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          requestDurationMs: Date.now() - startTime,
          statusCode,
          isStream,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      // If client requested stream, but upstream returned JSON
      if (isStream && contentType.includes('application/json')) {
        const responseText = await upstreamResponse.body.text();
        let responseJson: Record<string, unknown>;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          const sanitized = ErrorSanitizerService.sanitize(502, 'Upstream returned invalid JSON');
          actualTokensUsed = 0;
          return reply.code(sanitized.statusCode).send(sanitized.payload);
        }

        if (responseJson.error) {
          const sanitized = ErrorSanitizerService.sanitize(
            502,
            `Upstream JSON error in stream request: ${JSON.stringify(responseJson.error)}`
          );
          actualTokensUsed = 0;
          finalStatusCode = 502;
          await this.usageService.recordApiUsage({
            userId: user.id,
            apiKeyId: user.apiKeyId,
            model,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            requestDurationMs: Date.now() - startTime,
            statusCode: 502,
            isStream: true,
            skipQuotaDeduct: true,
            upstreamGroup: selectedKey?.group,
            upstreamKeyName: selectedKey?.name
          });
          return reply.code(sanitized.statusCode).send(sanitized.payload);
        }

        return reply.code(200).send(responseJson);
      }

      // Handle streaming SSE response
      if (isStream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.raw.writeHead(200);

        const parser = new SseStreamParser();
        let streamAborted = false;
        let quotaCutoff = false;

        try {
          for await (const chunk of upstreamResponse.body) {
            const { forwardChunk } = parser.feed(chunk);
            if (forwardChunk) {
              reply.raw.write(forwardChunk);
            }

            // Quota protection: monitor tokens during streaming and cut off upstream if reservation limit reached
            const currentTotalTokens = promptTokensEst + parser.estimatedCompletionTokens;
            if (currentTotalTokens >= maxAllowedTokens) {
              quotaCutoff = true;
              abortController.abort();
              break;
            }
          }

          const remaining = parser.flushRemaining();
          if (remaining) {
            reply.raw.write(remaining);
          }
        } catch (streamError) {
          streamAborted = true;
          if (!quotaCutoff) {
            console.error('[ProxyService] Stream interrupted:', streamError);
            const sanitizedEvent = ErrorSanitizerService.streamingErrorEvent();
            reply.raw.write(sanitizedEvent);
          }
        } finally {
          reply.raw.end();
        }

        // If stream encountered an error, aborted midway, or hit quota limit
        if (parser.hasError || streamAborted || quotaCutoff) {
          const partialCompletionTokens = Math.min(
            parser.estimatedCompletionTokens,
            Math.max(0, maxAllowedTokens - promptTokensEst)
          );
          const partialTokens = Math.min(promptTokensEst + partialCompletionTokens, maxAllowedTokens);
          actualTokensUsed = partialTokens;
          finalStatusCode = quotaCutoff ? 200 : 502;

          await this.usageService.recordApiUsage({
            userId: user.id,
            apiKeyId: user.apiKeyId,
            model,
            promptTokens: promptTokensEst,
            completionTokens: partialCompletionTokens,
            cachedTokens: 0,
            totalTokens: partialTokens,
            requestDurationMs: Date.now() - startTime,
            statusCode: finalStatusCode,
            isStream: true,
            skipQuotaDeduct: true,
            upstreamGroup: selectedKey?.group,
            upstreamKeyName: selectedKey?.name
          });
          return;
        }

        // Calculate final usage
        const usage = parser.lastUsage;
        const promptTokens = usage?.prompt_tokens ?? promptTokensEst;
        const rawCompletionTokens = usage?.completion_tokens ?? parser.estimatedCompletionTokens;
        const completionTokens = Math.min(rawCompletionTokens, Math.max(0, maxAllowedTokens - promptTokens));
        const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const totalTokens = Math.min(usage?.total_tokens ?? (promptTokens + completionTokens), maxAllowedTokens);

        actualTokensUsed = totalTokens;
        cachedTokensUsed = cachedTokens;
        finalStatusCode = 200;

        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens,
          completionTokens,
          cachedTokens,
          totalTokens,
          requestDurationMs: Date.now() - startTime,
          statusCode: 200,
          isStream: true,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return;
      }

      // Non-streaming JSON response
      const responseText = await upstreamResponse.body.text();
      let responseJson: Record<string, unknown>;

      try {
        responseJson = JSON.parse(responseText);
      } catch {
        const sanitized = ErrorSanitizerService.sanitize(502, 'Upstream returned invalid JSON');
        actualTokensUsed = 0;
        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      // Check if upstream returned an error object inside HTTP 200
      if (responseJson.error) {
        const sanitized = ErrorSanitizerService.sanitize(
          502,
          `Upstream returned error in HTTP 200: ${JSON.stringify(responseJson.error)}`
        );
        actualTokensUsed = 0;
        finalStatusCode = 502;

        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          requestDurationMs: Date.now() - startTime,
          statusCode: 502,
          isStream: false,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      // Extract token usage safely bounded by maxAllowedTokens
      const usage = (responseJson.usage || {}) as {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
        };
      };

      const promptTokens = usage.prompt_tokens ?? promptTokensEst;
      const completionContent = (responseJson.choices as any[])?.[0]?.message?.content;
      const rawCompletion = usage.completion_tokens ?? estimateCompletionTokens(completionContent);
      const completionTokens = rawCompletion;
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

      actualTokensUsed = totalTokens;
      cachedTokensUsed = cachedTokens;
      finalStatusCode = 200;

      await this.usageService.recordApiUsage({
        userId: user.id,
        apiKeyId: user.apiKeyId,
        model,
        promptTokens,
        completionTokens,
        cachedTokens,
        totalTokens,
        requestDurationMs: Date.now() - startTime,
        statusCode: 200,
        isStream: false,
        skipQuotaDeduct: true,
        upstreamGroup: selectedKey?.group,
        upstreamKeyName: selectedKey?.name
      });

      return reply.code(200).send(responseJson);
    } catch (networkOrTimeoutError) {
      const sanitized = ErrorSanitizerService.sanitize(
        networkOrTimeoutError,
        `Network or timeout calling upstream: ${upstreamUrl}`
      );
      actualTokensUsed = 0;
      finalStatusCode = sanitized.statusCode;

      await this.usageService.recordApiUsage({
        userId: user.id,
        apiKeyId: user.apiKeyId,
        model,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        requestDurationMs: Date.now() - startTime,
        statusCode: sanitized.statusCode,
        isStream,
        skipQuotaDeduct: true,
        upstreamGroup: selectedKey?.group,
        upstreamKeyName: selectedKey?.name
      });

      return reply.code(sanitized.statusCode).send(sanitized.payload);
    } finally {
      req.raw.off('close', onClose);
      // Reconcile optimistic reservation with actual tokens consumed
      await this.quotaService.reconcileQuota(
        user.id,
        reservation.reservationId,
        actualTokensUsed,
        cachedTokensUsed,
        finalStatusCode
      );
    }
  }

  /**
   * Proxies /v1/responses to upstream AI Gateway (https://api.hzapi.vip).
   * Fully supports OpenAI Responses API specification with quota reservation and zero-leak sanitization.
   */
  public async handleResponses(
    req: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser
  ) {
    const startTime = Date.now();
    const body = (req.body as Record<string, unknown>) || {};

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({
        error: {
          message: 'Invalid request body. JSON object expected.',
          type: 'invalid_request_error',
          code: 'invalid_payload',
          status: 400
        }
      });
    }

    const inputData = body.input || body.prompt || body.messages;
    if (!inputData) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request: "input", "prompt", or "messages" is required.',
          type: 'invalid_request_error',
          code: 'missing_input',
          status: 400,
          suggestion: 'Please specify the input prompt for the Responses API request.'
        }
      });
    }

    const isStream = body.stream === true || body.stream === 'true';
    const model = (body.model as string) || 'unknown-model';

    // Validate max_output_tokens / max_tokens if supplied
    let requestedMaxTokens: number | undefined = undefined;
    const rawMax = typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : (typeof body.max_tokens === 'number' ? body.max_tokens : undefined);

    if (rawMax !== undefined) {
      if (!Number.isFinite(rawMax) || rawMax < 1) {
        return reply.code(400).send({
          error: {
            message: 'Invalid max_output_tokens parameter: must be a positive integer.',
            type: 'invalid_request_error',
            code: 'invalid_max_output_tokens',
            status: 400
          }
        });
      }
      requestedMaxTokens = Math.floor(rawMax);
    }

    // Estimate input tokens for reservation
    const inputTokensEst = estimateResponsesTokens(body);
    const quota = await this.quotaService.getQuota(user.id);
    const remaining = Number(quota.remainingTokens);

    const MIN_COMPLETION_TOKENS = 8;
    if (remaining < inputTokensEst + MIN_COMPLETION_TOKENS) {
      const quotaErr = ErrorSanitizerService.quotaExhaustedError(this.config.NEXT_PUBLIC_SHOP_URL);
      return reply.code(quotaErr.statusCode).send(quotaErr.payload);
    }

    const availableForOutput = remaining - inputTokensEst;
    const cappedOutputTokens = requestedMaxTokens !== undefined
      ? Math.min(requestedMaxTokens, availableForOutput)
      : Math.min(4096, availableForOutput);

    const reservationBudget = inputTokensEst + cappedOutputTokens;
    const minRequired = inputTokensEst + MIN_COMPLETION_TOKENS;

    // Optimistically reserve quota before calling upstream
    const reservation = await this.quotaService.reserveQuota(user.id, reservationBudget, minRequired);
    if (!reservation.success) {
      const quotaErr = ErrorSanitizerService.quotaExhaustedError(this.config.NEXT_PUBLIC_SHOP_URL);
      return reply.code(quotaErr.statusCode).send(quotaErr.payload);
    }

    const maxAllowedTokens = reservation.reservedTokens;
    // Strict safety clamp: upstream can never physically generate more tokens than what was actually reserved
    const upstreamMaxOutput = Math.min(
      cappedOutputTokens,
      Math.max(1, maxAllowedTokens - inputTokensEst)
    );

    let actualTokensUsed = 0;
    let cachedTokensUsed = 0;
    let finalStatusCode = 500;

    const upstreamUrl = `${this.config.UPSTREAM_BASE_URL.replace(/\/$/, '')}/v1/responses`;
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (isStream) {
      upstreamHeaders['Accept'] = 'text/event-stream';
    }

    const selectedKey = selectKeyForModel(model, this.config.UPSTREAM_KEYS, this.config.UPSTREAM_API_KEY);
    const effectiveApiKey = selectedKey ? selectedKey.apiKey : this.config.UPSTREAM_API_KEY;
    if (!effectiveApiKey) {
      return reply.code(400).send({
        error: {
          message: `The requested model '${model}' is not supported by any configured upstream tier, and no fallback API key is configured.`,
          type: 'invalid_request_error',
          code: 'model_not_supported',
          status: 400
        }
      });
    }

    upstreamHeaders['Authorization'] = `Bearer ${effectiveApiKey}`;

    if (req.headers['openai-organization']) {
      upstreamHeaders['openai-organization'] = String(req.headers['openai-organization']);
    }

    if (req.headers['openai-project']) {
      upstreamHeaders['openai-project'] = String(req.headers['openai-project']);
    }

    // Build capped proxy body to prevent upstream burning tokens beyond available quota
    const proxyBody = { ...body };
    if (typeof body.max_tokens === 'number' && typeof body.max_output_tokens !== 'number') {
      proxyBody.max_tokens = upstreamMaxOutput;
    } else {
      proxyBody.max_output_tokens = upstreamMaxOutput;
    }
    if (isStream) {
      const existingOptions = (body.stream_options as Record<string, unknown>) || {};
      proxyBody.stream_options = { ...existingOptions, include_usage: true };
    }

    const abortController = new AbortController();
    const onClose = () => {
      abortController.abort();
    };
    req.raw.on('close', onClose);

    try {
      const upstreamResponse = await undiciRequest(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(proxyBody),
        headersTimeout: this.config.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: this.config.UPSTREAM_TIMEOUT_MS,
        signal: abortController.signal
      });

      const statusCode = upstreamResponse.statusCode;
      finalStatusCode = statusCode;
      const contentType = String(upstreamResponse.headers['content-type'] || '');

      // HTTP Error
      if (statusCode < 200 || statusCode >= 300) {
        let rawErrorBody = '';
        try {
          rawErrorBody = await upstreamResponse.body.text();
        } catch {
          // ignore
        }

        const sanitized = ErrorSanitizerService.sanitize(
          statusCode,
          `Upstream Responses returned HTTP ${statusCode} for model ${model}: ${rawErrorBody}`
        );

        actualTokensUsed = 0;
        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          requestDurationMs: Date.now() - startTime,
          statusCode,
          isStream,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      // JSON error inside streaming request
      if (isStream && contentType.includes('application/json')) {
        const responseText = await upstreamResponse.body.text();
        let responseJson: Record<string, unknown>;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          const sanitized = ErrorSanitizerService.sanitize(502, 'Upstream Responses returned invalid JSON');
          actualTokensUsed = 0;
          return reply.code(sanitized.statusCode).send(sanitized.payload);
        }

        if (responseJson.error) {
          const sanitized = ErrorSanitizerService.sanitize(
            502,
            `Upstream JSON error in responses stream: ${JSON.stringify(responseJson.error)}`
          );
          actualTokensUsed = 0;
          finalStatusCode = 502;
          await this.usageService.recordApiUsage({
            userId: user.id,
            apiKeyId: user.apiKeyId,
            model,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            requestDurationMs: Date.now() - startTime,
            statusCode: 502,
            isStream: true,
            skipQuotaDeduct: true,
            upstreamGroup: selectedKey?.group,
            upstreamKeyName: selectedKey?.name
          });
          return reply.code(sanitized.statusCode).send(sanitized.payload);
        }

        return reply.code(200).send(responseJson);
      }

      // Streaming SSE
      if (isStream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.raw.writeHead(200);

        const parser = new SseStreamParser();
        let streamAborted = false;
        let quotaCutoff = false;

        try {
          for await (const chunk of upstreamResponse.body) {
            const { forwardChunk } = parser.feed(chunk);
            if (forwardChunk) {
              reply.raw.write(forwardChunk);
            }

            // Quota protection: monitor streaming tokens and abort upstream if user reaches limit
            const currentTotalTokens = inputTokensEst + parser.estimatedCompletionTokens;
            if (currentTotalTokens >= maxAllowedTokens) {
              quotaCutoff = true;
              abortController.abort();
              break;
            }
          }

          const remaining = parser.flushRemaining();
          if (remaining) {
            reply.raw.write(remaining);
          }
        } catch (streamError) {
          streamAborted = true;
          if (!quotaCutoff) {
            console.error('[ProxyService] Responses stream interrupted:', streamError);
            const sanitizedEvent = ErrorSanitizerService.streamingErrorEvent();
            reply.raw.write(sanitizedEvent);
          }
        } finally {
          reply.raw.end();
        }

        if (parser.hasError || streamAborted || quotaCutoff) {
          const partialCompletionTokens = Math.min(
            parser.estimatedCompletionTokens,
            Math.max(0, maxAllowedTokens - inputTokensEst)
          );
          const partialTokens = Math.min(inputTokensEst + partialCompletionTokens, maxAllowedTokens);
          actualTokensUsed = partialTokens;
          finalStatusCode = quotaCutoff ? 200 : 502;

          await this.usageService.recordApiUsage({
            userId: user.id,
            apiKeyId: user.apiKeyId,
            model,
            promptTokens: inputTokensEst,
            completionTokens: partialCompletionTokens,
            cachedTokens: 0,
            totalTokens: partialTokens,
            requestDurationMs: Date.now() - startTime,
            statusCode: finalStatusCode,
            isStream: true,
            skipQuotaDeduct: true,
            upstreamGroup: selectedKey?.group,
            upstreamKeyName: selectedKey?.name
          });
          return;
        }

        const usage = parser.lastUsage;
        const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? inputTokensEst;
        const rawCompletion = usage?.output_tokens ?? usage?.completion_tokens ?? parser.estimatedCompletionTokens;
        const completionTokens = Math.min(rawCompletion, Math.max(0, maxAllowedTokens - promptTokens));
        const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const totalTokens = Math.min(usage?.total_tokens ?? (promptTokens + completionTokens), maxAllowedTokens);

        actualTokensUsed = totalTokens;
        cachedTokensUsed = cachedTokens;
        finalStatusCode = 200;

        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens,
          completionTokens,
          cachedTokens,
          totalTokens,
          requestDurationMs: Date.now() - startTime,
          statusCode: 200,
          isStream: true,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return;
      }

      // Non-streaming JSON
      const responseText = await upstreamResponse.body.text();
      let responseJson: Record<string, unknown>;

      try {
        responseJson = JSON.parse(responseText);
      } catch {
        const sanitized = ErrorSanitizerService.sanitize(502, 'Upstream Responses returned invalid JSON');
        actualTokensUsed = 0;
        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      if (responseJson.error) {
        const sanitized = ErrorSanitizerService.sanitize(
          502,
          `Upstream Responses returned error: ${JSON.stringify(responseJson.error)}`
        );
        actualTokensUsed = 0;
        finalStatusCode = 502;

        await this.usageService.recordApiUsage({
          userId: user.id,
          apiKeyId: user.apiKeyId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          requestDurationMs: Date.now() - startTime,
          statusCode: 502,
          isStream: false,
          skipQuotaDeduct: true,
          upstreamGroup: selectedKey?.group,
          upstreamKeyName: selectedKey?.name
        });

        return reply.code(sanitized.statusCode).send(sanitized.payload);
      }

      const usage = (responseJson.usage || {}) as {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };

      const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? inputTokensEst;
      const rawCompletion = usage.output_tokens ?? usage.completion_tokens ?? 50;
      const completionTokens = rawCompletion;
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

      actualTokensUsed = totalTokens;
      cachedTokensUsed = cachedTokens;
      finalStatusCode = 200;

      await this.usageService.recordApiUsage({
        userId: user.id,
        apiKeyId: user.apiKeyId,
        model,
        promptTokens,
        completionTokens,
        cachedTokens,
        totalTokens,
        requestDurationMs: Date.now() - startTime,
        statusCode: 200,
        isStream: false,
        skipQuotaDeduct: true,
        upstreamGroup: selectedKey?.group,
        upstreamKeyName: selectedKey?.name
      });

      return reply.code(200).send(responseJson);
    } catch (networkOrTimeoutError) {
      const sanitized = ErrorSanitizerService.sanitize(
        networkOrTimeoutError,
        `Network or timeout calling upstream: ${upstreamUrl}`
      );
      actualTokensUsed = 0;
      finalStatusCode = sanitized.statusCode;

      await this.usageService.recordApiUsage({
        userId: user.id,
        apiKeyId: user.apiKeyId,
        model,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        requestDurationMs: Date.now() - startTime,
        statusCode: sanitized.statusCode,
        isStream,
        skipQuotaDeduct: true,
        upstreamGroup: selectedKey?.group,
        upstreamKeyName: selectedKey?.name
      });

      return reply.code(sanitized.statusCode).send(sanitized.payload);
    } finally {
      req.raw.off('close', onClose);
      await this.quotaService.reconcileQuota(
        user.id,
        reservation.reservationId,
        actualTokensUsed,
        cachedTokensUsed,
        finalStatusCode
      );
    }
  }

  /**
   * Proxies simple GET endpoints like /v1/models.
   */
  public async handleGetModels(reply: FastifyReply) {
    const upstreamUrl = `${this.config.UPSTREAM_BASE_URL.replace(/\/$/, '')}/v1/models`;
    const upstreamHeaders: Record<string, string> = {};

    const firstKey = this.config.UPSTREAM_KEYS?.[0];
    const effectiveApiKey = this.config.UPSTREAM_API_KEY || (firstKey ? firstKey.apiKey : '');
    if (effectiveApiKey) {
      upstreamHeaders['Authorization'] = `Bearer ${effectiveApiKey}`;
    }

    try {
      const res = await undiciRequest(upstreamUrl, {
        method: 'GET',
        headers: upstreamHeaders,
        headersTimeout: 15000
      });

      if (res.statusCode !== 200) {
        return reply.code(200).send({
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1715368132, owned_by: 'system' },
            { id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system' },
            { id: 'claude-3-5-sonnet-20241022', object: 'model', created: 1729600000, owned_by: 'system' },
            { id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'system' },
            { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' }
          ]
        });
      }

      const body = await res.body.json();
      return reply.code(200).send(body);
    } catch {
      return reply.code(200).send({
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model', created: 1715368132, owned_by: 'system' },
          { id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system' },
          { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' }
        ]
      });
    }
  }
}
