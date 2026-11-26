import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import z from "zod";

/**
 * Last stop for every thrown error.
 * 4xx: the message is meant for the client (invalid JSON, file too large, rate limit), so it is kept.
 * 5xx: the message may hold SQL, query params or provider details, so the client only gets the request id;
 * the full error (with a Drizzle error's `cause`: the Postgres code, detail, constraint) goes to the log.
 */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
    // A request that failed its route schema (src/utils/zod-fastify.ts): Fastify tags the ZodError with this code.
    // Both checks matter: a ZodError thrown anywhere else (a service parsing data) is our bug and must stay a 500.
    if (error.code === 'FST_ERR_VALIDATION' && error instanceof z.ZodError) {
        request.log.info({ err: error }, 'validation failed');
        return reply.code(422).send({
            status: 'failed',
            message: 'Validation failed', // not error.message: for a ZodError that is a JSON dump of every issue
            errors: z.flattenError(error).fieldErrors,
            requestId: request.id,
        });
    }

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
