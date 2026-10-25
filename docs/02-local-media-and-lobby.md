# Phase 2: Local media and the lobby

Status: **built**. Frontend and backend are done; the real-device checks in "Done when" are next. Backend: you (written by Claude this phase) · Frontend: Claude

## Goal

In the lobby, turn your camera and mic on, see yourself, watch a meter move when you speak, and pick which camera, mic and speaker to use. If the browser can't give you a device, it says why in plain words. Then join the room from Phase 1, and the room learns whether you arrived with your mic and camera on.

Nothing is sent to anyone yet. Media leaves the browser in Phase 4.

## Why this comes before any WebRTC

Most failed calls are device problems, not network problems: permission denied, the camera held by Zoom, no mic plugged in, a saved device that was unplugged last week. If those aren't handled first, every one of them shows up later looking like an SFU bug ("I joined but nobody can see me").

Doing it alone also teaches the browser's media model with nothing else in the way. Everything later (publishing, mute, device switching mid-call, blur) is built on the pieces in this phase.

## Concepts

**Track vs stream.** A `MediaStreamTrack` is one live source: one camera *or* one mic. A `MediaStream` is just a bag of tracks you can hand to a `<video>` element. Tracks are what get published (Phase 4), switched and stopped. A stream is a display convenience.

```
getUserMedia({ video }) ──► MediaStream ──► [ video track ]
getUserMedia({ audio }) ──► MediaStream ──► [ audio track ]
                                    combine
                        localStream = [ audio track, video track ] ──► <video srcObject>
```

**Intent vs live tracks.** Two separate facts, kept in two places:

| Fact | Where | Example |
|---|---|---|
| What the user *wants* | `stores/meet.ts`: `isMuted`, `isVideoOff` | "mic on, camera off" |
| What is actually *running* | `stores/peer.ts`: `localStream` and its tracks | one live audio track |

They differ on purpose, briefly: while `getUserMedia` is waiting for the permission prompt, the user has asked for the camera but no track exists yet. If acquiring fails, intent is *not* flipped, so the button never shows "camera on" with nothing behind it. Later phases rely on the same split: when the network drops (Phase 9), intent says what to restore.

**One device at a time.** The lobby asks for the mic and the camera separately, never in one `getUserMedia({audio, video})` call. If they were asked together, a missing camera would also lose you the mic. Asking separately means each one fails on its own and the other keeps working.

**Device ids.** Every camera, mic and speaker has a `deviceId`. `enumerateDevices()` lists them, but browsers hide the ids and labels until the user has granted permission once. So the device pickers only appear after you've turned something on. The chosen ids are saved in `localStorage` and requested with `deviceId: { exact }` next time.

**Stale requests.** Turning the camera on is async: the permission prompt can sit open for a minute. If the user clicks "off" in the meantime, or leaves, the late result must be thrown away and its track stopped, or the camera light stays on with nothing using it. Each device has a **generation counter**. Every action bumps it; a request that finishes under an older generation stops what it got and returns.

---

## Backend requirements (you)

Phase 2 is almost all browser work. The protocol doesn't change: `join` already carries `{name, audio, video}`, and the server already copies those into `joined` and `peer-joined`. The client now sends real values instead of `false, false`.

### 1. Confirm the media flags flow through

No code should be needed. Check with two WebSocket clients:
- A joins with `audio: true, video: false`. B joins. B's `joined.peers` shows A with `audio: true, video: false`.
- B joins with `audio: false, video: true`. A gets `peer-joined` with exactly those values.
- Anything that isn't literally `true` (a missing field, `"yes"`, `1`) is treated as `false`. `readJoinData` already does this.

### 2. Log each join

Add one structured log line when a join is accepted, after `hub.join`:

```
ws_join peer=<id> room=<code> name=<name> audio=<bool> video=<bool>
```

*Why:* when someone says "they couldn't hear me", the first question is "did you join with the mic on?". This line answers it from the server logs without asking the user.

Log values that contain spaces, quotes or `=`, or are empty, are written JSON-quoted (`name="Alice Smith"`), so every line still splits cleanly into `key=value` pairs.

### 3. Name hygiene (a deliberate addition)

The reference implementation stores the name exactly as received. Rendezvu is deployed publicly, and every name is shown on everyone else's screen, so clean it in `readJoinData`:

1. Replace every run of control characters (`\p{Cc}`) and whitespace with one space, so nobody can inject newlines or terminal escapes into tiles and logs, and `"Alice\nSmith"` still reads `"Alice Smith"`.
2. Trim surrounding whitespace.
3. Cap at **40 characters** (code points, not UTF-16 units, so an emoji isn't cut in half). This matches the lobby input's `maxLength`.
4. An empty result stays `''`. The client already shows "Guest" for an empty name.

*Why on the server when the input already has `maxLength`:* `maxLength` only limits honest browsers. Anyone can open a socket and send a 30 KB name, and the server is the only place that can enforce a rule for everyone.

This is your call: skip it to stay byte-for-byte with the reference, or keep it as cheap hardening for a public deploy. The client works either way.

### 4. Not in this phase

- **`peer-state`** (mute or camera changes after joining): Phase 6. Until then, the flags in `join` are the only media info the room gets, and there are no in-call toggles to change them.
- **Track info** (`sfu-announce`, `sfu-tracks`): Phases 4–5.

---

## Frontend (Claude)

### Lobby layout

```
┌──────────── preview (16:9) ────────────┐  ┌──────── join panel ────────┐
│                                   [⚙]  │  │ Ready to join?             │
│        your camera, or your avatar     │  │ [device error, if any]     │
│                                        │  │ Microphone off · Camera off│
│          ▁▂▃▅▆▇  (mic meter)           │  │ MEETING CODE  abc-defg-hij │
│ [Name]      ( 🎤  📷  ⇄ )              │  │ [ Your name            ]   │
└────────────────────────────────────────┘  │ [       Join now       ]   │
 ▾ Audio & video settings                    └────────────────────────────┘
   Microphone [▾]  Camera [▾]  Speaker [▾]
```

- **Mic and camera start off.** Nothing is requested until the user clicks, so opening a link never triggers a permission prompt by surprise.
- **Mic toggle.** Requests the mic alone. On success the meter appears and the toggle turns on. On failure, an explanation appears in the join panel and the toggle stays off.
- **Camera toggle.** Same, for the camera. The avatar is replaced by your live video.
- **Flip camera** (⇄). Shown only with the camera on and two or more cameras present. Switches between front and back on phones.
- **Mic meter.** 20 bars, lit by how loud the mic is. The preview gets a ring while you're speaking.
- **Device pickers.** In a collapsible "Audio & video settings" under the preview (its open/closed state is remembered), and in a Settings panel from the gear button. Picking a device while it's on swaps the live track straight away. Picking one while it's off just saves the choice for next time.
- **Speaker picker.** Shown only in browsers that can route audio to a chosen output (Chrome and Edge). Firefox and Safari use the system output.
- The status line reads "Microphone on/off · Camera on/off" for screen readers and at a glance.

### Error messages

| Browser error | Meaning | What the user sees |
|---|---|---|
| `NotAllowedError`, `SecurityError` | Permission denied, now or earlier | "Camera access is blocked. Allow it in your browser's site settings, then try again." |
| `NotFoundError`, `OverconstrainedError` | No such device | "No camera found. Connect one, or choose another in settings." |
| `NotReadableError`, `AbortError` | Device exists but won't start, usually held by another app | "Your camera is in use by another app, or couldn't start. Close other apps that use it, then try again." |
| No `navigator.mediaDevices` at all | The page isn't a secure context (plain `http://` on a LAN IP) | "Camera access needs a secure (HTTPS) connection." |
| Anything else | | "Camera unavailable. Allow access in your browser's site settings, or choose another device in settings." |

The same table applies to the mic, with "microphone" in place of "camera". The notice has **Open device settings** and **Dismiss** buttons.

### Fallbacks when requesting the camera

1. Ask for the saved camera (or the front camera) at 960×540, 24 fps.
2. `OverconstrainedError` (the saved camera is gone): ask again with no device id.
3. `NotReadableError` or `NotFoundError` (common on old Android while the previous track is still releasing): ask again without size and frame-rate hints.
4. Then any camera at all.

For the mic, a saved device that's gone (`OverconstrainedError`) is retried with the default mic. Mic constraints turn on echo cancellation, noise suppression and auto gain, mono at 48 kHz.

### Mic meter, briefly

The mic stream is **cloned** and the clone goes into a Web Audio `AnalyserNode`. Every 30 ms the client measures loudness (RMS), maps it to 0–1, and flags "speaking" above a threshold with a 280 ms hold, so the ring doesn't flicker between words.

- *Why clone:* Chrome can switch off hardware echo cancellation on a track that is wired into an `AudioContext`. The clone takes the hit; the original track, the one that will be published, keeps it.
- *Why a timer and not `requestAnimationFrame`:* rAF pauses in background tabs, which would freeze speaking detection mid-call in later phases.
- *One shared `AudioContext`:* browsers limit how many you can open, and iOS only lets one run after a tap. The Join and mic buttons resume it inside the click.

### Lifetime

| Event | Media |
|---|---|
| Lobby → call | Keeps running. The tracks you set up in the lobby are the tracks you'll publish. |
| Join refused (room expired) | Keeps running; you're back in the lobby. |
| Leave | All tracks stopped, intent reset to off. The camera light goes out. |
| Navigate away from the room page | Same as leave. |

### In the call

Your own tile shows your camera if it's on. Every tile shows a muted-mic icon for anyone who joined with their mic off, read from the flags in `joined` and `peer-joined`. In-call toggles come in Phase 6.

### Files

| File | Role |
|---|---|
| `stores/meet.ts` | Intent: `isMuted`, `isVideoOff` |
| `stores/peer.ts` | Live local media plus remote roster: `enableMic`, `disableMic`, `enableCamera`, `disableCamera`, `switchCamera`, `setAudioInput`, `setVideoInput`, `setAudioOutput`, `clearAll` |
| `lib/media-errors.ts` | Browser error name → the message above |
| `lib/audio-constraints.ts` | Mic constraints |
| `lib/audio-context.ts` | The shared `AudioContext` and speaker output |
| `lib/device-preferences.ts` | Saved device ids |
| `hooks/use-media-devices.ts` | Device lists, refreshed on `devicechange` and after permission |
| `hooks/use-audio-level.ts` | Level and speaking from a stream |
| `components/ui/` | `ControlButton`, `MicButton`, `CameraButton`, `FlipCameraButton`, `MicLevelMeter`, `DeviceSelect`, `select`, `Collapsible`, `DeviceErrorNotice`, `SettingsPanel` |

## Done when

- [ ] Mic on: the meter moves when you talk, and the preview ring shows while you speak.
- [ ] Camera on: you see yourself. Off: the avatar is back and the camera light goes out.
- [ ] With two cameras or mics, switching in the picker changes the live preview or meter without turning anything off.
- [ ] Deny permission (or block it in site settings): you get the "blocked" message, and the toggle stays off.
- [ ] Camera in use by another app (or unplugged): the matching message.
- [ ] Join with the mic on and camera off. Another tab sees you in the room with a mic and no muted icon. *(Backend 1)*
- [ ] Leave: the camera and mic indicators in the browser tab go off.
- [ ] On a phone over HTTPS: front camera by default, flip works.
