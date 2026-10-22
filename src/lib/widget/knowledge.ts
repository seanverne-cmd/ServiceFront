/**
 * The approved-fact knowledge base a widget answer may be composed from.
 *
 * Everything in here is read out of the tenant's own rows (services, service_areas, faqs,
 * business_hours and the businesses profile) inside a widget-scoped transaction, so the
 * database's RLS policies decide what exists: one business can never load another's facts.
 *
 * The engine is deliberately NOT a free-form prompt: it routes the visitor's message to a
 * structure and then restates stored values. A fact that is not in this object cannot be
 * said.
 */

export type HoursRow = {
  id: string;
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  isClosed: boolean;
  appointmentOnly: boolean;
  note: string | null;
};

export type ServiceRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isEmergency: boolean;
  priceNote: string | null;
};

export type AreaRow = {
  id: string;
  name: string;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  isPrimary: boolean;
  travelNote: string | null;
};

export type FaqRow = { id: string; question: string; answer: string; category: string | null };

export type BusinessProfile = {
  id: string;
  name: string;
  industry: string;
  timezone: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  websiteUrl: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  emergencyPhone: string | null;
  /** Only a number confirmed with the business may be presented as the emergency contact. */
  emergencyPhoneVerified: boolean;
  emergencyInstructions: string | null;
  aiResponseMode: string;
  safetyPolicy: Record<string, unknown>;
  isSynthetic: boolean;
};

export type KnowledgeBase = {
  business: BusinessProfile;
  hours: HoursRow[];
  services: ServiceRow[];
  areas: AreaRow[];
  faqs: FaqRow[];
};

/** "07:00:00" -> "7:00am". Stored values are the business's own; formatting only. */
export function formatTime(value: string | null): string {
  if (!value) return "";
  const [h, m] = value.split(":");
  const hour = Number(h);
  const suffix = hour < 12 ? "am" : "pm";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${m}${suffix}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayName(day: number): string {
  return DAY_NAMES[day] ?? "";
}

/** A compact human summary of the approved opening hours, built only from stored rows. */
export function describeHours(hours: HoursRow[]): string[] {
  const parts: string[] = [];
  for (let day = 0; day <= 6; day += 1) {
    const rows = hours.filter((h) => h.dayOfWeek === day);
    if (rows.length === 0) {
      parts.push(`${DAY_NAMES[day]}: not listed`);
      continue;
    }
    if (rows.every((r) => r.isClosed)) {
      parts.push(`${DAY_NAMES[day]}: closed`);
      continue;
    }
    const windows = rows
      .filter((r) => !r.isClosed && r.opensAt && r.closesAt)
      .map((r) => `${formatTime(r.opensAt)}–${formatTime(r.closesAt)}${r.appointmentOnly ? " (pre-booked appointments only)" : ""}`);
    parts.push(`${DAY_NAMES[day]}: ${windows.join(", ")}`);
  }
  return parts;
}

/** Minutes since midnight for a stored time, or null. */
function minutesOf(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/** Local day-of-week (0=Sunday) and minutes-since-midnight in the business's timezone. */
export function localClock(now: Date, timezone: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { day: weekdayIndex < 0 ? now.getUTCDay() : weekdayIndex, minutes: hour * 60 + minute };
}

/** True when the business is (per its stored hours) open right now. */
export function isOpenNow(hours: HoursRow[], timezone: string, now: Date): boolean {
  const { day, minutes } = localClock(now, timezone);
  return hours.some((h) => {
    if (h.dayOfWeek !== day || h.isClosed) return false;
    const open = minutesOf(h.opensAt);
    const close = minutesOf(h.closesAt);
    if (open === null || close === null) return false;
    return minutes >= open && minutes < close;
  });
}

export function localTimeLabel(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
}

export function postalLookup(areas: AreaRow[], text: string): AreaRow | null {
  const zip = text.match(/\b9\d{4}\b/)?.[0];
  if (!zip) return null;
  return areas.find((a) => a.postalCode === zip) ?? null;
}
