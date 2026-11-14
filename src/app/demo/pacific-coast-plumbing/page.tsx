import type { Metadata } from "next";

/**
 * Phase 2b demo page: a stand-in "plumbing company website" that embeds the real widget.
 *
 * Everything on this page is fictional demonstration content for the synthetic tenant
 * "Pacific Coast Plumbing Services" (seed data, synthetic batch demo-2026-10), and it restates
 * only facts that are in that business's approved seed records so the page and the assistant
 * cannot disagree in front of the owner.
 *
 * It is an ordinary host page: it knows nothing about the tenant except the public widget id,
 * and the widget renders inside its own shadow root, so this page's CSS cannot reach it.
 * The widget id is public by design (it ships in every host page's source). The server resolves
 * the business from it; no business id, role or mode is ever sent by the browser.
 */

const PLUMBING_WIDGET_ID = process.env.DEMO_PLUMBING_WIDGET_ID ?? "sfw_4225c8db9cd54710afed13d3";

export const metadata: Metadata = {
  title: "Pacific Coast Plumbing Services — demo site with chat widget",
  description: "Fictional demonstration plumbing site showing the ServiceFront chat widget.",
};

const SERVICES = [
  { name: "Drain Cleaning", blurb: "Clearing slow or blocked kitchen, bathroom and main-line drains, with camera inspection on request." },
  { name: "Water Heater Repair", blurb: "Diagnosis and repair of tank and tankless water heaters that are not heating or are leaking." },
  { name: "Leak Detection", blurb: "Locating hidden leaks in walls, slabs and yards before repair work begins." },
  { name: "Sewer Line Services", blurb: "Sewer camera inspection, hydro-jetting and spot repairs for blockages and root intrusion." },
  { name: "Emergency Plumbing", blurb: "After-hours response for burst pipes, sewage backups and no-water calls on the 24/7 line." },
];

const AREAS = ["Fullerton", "Anaheim", "Brea", "Buena Park", "Placentia", "La Habra", "Yorba Linda", "Santa Ana"];

export default function PlumbingDemoPage() {
  return (
    <main className="min-h-screen bg-white pb-28">
      <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">
        Fictional demonstration business — every name, number and detail on this page is synthetic
        demo data, not a real plumbing company.
      </div>

      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <p className="text-lg font-bold">Pacific Coast Plumbing Services</p>
            <p className="text-xs text-muted-foreground">Licensed plumbing · Fullerton, California</p>
          </div>
          <a
            href="tel:+17145550142"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Call +1 (714) 555-0142
          </a>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Plumbing problems, answered before you call.
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Ask the assistant in the corner about service areas, hours, what we fix and what a visit
          costs. It answers only from the facts this business has approved — and it says so plainly
          when it does not know something.
        </p>
        <p className="mt-4 max-w-2xl rounded-md border border-border bg-muted px-4 py-3 text-sm">
          Try asking: <span className="font-medium">“Do you service Fullerton?”</span> or{" "}
          <span className="font-medium">“What are your hours on Sunday?”</span>
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-10">
        <h2 className="text-lg font-semibold">Services</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {SERVICES.map((service) => (
            <li key={service.name} className="rounded-lg border border-border p-4">
              <p className="font-medium">{service.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{service.blurb}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-10">
        <h2 className="text-lg font-semibold">Service areas</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {AREAS.map((area) => (
            <li key={area} className="rounded-full border border-border px-3 py-1 text-sm">
              {area}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-10">
        <h2 className="text-lg font-semibold">Hours</h2>
        <dl className="mt-3 max-w-md divide-y divide-border rounded-lg border border-border text-sm">
          <div className="flex justify-between px-4 py-2">
            <dt>Monday – Friday</dt>
            <dd className="text-muted-foreground">7:00 am – 6:00 pm</dd>
          </div>
          <div className="flex justify-between px-4 py-2">
            <dt>Saturday</dt>
            <dd className="text-muted-foreground">8:00 am – 4:00 pm</dd>
          </div>
          <div className="flex justify-between px-4 py-2">
            <dt>Sunday</dt>
            <dd className="text-muted-foreground">Closed — emergency line only</dd>
          </div>
        </dl>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Emergency line: +1 (714) 555-0199, answered 24/7. Suspected gas leak? Leave the property
          and call SoCalGas on 1-800-427-2200 first.
        </p>
      </section>

      {/* The embeddable widget: one script tag, one public id. It mounts its own shadow root. */}
      <script src="/widget.js" data-widget-id={PLUMBING_WIDGET_ID} defer />
    </main>
  );
}
