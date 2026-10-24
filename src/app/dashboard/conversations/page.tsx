import Link from "next/link";
import { tryBusinessAccess } from "@/lib/auth/authorize";
import { listConversations } from "@/lib/db/widget";

export const dynamic = "force-dynamic";

/**
 * /dashboard/conversations — what the receptionist actually told visitors.
 *
 * Read-only, and scoped the same way every other dashboard read is: the tenant context comes
 * from the SESSION (never from the URL), and the query runs inside withTenant(), so the RLS
 * policies on conversations/messages decide what is visible. There is no second isolation
 * mechanism to keep in sync.
 */

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default async function ConversationsPage() {
  const access = await tryBusinessAccess();
  if (!access.ok) {
    return (
      <p
        className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        data-testid="access-refused"
      >
        Not permitted — {access.message} No conversation data is shown.
      </p>
    );
  }

  const { context } = access.authorized;
  const conversations = await listConversations(context);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900" data-testid="conversations-title">
          Conversations
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Every exchange the website assistant has had for this business. Read-only. Answers composed in
          demonstration mode are labelled as such — they are deterministic replies built from your approved
          facts, not a live AI model.
        </p>
      </div>

      {conversations.length === 0 ? (
        <p
          className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600"
          data-testid="conversations-empty"
        >
          No conversations yet. Once a visitor uses the chat widget, the full transcript appears here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm" data-testid="conversations-table">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-medium">Visitor</th>
                <th className="px-4 py-3 font-medium">Messages</th>
                <th className="px-4 py-3 font-medium">First / last</th>
                <th className="px-4 py-3 font-medium">Intent / outcome</th>
                <th className="px-4 py-3 font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/conversations/${c.id}`}
                      className="font-mono text-xs text-slate-900 underline decoration-slate-300 hover:decoration-slate-900"
                      data-testid="conversation-link"
                    >
                      {c.visitorId ? `${c.visitorId.slice(0, 14)}…` : "anonymous visitor"}
                    </Link>
                    <div className="mt-1 max-w-xs truncate text-xs text-slate-500">{c.preview || "—"}</div>
                    {c.isSynthetic && (
                      <span className="mt-1 inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
                        synthetic demo data
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-800" data-testid="conversation-message-count">
                    {c.messageCount}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div>first {fmtDateTime(c.startedAt)}</div>
                    <div>last {fmtDateTime(c.lastMessageAt)}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-800">
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      {c.intent ?? "no intent recorded"}
                    </div>
                    <div data-testid="conversation-outcome">{c.outcome}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600" data-testid="conversation-mode">
                    {c.modeLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
