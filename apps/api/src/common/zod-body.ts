import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export function parseBody<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
  }
  return parsed.data;
}
