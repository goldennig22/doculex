import z from "zod";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
export const uploadDocumentSchema = z.object({
    file: z.instanceof(Buffer, { message: 'file is required' }).refine(isPdf, 'file must be a PDF'),
    title: z.string().trim().min(3).max(200),
    language: z.enum(['fr', 'en']),
    sourceUrl: z.url().optional(),
})