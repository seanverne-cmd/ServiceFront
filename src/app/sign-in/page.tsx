import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Sign-in page. A plain HTML form posting to /api/auth/sign-in — no client JavaScript, so the
 * credential flow works even with scripts disabled, and the only thing that can prove a sign-in
 * is the server-side session cookie.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string; next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/dashboard");
  const params = await searchParams;

  const errorMessage =
    params.error === "invalid"
      ? "Email or password is incorrect."
      : params.error === "unavailable"
        ? "Sign-in is temporarily unavailable. Please try again."
        : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
        ← ServiceFront
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-slate-900">Sign in to your dashboard</h1>
      <p className="mt-2 text-sm text-slate-600">
        The receptionist answers visitors 24/7. This is where you review what it heard and keep your
        business details accurate.
      </p>

      {params.status === "signed_out" && (
        <p className="mt-6 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700" role="status">
          You have been signed out.
        </p>
      )}

      <form method="post" action="/api/auth/sign-in" className="mt-8 space-y-4">
        {errorMessage && (
          <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700" role="alert" data-testid="signin-error">
            {errorMessage}
          </p>
        )}
        <label className="block text-sm font-medium text-slate-700">
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in
        </button>
      </form>

      <p className="mt-8 rounded-md border border-dashed border-slate-300 px-4 py-3 text-xs leading-relaxed text-slate-500">
        <strong className="text-slate-700">Demonstration accounts.</strong> Everything in this demo is
        synthetic and fictional. Credentials are listed in <code>README.md</code> and{" "}
        <code>docs/RUNBOOK.md</code>.
      </p>
    </main>
  );
}
