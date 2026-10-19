import { z } from "zod";

/**
 * Boundary validation. Every value that crosses into the server (HTTP body,
 * query string, route param) or into SQL must be parsed by one of these first.
 */

export const uuidSchema = z.string().uuid("must be a UUID");
export const businessIdSchema = uuidSchema;
export const userIdSchema = uuidSchema;

export const businessSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)?$/, "slug must be lowercase alphanumeric with single hyphens");

/** Deliberately permissive: business contact addresses are free-form in the source systems. */
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** E.164-ish, but allows common local formatting so staff can type what customers give them. */
export const phoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(32)
  .regex(/^\+?[0-9()\-.\s]{7,32}$/, "must look like a phone number");

export const visitorMessageSchema = z.object({
  businessId: businessIdSchema,
  conversationId: uuidSchema.optional(),
  message: z.string().trim().min(1, "message must not be empty").max(2000, "message is too long"),
  visitorId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "visitorId must be an opaque pseudonymous id")
    .optional(),
});

export const leadDraftSchema = z.object({
  businessId: businessIdSchema,
  category: z.enum([
    "service_request",
    "appointment_request",
    "quote_request",
    "emergency",
    "general_enquiry",
    "existing_customer",
    "vendor",
    "spam",
  ]),
  fullName: z.string().trim().min(1).max(120).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  message: z.string().trim().max(2000).optional(),
  consentToContact: z.boolean(),
});
// A lead with no way to reach the visitor is useless data: require at least one channel.
export const leadSubmissionSchema = leadDraftSchema.refine((v) => Boolean(v.email || v.phone), {
  message: "either email or phone is required",
});

export const healthQuerySchema = z.object({
  verbose: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => v === "1"),
});

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Message-level only: never echo the raw input back (it may contain PII).
    const issue = result.error.issues[0];
    throw new ValidationError(`${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** For internal SQL seams: reject anything that is not a UUID before it reaches a query. */
export function assertUuid(value: unknown, field: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${field}: must be a UUID`);
  return parsed.data;
}
