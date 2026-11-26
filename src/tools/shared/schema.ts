import { z } from "zod";

export const compactTrue = z.boolean().default(true);
export const maxCharsOptional = z.number().int().min(1000).max(200_000).optional();
export const outputChars = z.number().int().min(0).max(100_000).default(12_000);
export const offsetOptional = z.number().int().min(0).default(0);
