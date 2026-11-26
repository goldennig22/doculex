/**
 * An error whose message is meant for the client. The error handler keeps the message for any status below 500
 * (src/utils/error-handler.ts reads `statusCode`), so services can refuse a request without knowing about Fastify.
 */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
