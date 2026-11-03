import { Link } from 'react-router'

/**
 * What happens to your video, in plain words. Short on purpose: Part 2 adds
 * accounts and bookings, and the full legal pages come with them (Phase 24).
 */
export default function PrivacyPage() {
  return (
    <main className="call-stage flex min-h-screen flex-1 justify-center px-4 py-10 sm:py-16">
      <article className="experience-card w-full max-w-2xl p-6 sm:p-8">
        <h1 className="font-display text-3xl">Video and privacy</h1>
        <p className="mt-2 text-sm text-muted-foreground">How Rendezvu handles your camera, microphone and name.</p>

        <div className="mt-6 flex flex-col gap-5 text-sm leading-relaxed">
          <section>
            <h2 className="font-semibold">Your audio and video</h2>
            <p className="mt-1 text-muted-foreground">
              Calls travel through Cloudflare’s Realtime network, which forwards each person’s audio and video to the others in
              the call. Media is encrypted on the way (DTLS-SRTP). Nothing is recorded or stored, by Rendezvu or by Cloudflare
              on our behalf.
            </p>
          </section>
          <section>
            <h2 className="font-semibold">Effects stay on your device</h2>
            <p className="mt-1 text-muted-foreground">
              Background blur, background pictures and noise suppression run entirely in your browser. A picture you choose is
              never uploaded; it’s gone when you reload the page.
            </p>
          </section>
          <section>
            <h2 className="font-semibold">Your name and meeting codes</h2>
            <p className="mt-1 text-muted-foreground">
              The name you type is shown only to people in the same call. Meetings exist only in the server’s memory and
              expire after 12 hours. Server logs keep technical events for troubleshooting: joins and leaves (with the name you
              joined with), and connection quality. Never the content of a call.
            </p>
          </section>
          <section>
            <h2 className="font-semibold">On your device</h2>
            <p className="mt-1 text-muted-foreground">
              Your browser stores your device choices, effect settings and, if you created a meeting, a token that lets you
              rejoin it without asking. No advertising or tracking cookies are used.
            </p>
          </section>
        </div>

        <Link to="/" className="mt-8 inline-block text-sm text-primary">
          Back to Rendezvu
        </Link>
      </article>
    </main>
  )
}
