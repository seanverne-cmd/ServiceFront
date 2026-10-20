import Link from "next/link";
import { requireBusinessAccess, tryBusinessAccess } from "@/lib/auth/authorize";
import {
  getBusinessProfileDetail,
  listBusinessHours,
  listFaqs,
  listServiceAreas,
  listServices,
} from "@/lib/db";

export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtTime(t: string | null): string {
  if (!t) return "";
  const [hRaw, m] = t.split(":");
  const h = Number(hRaw);
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m}${suffix}`;
}

/**
 * Dashboard overview: everything on this page is the ACTIVE business from the session, read
 * through the tenant context. No id in the URL can point it at another business.
 */
export default async function DashboardPage({
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
  const { context, role } = access.authorized;
  const params = await searchParams;

  const [profile, services, areas, faqs, hours] = await Promise.all([
    getBusinessProfileDetail(context),
    listServices(context),
    listServiceAreas(context),
    listFaqs(context),
    listBusinessHours(context),
  ]);

  if (!profile) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        No business profile is visible for this session.
      </p>
    );
  }

  return (
    <div className="space-y-8" data-business-slug={profile.slug}>
      {params.status === "no_business" && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This account is not a member of any business yet.
        </p>
      )}

      <section>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="business-name">
              {profile.name}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {profile.industry} · {profile.city ?? "—"}
              {profile.region ? `, ${profile.region}` : ""} · {profile.timezone}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700">
              {role === "business_owner" ? "Owner — can edit" : "Staff — read only"}
            </span>
            {profile.is_synthetic && (
              <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-800">
                Synthetic demo tenant
              </span>
            )}
          </div>
        </div>

        <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Phone", profile.primary_phone],
            ["Email", profile.primary_email],
            ["Website", profile.website_url],
            ["Hours", profile.hours_summary],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="mt-1 text-sm text-slate-900">{value ?? "Not set"}</dd>
            </div>
          ))}
        </dl>

        {profile.public_welcome_message && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Public welcome message</div>
            <p className="mt-1 text-sm text-slate-800">{profile.public_welcome_message}</p>
          </div>
        )}

        <div className="mt-4 flex gap-3 text-sm">
          <Link
            href="/dashboard/profile"
            className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-800"
          >
            {role === "business_owner" ? "Edit business profile" : "View business profile"}
          </Link>
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Services ({services.length})
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-800">
            {services.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-3">
                <span>
                  {s.name}
                  {s.is_emergency && (
                    <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
                      emergency
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-500">{s.category ?? ""}</span>
              </li>
            ))}
            {services.length === 0 && <li className="text-slate-500">None yet.</li>}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Service areas ({areas.length})
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {areas.map((a) => (
              <li
                key={a.id}
                className={
                  a.is_primary
                    ? "rounded-full bg-slate-900 px-3 py-1 text-xs text-white"
                    : "rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                }
              >
                {a.name}
              </li>
            ))}
            {areas.length === 0 && <li className="text-slate-500">None yet.</li>}
          </ul>

          <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Business hours
          </h2>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {hours.map((h) => (
                <tr key={h.day_of_week} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 text-slate-600">{DAYS[h.day_of_week]}</td>
                  <td className="py-1.5 text-right text-slate-900">
                    {h.is_closed ? "Closed" : `${fmtTime(h.opens_at)}–${fmtTime(h.closes_at)}`}
                    {h.appointment_only && !h.is_closed ? " (appointment only)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Approved answers the receptionist may use ({faqs.length})
        </h2>
        <dl className="mt-3 space-y-4 text-sm">
          {faqs.map((f) => (
            <div key={f.id}>
              <dt className="font-medium text-slate-900">{f.question}</dt>
              <dd className="mt-1 text-slate-700">{f.answer}</dd>
            </div>
          ))}
          {faqs.length === 0 && <p className="text-slate-500">None yet.</p>}
        </dl>
      </section>
    </div>
  );
}
