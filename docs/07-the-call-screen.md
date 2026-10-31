# Phase 7: The call screen

Status: **built**. Backend: none this phase · Frontend: Claude

## Goal

The call screen is the real layout from here on. Anywhere from 1 to 10 people fit any screen, from a phone held upright to a wide monitor, with no scrolling and no tile cut off. You can pin someone to make them large. Two people get a FaceTime-style view. Each tile shows who is talking, muted, sharing or still connecting. Short sounds mark people joining and leaving. Leaving turns everything off: no camera light, no open connection.

## Why this comes now

Phases 5 and 6 gave every tile its data: a name, the tracks, mic, camera, sharing and speaking. Until now the tiles sat in a plain CSS grid that was only good enough to test with. Building the real layout now means building it once, with every piece of data it shows already there. Later phases add overlays to the same tile (reconnecting in Phase 9, the quality dot and "Audio only" in Phase 10) without changing the layout.

## Concepts

**Fitting tiles: try every column count, keep the biggest tile.** A CSS grid with fixed breakpoints can't fit 5 people into a short, wide window and also into a tall phone. Instead, the grid measures its own box (`ResizeObserver`) and tries every option: 1 column, 2 columns, … up to one column per person. For each, it works out the largest 16:9 tile that fits, then keeps the option with the largest tile area.

```
6 people, a 1280×720 window, 8 px gaps
2 columns × 3 rows → each tile 417×234
3 columns × 2 rows → each tile 421×236   ← wins, by a hair
```

A short last row is centred: 5 people show as 3 on top and 2 centred below. Upright phones need one correction. There, a row can be much taller than the 16:9 picture inside it, so options are compared by the visible picture height, not the row height. Without this, 3 people on a phone would pick 3 narrow columns over 3 stacked rows.

**Tiles are placed, not flowed.** Each tile is absolutely positioned at its computed `left / top / width / height`, with a 200 ms transition. When someone joins, the others glide to their new spots instead of jumping. Each tile keeps the same React `key` wherever it moves, so its `<video>` element is never recreated. Recreating it means a black flash while it starts playing again. (No transition with reduced motion.)

**Pin: one big, the rest in a strip.** Pinning someone gives them the whole area except a strip along the bottom. Everyone else becomes a small thumbnail in that strip: 72–160 px wide, at most 100 px tall (or 23% of the height on a short screen). Thumbnails are *compact*: they show initials instead of the full name, and no badges, so nothing overflows. Pinning the same person again unpins them. If the pinned person leaves, the pin is cleared. You can pin yourself, but only once someone else is there.

**Two people: a conversation.** With exactly two people and no pin, the other person is large and you are a thumbnail. That's how video calls between two people usually look. You don't need to see your own face full size to talk to someone. Pinning still overrides it.

**Show video only once it plays.** A `<video>` that has a stream but hasn't decoded its first frame shows black. So the tile keeps showing the avatar, with "Waiting for video…" for remote people, until the video fires `playing`. Then it swaps to the picture. If the stream object changes, the tile waits for `playing` again. The decision about whether a tile *should* show video stays as in Phase 6: `video || screenSharing`, and a live video track.

**Why the remote stream must be a new object.** React decides whether to re-run an effect by comparing values with `===`. Adding a track to an existing `MediaStream` (`stream.addTrack`) changes what's inside but not the object. The effect that attaches it to the `<video>` doesn't run again, and some browsers don't pick up the new track by themselves. So whenever a person's tracks change, the store builds a **new** `MediaStream` (done since Phase 5). The tile also listens to `addtrack` / `removetrack` on the stream it has, and re-attaches, as a backstop.

**Faces fill the tile; screens and upright phones fit inside it.** A face looks fine cropped a little (`object-cover`). A screen must be shown whole (`object-contain`, black bars). An upright phone camera in a 16:9 tile is the hard case: cropping it would keep only about a third of the frame, a zoomed-in chin. So for cameras the tile decides from the real sizes. If cropping keeps at least 70% of the frame, it crops; otherwise it fits. A 4:3 webcam keeps 75% and is cropped; an upright phone keeps 32% and is fitted. The decision runs again when the video or tile changes size.

**Speaking.** The sender already holds `speaking` for 280 ms after the voice drops (Phase 6). The receiver adds its own 280 ms hold before removing the outline, so a `speaking: false` that arrives a moment early, or out of step with the audio, doesn't make the outline flicker. A speaking tile gets a primary-coloured border and three moving bars in the name pill.

**Sounds without sound files.** Each sound is one to three short sine tones made with the shared `AudioContext`. There are no files to load, and the sound plays instantly.

| Sound | Tones | When |
|---|---|---|
| You joined | 392 → 523 Hz | Clicking Join |
| Someone joined | 440 → 554 Hz | `peer-joined` |
| Someone left | 554 → 370 Hz | `peer-left` |
| You left | 370 Hz | Clicking Leave |
| Share started | 392 → 494 → 587 Hz | You start sharing, or someone's `screenSharing` turns true |
| Share stopped | 494 → 392 Hz | The reverse |

Sounds play only if the `AudioContext` is already running. Browsers keep it suspended until the user has clicked something, and Join is that click. Two tabs of the same browser in one room would each play the same sound a few milliseconds apart. So each sound writes its time to `localStorage`, and any tab that sees the same sound written less than 600 ms ago skips it. "You joined" and "someone joined" share one slot, so in that two-tab test you hear one chime, not two.

**Leaving cleanly.** Leaving is a checklist, because each item left behind is visible to someone:

| Left running | What it looks like |
|---|---|
| Camera or mic track | The camera light stays on after leaving |
| Screen track | The browser's "You are sharing" bar stays |
| Publish or subscribe connection | Cloudflare keeps sending media nobody watches |
| WebSocket in the room | The others see a ghost tile until the 60 s idle timeout |
| Timers (pin hold, speaking hold, copied tick) | React warnings, and state set on a gone screen |

Most of this already happens (Phases 2–6). This phase adds the leave sound and the error-boundary path, and checks the whole list in the done-when.

---

## Backend

None. Everything the screen shows already arrives in `joined`, `peer-joined`, `peer-left`, `sfu-tracks` and `peer-state`.

## Frontend (Claude)

- **`VideoGrid`** (new, `components/ui/VideoGrid.tsx`): the measure-and-try layout above, with gap 8, 16:9, plus `focusKey` (the pinned tile) and `conversation`. Each child sits in an absolutely positioned wrapper, `.call-tile-position`, with the 200 ms transition.
- **`VideoTile`** (new, replaces the inline tile in `MeetCall`):
  - avatar until video plays, sized at 22% of the tile (44–108 px), or 32 px when compact
  - the `<video>` hidden until `playing`, then shown
  - top right: a mic badge, always shown (dark when on, red when muted)
  - bottom right: a pin button, shown on hover on desktop and always on touch screens, and always while pinned
  - bottom left: a name pill with `(you)`, `• Screen` while sharing, the speaking bars, initials when compact
  - a speaking border, and a softer ring while pinned
  - "Waiting for video…" on remote tiles that should show video but don't yet
  - remote speaking held 280 ms
- **`StreamVideo`**: attaches `new MediaStream(videoTracks)`, and re-attaches on `addtrack` / `removetrack`. Passes `onPlaying` and `visible` through. If autoplay is blocked, it tries again on the next tap. Its fit is `cover`, `contain` or `adaptive` (the 70% rule).
- **`MeetCall`** (rewritten around the grid):
  - The page is exactly the screen height (`h-dvh`), so phone browser bars never cause a scroll.
  - Header: the meet code inside the share/copy button. While you share, a "Presenting" pill. Then "N participants".
  - Pin state, cleared when the pinned person leaves. Conversation mode on.
  - "Share the code above to invite someone" while you're alone.
  - Footer in one glass pill: mic, camera, settings, flip, screen share, a divider, then Leave (icon only on phones). The screen-share button while sharing uses a new `.ctrl-btn-screen` (foreground colour).
  - A blank cover over the call while the screen picker is open. The picker previews your screen, which shows this call. Covering it keeps the preview from showing the call inside itself, and keeps the others' faces out of the first frames of the share.
  - Leave plays the leave sound, then the existing leave path.
- **`lib/sounds.ts`** (new): the six sounds and the cross-tab check (`localStorage` keys `rendezvu:sfx:*`). Wired up in:
  - `JoinMeet`: you joined
  - `use-call`: someone joined or left, and a remote share starting or stopping (comparing the old and new `screenSharing` in `updatePeerState`)
  - `use-call-controls`: your share starting or stopping
  - `MeetCall`: you left
- **`CallErrorBoundary`** (new): if the call screen crashes while rendering, it shows "Something went wrong in the call" with **Try again** and **Leave call** instead of a blank page. Leave runs the normal leave, so the camera still turns off.
- **CSS**: `.call-tile-position`, `.audio-bar` and its animation, `.ctrl-btn-screen`, all switched off under reduced motion.

## Deliberate differences from the reference

- Remote audio stays in its own hidden `<audio>` per person (Phase 5), not inside each tile. Sound then never depends on how a tile is shown, and the speaker choice from settings is applied in one place.
- The error screen has no error reference number. That comes with error reporting in Phase 13.

## Not in this phase

- **Time-left timer and auto-leave.** The reference shows a session's time left from 10 minutes before the end (amber at 5), with toasts at 10 and 5 minutes, and a 10-second auto-leave when time is up. It only exists for booked sessions, which have an end time; instant rooms have none. It comes with bookings. There's no elapsed-time timer in the reference, so none here.
- "Reconnecting…" and "Connection lost" on a tile, and the connection banner: Phase 8 (signaling) and Phase 9 (media).
- The quality dot, "Audio only" and the "Video quality reduced" notice: Phase 10.
- Knock requests in the call: Phase 11.

## Done when

1. A 6-person call (tabs plus a phone) fills a laptop screen as 3 × 2 and an upright phone as a column. Nothing scrolls, and resizing the window makes the tiles glide to their new spots.
2. With two people, the other person is large and you're a thumbnail. Pinning anyone puts them large with the rest in the strip. Pinning them again, or them leaving, goes back to the grid.
3. A remote tile shows the avatar and "Waiting for video…" until their picture plays, never a black box.
4. An upright phone camera is shown whole in a laptop's tile. A laptop webcam fills its tile. A shared screen is shown whole.
5. Talking gives your tile the border and bars on the other devices, without flicker between words.
6. The sounds play once each: join, someone joining or leaving, sharing starting or stopping. In a two-tab test, each is heard once, not twice.
7. After Leave: no camera light, no sharing bar. `chrome://webrtc-internals` shows the connections closed, and the server logs `leave` straight away, not 60 s later.
8. Alone in the room: the invite hint is shown and the pin button isn't.
