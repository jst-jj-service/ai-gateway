import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { AuthenticatedUser } from '../types';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthenticatedUser;
  }
}

export class AuthPlugin {
  constructor(private authService: AuthService) {}

  /**
   * Universal auth hook: validates either an API Key (`sk-gw-...`) or a JWT Bearer token.
   */
  public authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      reply.code(401).send({
        error: {
          message: 'Missing Authorization header. Please provide an API key (Bearer sk-gw-...) or JWT token.',
          type: 'authentication_error',
          code: 'unauthorized',
          status: 401
        }
      });
      return false;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      reply.code(401).send({
        error: {
          message: 'Invalid Authorization header format. Expected "Bearer <token>".',
          type: 'authentication_error',
          code: 'invalid_token_format',
          status: 401
        }
      });
      return false;
    }

    const token = parts[1].trim();

    // Check if it's an API Key (sk-gw-...)
    if (token.startsWith('sk-gw-')) {
      const user = await this.authService.authenticateApiKey(token);
      if (!user) {
        reply.code(401).send({
          error: {
            message: 'Invalid or revoked API key.',
            type: 'authentication_error',
            code: 'invalid_api_key',
            status: 401
          }
        });
        return false;
      }
      req.user = user;
      return true;
    }

    // Otherwise, verify JWT token
    try {
      const decoded = await req.jwtVerify<{ id: string; email: string; role: 'USER' | 'ADMIN' }>();
      const user = await this.authService.validateSessionUser(decoded.id);
      if (!user || !user.isActive) {
        reply.code(401).send({
          error: {
            message: 'User account is inactive or no longer exists.',
            type: 'authentication_error',
            code: 'unauthorized',
            status: 401
          }
        });
        return false;
      }

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role
      };
      return true;
    } catch {
      reply.code(401).send({
        error: {
          message: 'Invalid or expired session token. Please log in again.',
          type: 'authentication_error',
          code: 'invalid_jwt',
          status: 401
        }
      });
      return false;
    }
  };

  /**
   * Admin-only gate hook.
   * Strictly verifies server-side ADMIN role and ensures standard proxy API keys
   * cannot be used to perform sensitive administrative operations.
   */
  public requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const isAuth = await this.authenticate(req, reply);
    if (!isAuth) return false;

    if (req.user?.apiKeyId) {
      reply.code(403).send({
        error: {
          message: 'API keys cannot be used for administrative operations. Please log in with admin credentials.',
          type: 'permission_denied_error',
          code: 'forbidden',
          status: 403
        }
      });
      return false;
    }

    if (req.user?.role !== 'ADMIN') {
      reply.code(403).send({
        error: {
          message: 'Access denied. Administrator privileges required.',
          type: 'permission_denied_error',
          code: 'forbidden',
          status: 403
        }
      });
      return false;
    }

    return true;
  };
}
