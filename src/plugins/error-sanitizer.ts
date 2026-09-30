import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorSanitizerService } from '../services/error-sanitizer.service';

export function setupErrorSanitizer(fastify: any) {
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Log complete error internally for diagnosis
    console.error(`[Unhandled Error] Path: ${request.url} | Method: ${request.method} | Error:`, error.message);

    // Fastify validation errors (Zod / JSON Schema)
    if (error.validation) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request body or parameters.',
          type: 'validation_error',
          code: 'invalid_parameters',
          status: 400,
          details: error.validation.map((v: any) => v.message || 'validation failed'),
          suggestion: 'Please verify the request parameters according to the API docs.'
        }
      });
    }

    // Rate limit errors from Fastify
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: {
          message: 'Too many requests.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          status: 429,
          suggestion: 'Please wait a moment before sending more requests.'
        }
      });
    }

    // Status code fallback
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;

    // Never leak stack trace, internal database query details, upstream keys, or internal URLs
    const rawMessage = statusCode >= 500 ? 'An unexpected gateway error occurred. Please try again later.' : error.message;
    const safeMessage = ErrorSanitizerService.scrubSensitiveText(rawMessage);

    return reply.code(statusCode).send({
      error: {
        message: safeMessage,
        type: 'gateway_error',
        code: error.code || 'internal_error',
        status: statusCode,
        suggestion: 'If the problem persists, please check your request parameters or contact support.'
      }
    });
  });
}
