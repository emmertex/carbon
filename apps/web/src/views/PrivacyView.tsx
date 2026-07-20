import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

/**
 * Privacy policy page (served at /privacy on the apex host, linked from the
 * landing page footer and used as the Play Store privacy-policy URL). Mirrors
 * docs/privacy-policy.md — keep the two in sync when either changes.
 */
export function PrivacyView() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <button
        onClick={() => navigate("/")}
        className="mb-8 inline-flex items-center gap-2 text-sm text-text-muted hover:text-text"
      >
        <ArrowLeft size={16} /> Back
      </button>

      <article className="space-y-6 text-sm leading-relaxed text-text-muted">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-text sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="text-text-faint">
            App: Carbon (<code>com.emmertex.carbon</code>) · Last updated 17 July 2026
          </p>
        </header>

        <p>
          Carbon is an offline-first task manager. This policy explains what the
          app does with your data. In short:{" "}
          <strong className="text-text">
            the developer does not collect, receive, or have access to your data
          </strong>
          .
        </p>

        <Section title="What we collect">
          <p>
            <strong className="text-text">Nothing beyond what's described below.</strong>{" "}
            The developer runs no analytics, advertising, or tracking in the app. We do
            not see your tasks, notes, files, or usage unless you choose a Carbon-hosted
            sync server (see below).
          </p>
        </Section>

        <Section title="Where your data lives">
          <p>
            By default, all of your data (tasks, notes, attachments, settings) is
            stored <strong className="text-text">locally on your device</strong> and
            never leaves it.
          </p>
          <p>
            Carbon can optionally sync to a server <strong className="text-text">you
            choose</strong> — one you self-host, or a Carbon sync server. If you
            enable sync in Settings, your data is sent only to that server.
          </p>
          <p>
            A Carbon sync server{" "}
            <strong className="text-text">
              collects nothing beyond what the app needs to function.
            </strong>{" "}
            It stores only your data (tasks, notes, attachments, settings) and the
            account credentials needed to sign you in and sync — nothing more.
            There is no analytics, advertising, tracking, or sale of data. If you
            self-host, the server is yours and the same applies — you are its only
            operator.
          </p>
          <p>
            <strong className="text-text">Email address.</strong> When you use a
            sync server, your email address is collected and stored for account
            management, security, and account deletion. If you delete your account,
            your email address is deleted with it. You can delete your account at{" "}
            <a
              href="https://carbon.etx.sx/delete-account"
              className="text-accent underline underline-offset-4"
            >
              carbon.etx.sx/delete-account
            </a>
            .
          </p>
          <p>
            <strong className="text-text">Location.</strong> Location sharing is
            optional and is a <strong className="text-text">sync-server-only</strong>{" "}
            feature. If you enable it while using a sync server, your current
            location is pushed to the server and retained only until it goes stale —{" "}
            <strong className="text-text">no location history is kept</strong>, and
            all location data is deleted after 24 hours with no updates. Only you
            can see your location; other workspace members and administrators
            cannot.
          </p>
          <p>
            To turn coordinates into place names (reverse geocoding) and to search
            for locations by name, the sync server queries{" "}
            <strong className="text-text">OpenStreetMap (Nominatim)</strong>. These
            lookups are made <strong className="text-text">anonymously</strong> — no
            account, user, or device identifier is attached — and only the
            coordinates or search text needed for the lookup are sent. This also
            happens only when you use a sync server.
          </p>
        </Section>

        <Section title="Permissions the app requests">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-text">Internet</strong> — only to sync with a
              server you have configured. With no sync server set, the app makes no
              network connections for your content.
            </li>
            <li>
              <strong className="text-text">
                Notifications / exact alarms / run at startup
              </strong>{" "}
              — to show task reminders on time, including after a reboot.
            </li>
            <li>
              <strong className="text-text">Location</strong> — used for
              location-based reminders while the app is open, and (when enabled)
              for GPS tracks attached to time-tracking sessions. On Android the
              track recorder may run as a foreground service with a persistent
              notification while a timer is active. Matching against your tasks
              happens on your device. In local-only mode your location is never
              transmitted; if you enable location sharing with a sync server, the
              latest fix is pushed there under the limits described above. Track
              blobs sync like other attachments when sync is on. This permission
              is optional.
            </li>
            <li>
              <strong className="text-text">Vibrate</strong> — for reminder alerts.
            </li>
          </ul>
        </Section>

        <Section title="Push notifications">
          <p>
            If you enable push notifications with a sync server, delivery uses
            standard mobile push infrastructure (Google Firebase Cloud Messaging).
            Message delivery passes through that service; keep sensitive detail out
            of notification text if this matters to you.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Carbon is not directed at children and does not knowingly collect
            information from anyone.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If this policy changes, the updated version will be published at this
            location with a new “Last updated” date.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this policy:{" "}
            <a
              href="mailto:email@emmertex.com"
              className="text-accent underline underline-offset-4"
            >
              email@emmertex.com
            </a>
          </p>
        </Section>
      </article>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}
