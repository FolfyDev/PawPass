import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import Breadcrumbs from '../components/Breadcrumbs.jsx';

export default function Privacy() {
  const { settings } = useSession();
  usePageMeta({ title: 'Privacy Policy', description: 'What data we collect and how it is used.' });

  const entity = settings?.legal?.entityName || settings?.orgName || 'this instance';
  const contact = settings?.legal?.contactEmail || settings?.supportEmail || '';

  return (
    <article style={{ padding: '40px 0 60px', maxWidth: 720 }}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Privacy Policy' }]} />
      <p className="eyebrow">Legal</p>
      <div className="hero-rule" style={{ maxWidth: 80 }} />
      <h1>Privacy Policy</h1>
      <p className="muted small">Last updated: September 1, 2026</p>

      <div className="stack" style={{ gap: 22 }}>
        <p>
          This Privacy Policy explains what information <strong>{entity}</strong> collects through "PawPass" (The Event Management System), why we
          collect it, and how it is used. It applies to this event registration platform only.
        </p>

        <section>
          <h2>1. Information we collect</h2>
          <ul>
            <li><strong>Telegram sign-in:</strong> your Telegram ID, username, display name, and profile photo, if you sign in or register through Telegram.</li>
            <li><strong>Registration details:</strong> your legal name, fursona/badge name, email address, and answers to any custom event questions.</li>
            <li><strong>Ticket &amp; check-in data:</strong> your registration status, RSVP, QR code, check-in time, and badge print history.</li>
            <li><strong>Payment records:</strong> for donation/paid tiers, the payment method and amount as recorded by staff or returned by PayPal we do not collect or store card numbers.</li>
            <li><strong>Account credentials:</strong> a hashed password, if you set one for email sign-in.</li>
            <li><strong>Standard technical data:</strong> IP address and basic request logs, generated automatically by any web server.</li>
          </ul>
        </section>

        <section>
          <h2>2. How we use it</h2>
          <p>
            We use this information to register you for events, verify your identity at check-in, print your
            badge, generate your ticket (including Apple/Google Wallet passes if you add one), show you who else
            has RSVP'd to an event you're attending, and  only if you provided an email and the organizer sends
            one  email you updates about events you registered for.
          </p>
        </section>

        <section>
          <h2>3. Who we share it with</h2>
          <p>
            Event staff and administrators of this instance can see registration data for events they manage. If
            you add a wallet pass, Apple or Google receives the ticket details needed to display it. If you pay
            through a donation link, PayPal handles that transaction directly  we only see what it reports back
            (method, amount). We do not sell your data or share it with advertisers.
          </p>
        </section>

        <section>
          <h2>4. Cookies</h2>
          <p>
            We use a single session cookie to keep you signed in. We do not use third-party advertising or
            tracking cookies.
          </p>
        </section>

        <section>
          <h2>5. Data retention</h2>
          <p>
            We keep registration data for as long as needed to run the event it belongs to and for reasonable
            record-keeping afterward. You can ask us to delete your account and associated registration data at
            any time, subject to any records an event organizer needs to keep for legal or safety reasons.
          </p>
        </section>

        <section>
          <h2>6. Your choices</h2>
          <p>
            You can review and update your details from your Account page, unlink Telegram, or set/change your
            password there. To request a copy or deletion of your data, contact us using the details below.
          </p>
        </section>

        <section>
          <h2>7. Changes to this policy</h2>
          <p>
            If this policy changes materially, we'll update the "Last updated" date above. Continued use of the
            platform after a change means you accept the updated policy.
          </p>
        </section>

        <section>
          <h2>8. Contact</h2>
          <p>
            Questions about this policy, or requests about your data, can be sent to{' '}
            {contact ? <a href={`mailto:${contact}`}>{contact}</a> : 'the event organizers'}.
          </p>
        </section>
      </div>
    </article>
  );
}
