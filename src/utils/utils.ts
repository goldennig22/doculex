import { FastifyReply } from "fastify";
import z from "zod";


const boolField = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return (value.toLowerCase() === "true" || value.toLocaleLowerCase() === "1");
  }

  return false;
}, z.boolean());

const nullableStringField = z.preprocess((value) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return null;
  }

  return value;
}, z.string().trim().nullable().optional());

const failedResponse = (reply: FastifyReply, code = 422, message: string, errors?: unknown) => {
  return reply
  .code(code)
  .send({ 
    status: 'failed', 
    message, 
    ...(errors ? { errors } : {})
  });
}

const successResponse = (reply: FastifyReply, code = 200, data: unknown) => {
  return reply
  .code(code)
  .send({ 
    status: 'success', 
    data  
  });
}


export { boolField, nullableStringField, failedResponse, successResponse };