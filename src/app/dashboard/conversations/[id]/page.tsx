import Link from "next/link";
import { notFound } from "next/navigation";
import { tryBusinessAccess } from "@/lib/auth/authorize";
import { getConversation } from "@/lib/db/widget";

export const dynamic = "force-dynamic";

/**
 * /dashboard/conversations/[id] — the full transcript of one conversation.
 *
 * The id in the URL is a CONVERSATION id, not a business id: getConversation() runs inside
 * withTenant() for the session's active business, so a conversation belonging to another tenant
 * simply is not there and the page answers 404. Nothing about the other tenant is revealed —
 * not its existence, not its size, not its first message.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** "service_area:<uuid>" -> a readable, still traceable source label. */
function describeFactRef(ref: string): string {
  const [type, ...rest] = ref.split(":");
  const label = rest.join(":");
  const kind =
    type === "service_area"
      ? "service area record"
      : type === "service"
        ? "service record"
        : type === "business_hours"
          ? "business hours record"
          : type === "business_profile"
            ? "business profile record"
            : type === "faq"
              ? "approved FAQ"
              : type === "service_area_list"
                ? "service area list"
                : type;
  return `${kind} (${label})`;
}

export default async function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const conversation = await getConversation(access.authorized.context, id);
  if (!conversation) notFound();

  const answerCount = conversation.messages.filter((m) => m.role === "assistant").length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/conversations" className="text-xs text-slate-600 underline hover:text-slate-900">
          ← All conversations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900" data-testid="conversation-title">
          Conversation transcript
        </h1>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Visitor", conversation.visitorId ? `${conversation.visitorId.slice(0, 20)}…` : "anonymous"],
            ["Started", fmtDateTime(conversation.startedAt)],
            ["Last message", fmtDateTime(conversation.lastMessageAt)],
            ["Messages", `${conversation.messages.length} (${answerCount} from the assistant)`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
              <dt className="uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="mt-1 font-mono text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
        {conversation.isSynthetic && (
          <p className="mt-3 inline-block rounded bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-700">
            Synthetic demo conversation — not a real customer
          </p>
        )}
      </div>

      <ol className="space-y-4" data-testid="transcript">
        {conversation.messages.map((m) => {
          const isVisitor = m.role === "visitor";
          return (
            <li
              key={m.id}
              className={
                isVisitor
                  ? "rounded-lg border border-slate-200 bg-white p-4"
                  : "rounded-lg border border-slate-300 bg-slate-50 p-4"
              }
              data-testid={isVisitor ? "message-visitor" : "message-assistant"}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  {isVisitor ? "Visitor" : "Assistant"}
                </span>
                <span className="font-mono text-[11px] text-slate-500" data-testid="message-timestamp">
                  {fmtDateTime(m.createdAt)}
                </span>
              </div>

              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{m.content}</p>

              {!isVisitor && (
                <div className="mt-3 space-y-2 border-t border-slate-200 pt-2 text-[11px] text-slate-600">
                  <div data-testid="message-mode">
                    <span className="font-medium">Mode:</span> {m.modeLabel}
                    {m.modelName ? ` (${m.modelName})` : ""}
                  </div>
                  <div>
                    <span className="font-medium">Intent:</span> {m.intent ?? "not recorded"}
                    {m.confidence !== null ? ` · confidence ${m.confidence.toFixed(2)}` : ""}
                  </div>
                  <div data-testid="message-sources">
                    <span className="font-medium">Knowledge sources:</span>{" "}
                    {m.factRefs.length === 0 ? (
                      <span>
                        none cited — {m.answeredFromKnowledge ? "answered from general approved wording" : "no confirmed answer was given"}
                      </span>
                    ) : (
                      <ul className="mt-1 list-disc pl-5">
                        {m.factRefs.map((ref) => (
                          <li key={ref} className="font-mono">
                            {describeFactRef(ref)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {conversation.messages.length === 0 && <li className="text-sm text-slate-600">No messages stored.</li>}
      </ol>
    </div>
  );
}
