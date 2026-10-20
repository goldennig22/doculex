import { FastifyReply, FastifyRequest } from "fastify";
import { HealthChecks } from "../routes/health";

export const checkHealth =  async (_req: FastifyRequest, reply: FastifyReply, checks: HealthChecks) => {
    const [database, llm] = await Promise.all([checks.database(), checks.llm()]);
    const status = database.status === 'down' ? 'down' : llm.status === 'down' ? 'degraded' : 'ok';
    return reply
    .code(status === 'down' ? 503 : 200)
    .send({ status, checks: { database, llm }, uptimeS: Math.round(process.uptime()) });
} 