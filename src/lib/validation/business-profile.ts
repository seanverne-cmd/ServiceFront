import { z } from "zod";

/**
 * Boundary validation for the business profile form. Every field is parsed here before it
 * reaches the data layer, so neither the database nor RLS ever sees an out-of-range value.
 * Empty strings are normalised to NULL so a cleared field is stored as absent, not as "".
 */

export const INDUSTRIES = ["plumbing", "veterinary", "hvac", "electrical", "roofing", "other"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), "Enter a full URL starting with https://")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address")
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const optionalPhone = z
  .string()
  .trim()
  .max(32)
  .refine((v) => v === "" || /^[0-9+()\-.\s]{7,32}$/.test(v), "Enter a valid phone number")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

export const businessProfileSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(200, "Name is too long"),
  industry: z.enum(INDUSTRIES),
  website_url: optionalUrl,
  primary_email: optionalEmail,
  primary_phone: optionalPhone,
  city: optionalText(120),
  region: optionalText(120),
  public_welcome_message: optionalText(600),
  hours_summary: optionalText(400),
});

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

export const signInSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
});

/** Flatten zod issues into { field: message } for re-rendering the form. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
