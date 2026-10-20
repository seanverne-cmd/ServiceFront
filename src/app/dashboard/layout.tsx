import Link from "next/link";
import { requireSession } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

/**
 * Authenticated dashboard shell.
 *
 * requireSession() runs on the server for every page under /dashboard: with no valid session the
 * visitor is redirected to /sign-in before any tenant query happens. The active business shown in
 * the header comes from the session, never from the URL.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-base font-semibold text-slate-900">
              ServiceFront
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link href="/dashboard" className="hover:text-slate-900">
                Overview
              </Link>
              <Link href="/dashboard/profile" className="hover:text-slate-900">
                Business profile
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right text-xs leading-tight text-slate-500">
              <div className="font-medium text-slate-700" data-testid="session-user">
                {session.user.display_name ?? session.user.email}
              </div>
              <div>
                {session.activeBusiness
                  ? `${session.activeBusiness.name} · ${session.activeBusiness.role === "business_owner" ? "Owner" : "Staff"}`
                  : "No business"}
              </div>
            </div>

            {session.businesses.length > 1 && (
              <form method="post" action="/api/auth/switch-business" className="flex items-center gap-2">
                <select
                  name="business_id"
                  defaultValue={session.activeBusinessId ?? undefined}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800"
                  aria-label="Active business"
                >
                  {session.businesses.map((b) => (
                    <option key={b.business_id} value={b.business_id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  Switch
                </button>
              </form>
            )}

            <form method="post" action="/api/auth/sign-out">
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
