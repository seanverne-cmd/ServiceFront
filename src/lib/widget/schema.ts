import { z } from "zod";

/**
 * Boundary validation for the public widget endpoint.
 *
 * Rules, in order of importance:
 *   - the body may contain ONLY `conversationId` and `text` (strict object): a client cannot
 *     smuggle a business_id, a role, a mode or a system prompt through extra fields;
 *   - `text` is capped at 1000 characters and control characters are rejected outright, so
 *     nothing that looks like a protocol frame, a log-injection payload or a null byte reaches
 *     the engine, the database or a log line;
 *   - `conversationId`, when present, must be a UUID.
 */

export const MAX_MESSAGE_CHARS = 1000;

// Allow tab (\u0009) and newline (\u000A); reject every other C0 control plus DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const widgetMessageBodySchema = z
  .object({
    conversationId: z.string().uuid("conversationId must be a UUID").optional(),
    text: z
      .string({ required_error: "text must be a string" })
      .min(1, "text must not be empty")
      .max(MAX_MESSAGE_CHARS, `text must be at most ${MAX_MESSAGE_CHARS} characters`)
      .refine((v) => !CONTROL_CHARS.test(v), "text must not contain control characters")
      .refine((v) => v.trim().length > 0, "text must not be blank"),
  })
  .strict();

export type WidgetMessageBody = z.infer<typeof widgetMessageBodySchema>;

export const widgetIdSchema = z
  .string()
  .trim()
  .regex(/^sfw_[a-z0-9]{16,40}$/, "unknown widget id");

/** Safe, uniform error body. It never names a table, a rule, another tenant or an internal code. */
export function widgetError(code: WidgetErrorCode, message: string) {
  return { error: { code, message } };
}

export type WidgetErrorCode =
  | "invalid_request"
  | "unknown_widget"
  | "unknown_conversation"
  | "origin_not_allowed"
  | "rate_limited"
  | "temporarily_unavailable";
