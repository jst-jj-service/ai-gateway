import { SanitizedGatewayError } from '../types';

export class ErrorSanitizerService {
  /**
   * Sanitizes any error (HTTP status, upstream error, network failure, or timeout)
   * into a standardized, safe OpenAI-compatible error response with actionable advice.
   *
   * Crucially:
   * 1. NEVER includes upstream headers, API keys, internal hosts, or raw response bodies.
   * 2. NEVER reflects the user's input prompt or payload.
   * 3. Always provides a clear explanation and what action the user should take.
   */
  public static sanitize(statusOrError: number | Error | unknown, internalContext?: string): {
    statusCode: number;
    payload: SanitizedGatewayError;
  } {
    // Log internal context for server-side debugging only
    if (internalContext || statusOrError instanceof Error) {
      const debugInfo = statusOrError instanceof Error ? statusOrError.message : String(statusOrError);
      // Mask any potential API keys in internal log
      const safeLog = debugInfo.replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-***');
      console.error(`[Gateway Intercept] ${internalContext || 'Upstream Error'}:`, safeLog);
    }

    // If it's a network or timeout error
    if (statusOrError instanceof Error) {
      const msg = statusOrError.message.toLowerCase();

      if (msg.includes('abort') || msg.includes('timeout') || msg.includes('etimedout')) {
        return {
          statusCode: 504,
          payload: {
            error: {
              message: 'The AI service request timed out.',
              type: 'gateway_timeout_error',
              code: 'request_timeout',
              status: 504,
              suggestion: 'Please try using a shorter prompt, lowering max_tokens, or retrying in a moment.'
            }
          }
        };
      }

      if (msg.includes('econnrefused') || msg.includes('ehostunreach') || msg.includes('enotfound') || msg.includes('fetch failed')) {
        return {
          statusCode: 502,
          payload: {
            error: {
              message: 'Unable to reach the upstream AI gateway.',
              type: 'upstream_connection_error',
              code: 'gateway_upstream_unreachable',
              status: 502,
              suggestion: 'The upstream provider may be experiencing network issues. Please retry shortly.'
            }
          }
        };
      }
    }

    const statusCode = typeof statusOrError === 'number' ? statusOrError : 500;

    switch (statusCode) {
      case 400:
        return {
          statusCode: 400,
          payload: {
            error: {
              message: 'The request parameters were rejected by the AI service.',
              type: 'invalid_request_error',
              code: 'bad_request',
              status: 400,
              suggestion: 'Please verify that your request adheres to the OpenAI API specification.'
            }
          }
        };

      case 401:
      case 403:
        return {
          statusCode: 502, // Hide upstream auth failure from client, present as upstream gateway config error
          payload: {
            error: {
              message: 'Upstream gateway authorization error.',
              type: 'gateway_configuration_error',
              code: 'upstream_auth_failure',
              status: 502,
              suggestion: 'This is a server configuration issue. Please contact the gateway administrator.'
            }
          }
        };

      case 404:
        return {
          statusCode: 404,
          payload: {
            error: {
              message: 'The requested model or endpoint is not available.',
              type: 'invalid_request_error',
              code: 'model_not_found',
              status: 404,
              suggestion: 'Check the model parameter in your request to ensure it is supported by the gateway.'
            }
          }
        };

      case 429:
        return {
          statusCode: 429,
          payload: {
            error: {
              message: 'Upstream rate limit or concurrency capacity reached.',
              type: 'rate_limit_error',
              code: 'upstream_rate_limited',
              status: 429,
              suggestion: 'Upstream capacity is momentarily constrained. Please wait a few seconds before retrying.'
            }
          }
        };

      case 500:
      case 502:
      case 503:
        return {
          statusCode: 502,
          payload: {
            error: {
              message: 'The upstream AI service encountered a temporary internal error.',
              type: 'upstream_service_error',
              code: 'upstream_service_unavailable',
              status: 502,
              suggestion: 'The AI model server is temporarily unavailable. Please retry your request in a few moments.'
            }
          }
        };

      case 504:
        return {
          statusCode: 504,
          payload: {
            error: {
              message: 'The upstream AI service took too long to respond.',
              type: 'gateway_timeout_error',
              code: 'upstream_timeout',
              status: 504,
              suggestion: 'The request timed out. Please try again or shorten your request.'
            }
          }
        };

      default:
        return {
          statusCode: 500,
          payload: {
            error: {
              message: 'An error occurred while processing your AI request.',
              type: 'gateway_error',
              code: 'internal_gateway_error',
              status: 500,
              suggestion: 'Please try again. If the problem persists, please contact customer support.'
            }
          }
        };
    }
  }

  /**
   * Generates a safe response when user's token quota has been exhausted.
   */
  public static quotaExhaustedError(shopUrl: string): {
    statusCode: number;
    payload: SanitizedGatewayError;
  } {
    return {
      statusCode: 402,
      payload: {
        error: {
          message: 'Your token quota has been fully exhausted.',
          type: 'quota_exhausted_error',
          code: 'insufficient_quota',
          status: 402,
          suggestion: `Please visit our shop (${shopUrl}) to purchase a CDK activation key, then redeem it in your dashboard.`
        }
      }
    };
  }

  /**
   * Generates a safe response when user's request exceeds rate limit.
   */
  public static rateLimitError(retryAfterSec: number): {
    statusCode: number;
    payload: SanitizedGatewayError;
  } {
    return {
      statusCode: 429,
      payload: {
        error: {
          message: 'Too many requests. You have exceeded your rate limit.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          status: 429,
          suggestion: `Please slow down your requests. Retry after ${retryAfterSec} seconds.`
        }
      }
    };
  }

  /**
   * Masks any sensitive tokens, internal URLs, IP addresses, database traces,
   * file paths, or prompt contents from text to guarantee zero leaks.
   */
  public static scrubSensitiveText(text: string): string {
    if (!text) return '';
    return text
      // API Keys and Bearer auth tokens
      .replace(/sk-[a-zA-Z0-9_\-\.]{6,}/g, 'sk-***')
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{6,}/gi, 'Bearer ***')
      .replace(/key-[a-zA-Z0-9_\-\.]{6,}/gi, 'key-***')
      // JWT Session tokens
      .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[jwt_redacted]')
      // Unredeemed CDK activation codes
      .replace(/CDK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/gi, 'CDK-****-****-****')
      // Database connection URIs
      .replace(/(postgres(?:ql)?|mysql|redis|mongodb|sqlite|file):\/\/[^\s"'<>]+/gi, '[database_uri_redacted]')
      // Full URLs (including http, https)
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted_gateway_url]')
      // Known gateway and provider domain names
      .replace(/(?:api\.)?hzapi\.vip/gi, '[upstream_gateway]')
      .replace(/(?:api\.)?openai\.com/gi, '[upstream_provider]')
      // Localhost and loopback
      .replace(/localhost(?::\d+)?/gi, '[localhost]')
      // IPv4 addresses with optional ports
      .replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d+)?\b/g, '[redacted_ip]')
      // Windows and POSIX file system paths (supports both backslash and forward slash)
      .replace(/(?:[a-zA-Z]:[\\\/]|\/|[\\\/])(?:Users|home|var|etc|tmp|app|dist|src|node_modules|packages|data)[^\s"'<>)]+/gi, '[path_redacted]')
      // SQL queries and Prisma error messages
      .replace(/(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE)\s+[^\n;]+/gi, '[query_redacted]')
      .replace(/Invalid\s+`prisma\.[^`]+`\s+invocation/gi, '[database_error_redacted]')
      // Prompt contents leaking in error messages
      .replace(/"messages"\s*:\s*\[[\s\S]*?\]/gi, '"messages": [redacted]')
      .replace(/"(?:prompt|input)"\s*:\s*"(?:[^"\\]|\\.)*"/gi, '"input": "[redacted]"');
  }

  /**
   * Generates a sanitized SSE data event payload for streaming interruptions.
   */
  public static streamingErrorEvent(suggestion?: string): string {
    const errorPayload = {
      error: {
        message: 'An error occurred during AI response generation. The stream was interrupted.',
        type: 'upstream_stream_error',
        code: 'stream_failed',
        status: 502,
        suggestion: suggestion || 'The upstream AI model server encountered an error. Please retry your request shortly or reduce prompt length.'
      }
    };
    return `data: ${JSON.stringify(errorPayload)}\n\n`;
  }

  /**
   * Sanitizes an upstream error text with HTTP status code.
   */
  public static sanitizeError(errText: string, statusCode: number) {
    return this.sanitize(statusCode, errText);
  }
}
