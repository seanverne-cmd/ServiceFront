import { canConfigure, tryBusinessAccess } from "@/lib/auth/authorize";
import { getBusinessProfileDetail } from "@/lib/db";
import { INDUSTRIES } from "@/lib/validation/business-profile";

export const dynamic = "force-dynamic";

function Field({
  label,
  name,
  defaultValue,
  hint,
  type = "text",
  readOnly,
}: {
  label: string;
  name: string;
  defaultValue: string | null;
  hint?: string;
  type?: string;
  readOnly: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        readOnly={readOnly}
        aria-readonly={readOnly}
        className={
          readOnly
            ? "mt-1 w-full rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-slate-600"
            : "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500"
        }
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

/**
 * Business profile management.
 *
 * Staff see the same values but every control is read-only, and the POST handler refuses them
 * with 403 regardless — the disabled inputs are a courtesy, not the enforcement.
 */
export default async function BusinessProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const access = await tryBusinessAccess();
  if (!access.ok) {
    return (
      <p
        className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        data-testid="access-refused"
      >
        Not permitted — {access.message} No business data is shown.
      </p>
    );
  }
  const authorized = access.authorized;
  const editable = canConfigure(authorized.role);
  const profile = await getBusinessProfileDetail(authorized.context);
  const params = await searchParams;

  if (!profile) {
    return <p className="text-sm text-amber-800">No business profile is visible for this session.</p>;
  }

  const notice =
    params.status === "saved"
      ? { tone: "ok", text: "Business profile saved. The change is recorded in the audit log." }
      : params.status === "invalid"
        ? { tone: "bad", text: "Some fields were not valid. Check the values and try again." }
        : params.status === "error"
          ? { tone: "bad", text: "The profile could not be saved. Please try again." }
          : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Business profile</h1>
        <p className="mt-1 text-sm text-slate-600">
          These are the facts the receptionist is allowed to use. Anything not stated here is not
          invented for a visitor.
        </p>
      </div>

      {notice && (
        <p
          className={
            notice.tone === "ok"
              ? "rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              : "rounded-md bg-red-50 px-4 py-3 text-sm text-red-700"
          }
          role="status"
          data-testid="profile-status"
        >
          {notice.text}
        </p>
      )}

      {!editable && (
        <p className="rounded-md border border-slate-300 bg-slate-100 px-4 py-3 text-sm text-slate-700">
          You are signed in as <strong>staff</strong>. You can read the business profile, but only a
          business owner or admin can change it.
        </p>
      )}

      <form method="post" action="/api/dashboard/profile" className="space-y-5 rounded-lg border border-slate-200 bg-white p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" name="name" defaultValue={profile.name} readOnly={!editable} />
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Industry</span>
            <select
              name="industry"
              defaultValue={profile.industry}
              disabled={!editable}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900"
            >
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
          <Field label="Website" name="website_url" defaultValue={profile.website_url} hint="https://…" readOnly={!editable} />
          <Field label="Contact email" name="primary_email" type="email" defaultValue={profile.primary_email} readOnly={!editable} />
          <Field label="Contact phone" name="primary_phone" defaultValue={profile.primary_phone} readOnly={!editable} />
          <Field label="City" name="city" defaultValue={profile.city} readOnly={!editable} />
          <Field label="State / region" name="region" defaultValue={profile.region} readOnly={!editable} />
        </div>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">Public welcome message</span>
          <textarea
            name="public_welcome_message"
            defaultValue={profile.public_welcome_message ?? ""}
            readOnly={!editable}
            rows={3}
            maxLength={600}
            className={
              editable
                ? "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900"
                : "mt-1 w-full rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-slate-600"
            }
          />
          <span className="mt-1 block text-xs text-slate-500">Shown at the top of the chat widget.</span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">Hours summary</span>
          <input
            name="hours_summary"
            defaultValue={profile.hours_summary ?? ""}
            readOnly={!editable}
            maxLength={400}
            className={
              editable
                ? "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900"
                : "mt-1 w-full rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-slate-600"
            }
          />
          <span className="mt-1 block text-xs text-slate-500">
            A one-line summary used in answers, e.g. “Mon–Fri 7am–6pm, Sat 8am–4pm”.
          </span>
        </label>

        <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
          <button
            type="submit"
            disabled={!editable}
            className={
              editable
                ? "rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                : "cursor-not-allowed rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500"
            }
          >
            Save changes
          </button>
          <span className="text-xs text-slate-500">
            Synthetic demo tenant: {profile.is_synthetic ? "yes" : "no"} · Response mode:{" "}
            {profile.ai_response_mode}
          </span>
        </div>
      </form>
    </div>
  );
}
