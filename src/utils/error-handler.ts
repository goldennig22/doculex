import { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * Last stop for every thrown error.
 * 4xx: the message is meant for the client (invalid JSON, file too large, rate limit), so it is kept.
 * 5xx: the message may hold SQL, query params or provider details, so the client only gets the request id;
 * the full error (with a Drizzle error's `cause`: the Postgres code, detail, constraint) goes to the log.
 */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
        // `err` is serialized with its stack; `cause` is logged explicitly so it never depends on the serializer
        request.log.error({ err: error, cause: error.cause }, 'request failed');
    } else {
        request.log.info({ err: error }, 'client error');
    }

    return reply.code(status).send({
        status: 'failed',
        message: status < 500 ? error.message : 'Internal server error',
        requestId: request.id,
    });
}
