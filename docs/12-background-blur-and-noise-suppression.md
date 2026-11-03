# Phase 12: Background blur and noise suppression

Status: **built**. Backend: none this phase · Frontend: Claude

## Goal

Two optional effects, available in the lobby and during a call:
- **Background:** off, three strengths of blur, or a picture of your own behind you.
- **Noise suppression:** removes keyboard clatter, fans and traffic from your microphone, beyond what the browser already does.

You pick them in Settings → Effects; blur also gets a button in the call footer. The choices are remembered for next time. Turning one on or off mid-call is instant for everyone else: no renegotiation, no reconnect, the same connection to Cloudflare.

Above all, an effect can never break a call:
- If the model doesn't load, the device is too slow, or the browser can't run it, you keep your normal camera or mic and get one short message.
- If an effect stalls mid-call, it switches itself off.

## Why this comes now

These run on top of the media pipeline, so they come once that pipeline is stable: publishing (Phase 4), swapping tracks without renegotiation (Phase 6), repair (Phase 9). They're also the first features that put **heavy work on the user's device**: a neural network on every video frame, and another on every 10 ms of audio. That's why they're optional, load only when asked for, and have a way out.

## Concepts

**An effect is a track in, a track out.** Neither effect touches WebRTC. Each one takes the raw track from the camera or mic, processes it, and produces a **new** `MediaStreamTrack`. That processed track goes where the raw one would have gone: into `localStream`. Phase 6 already makes this a swap:
- a new `localStream` → `SfuSession.publish()` → the push's subject gets the new track
- partytracks calls `replaceTrack` on the existing sender

So turning blur on is the same operation as switching cameras. The others just start receiving different frames on the same stream, and nobody renegotiates.

```
camera ──raw track──► [blur] ──processed track──► localStream ──► sender (replaceTrack)
                         ▲
              rawCameraTrack kept here, so turning blur off swaps it straight back
```

The store keeps both: `rawCameraTrack` and `rawMicTrack` are the device tracks. `localStream` holds what's actually sent, raw or processed.

**How background blur works.**
1. A small neural network, MediaPipe's **selfie segmenter** (250 KB), looks at a frame and returns, for every pixel, how confident it is that the pixel is a person (0–1).
2. Two copies of the frame are drawn on canvases:
   - one with a CSS blur filter: the background
   - one sharp, whose alpha channel is set from the confidence mask: the person
3. The sharp person is drawn on top of the blurred background, on a third canvas.
4. `canvas.captureStream()` turns that canvas into a video track.

Confidence isn't a hard yes/no. Mapping 0.18–0.78 onto transparent-to-opaque with a smooth curve (`smoothstep`) feathers the edge of the hair and shoulders instead of cutting a jagged outline.

| Effect | What's behind you |
|---|---|
| Subtle | blur 8 px |
| Medium (the footer button) | blur 14 px |
| Strong | blur 22 px |
| Picture | your image, scaled to cover the frame |

**Blurred video runs at 15 fps.** The network costs about 5–20 ms a frame on a laptop GPU, more on a phone. Running it on every camera frame would starve the rest of the page. A canvas stream only carries a new frame when the canvas is drawn, so the output runs at the segmentation rate: 15 a second, against the camera's 20–24. That's the price of blur, and it's in line with what other call apps do. (Measured in testing: 15–16 fps at 960×540.)

**A clock that doesn't fall asleep.** Browsers slow `setInterval` to once a second in background tabs, and to once a minute after five minutes. A blur driven by the page's timers would freeze everyone's view of you the moment you switch tabs.
- So the loop is driven by a tiny **Web Worker** that posts a tick every 1/15 s. Timers in a worker aren't throttled like the page's.
- The reference uses the page's timer and has this freeze.
- Switching to the raw camera while hidden would fix the freeze, but it would show your real background without warning. That's a privacy failure, so it's not an option.

**How noise suppression works.**
- **RNNoise** is a small recurrent neural network (BSD-licensed, from Xiph and Mozilla) trained to tell speech from noise. It processes audio in 10 ms frames of 480 samples at 48 kHz.
- It runs as **WebAssembly** inside an **AudioWorklet**: a piece of JavaScript the browser runs on its real-time audio thread, outside the page's main thread. A slow page therefore can't make your audio stutter.

```
mic track → MediaStreamSource → AudioWorkletNode (RNNoise) → MediaStreamDestination → processed track
                     all inside one AudioContext created at 48 kHz
```

- The context must run at **48 kHz**: RNNoise only understands that rate, and some Macs default to 44.1 kHz.
- It must also be **running**. A context created without a user gesture can start out `suspended` and then produce silence. So the suppressor checks `state === 'running'` after start-up and falls back to the raw mic if it isn't.

**Built-in suppression stays on.** The browser's own `noiseSuppression` constraint (Phase 2) is light and handles hum and hiss. RNNoise is stronger on the noises people complain about: typing, chatter, dogs. They stack without trouble, as in the reference.

**Loading only when asked.** MediaPipe's WebAssembly runtime is about **13 MB**, and the RNNoise worklet and its WASM about 0.5 MB. Neither is part of the page:
- Each effect's code is a dynamic `import()`, so Vite builds it as a separate chunk.
- Its files load the first time someone turns the effect on, and are cached after that.
- People who never use effects download nothing.

**Hosting the files ourselves.** The reference loads the WASM from jsDelivr and the model from Google Storage at call time. Rendezvu serves both from its own origin:
- the model at `client/public/models/selfie_segmenter.tflite`, committed (Apache-2.0)
- the WASM copied from the npm package into the build

Why:
- a call doesn't depend on two extra third-party services
- no third party learns who uses effects
- it works on a LAN without internet access to those services
- the **Done when** test is simply "block `/models/selfie_segmenter.tflite`"

**The fallback, in every case.** An effect is an extra layer on a working track, so every failure ends with the working track:
- **Fails to load** (blocked file, no WebGL or WebAssembly, a suspended audio context): keep the raw track, reset the setting to off, and show one toast: "Background blur isn't available on this device." or "Noise suppression isn't available, using your normal microphone."
- **Fails mid-call** (a thrown error in the frame loop, the worklet's processor error): stop the effect, swap the raw track back, same toast.
- **Too slow:** each segment-and-composite pass is timed. If the average over the last 30 frames is above 60 ms (less than about 15 fps), the effect is switched off with "Background blur was turned off to keep your call smooth." The reference has no such guard.
- **Nothing in this path throws past its own `try`.** The worst outcome of a broken effect is your normal camera or mic, never a crash screen and never no video.

**Async and stale results, again.** Turning blur on takes up to a few seconds the first time, while the model loads. Meanwhile you might turn the camera off, switch cameras or pick another effect. Each of those bumps the camera's generation (Phase 2). An effect that finishes starting under an old generation stops itself and its output, and nothing is swapped in. The last thing you chose wins, as with fast camera toggling in Phase 9.

**Devices come and go with effects on.**
- **Camera off:** stop the processor and the raw track. Camera on: open the raw track, then apply the saved effect.
- **Switching camera or flipping:** stop the processor on the old raw track and start it on the new one.
- **Mic muted:** stop the suppressor and the raw track. Unmuted: open the raw track, then apply suppression if it's on.
- **Unplugged or revoked:** the **raw** track ends, but a processed track never fires `ended` by itself. So the Phase 9 interruption watcher (`useCallControls`) watches the raw track when there is one. Without that change, unplugging a camera with blur on would freeze your picture instead of showing the toast.
- **Screen share:** effects apply to the camera only. Starting a share sends the screen as before. Stopping it brings the camera back with its effect.

**What is saved.** Settings → Effects writes `{ background: 'off' | 'blur-subtle' | 'blur-medium' | 'blur-strong', noiseSuppression: boolean }` to `localStorage` (`rendezvu.effects`). A picture background isn't saved: an image can be megabytes, too large for `localStorage`, and a stale picture appearing next week would be a surprise. The reference makes the same call. After a reload, a picture becomes off.

---

## Backend requirements

None. Effects change the frames and samples inside existing tracks; the server, the protocol and Cloudflare see nothing new.

---

## Frontend (Claude)

- **Dependencies:**
  - `@mediapipe/tasks-vision@1.1.1` (Apache-2.0)
  - `@sapphi-red/web-noise-suppressor@0.4.1` (MIT; the RNNoise worklet and WASM, with a SIMD build where supported)
  - Both are pinned, and both are only `import()`ed by the effects.
- **Model and WASM:**
  - `client/public/models/selfie_segmenter.tflite`, committed
  - MediaPipe's `wasm/` folder copied into the build under `/mediapipe/` by a small Vite plugin, so dev and production serve the same paths
- **`lib/effects/background.ts`:** `BackgroundProcessor`
  - `start(rawTrack) → processedTrack` and `stop()`
  - the segmenter is loaded once per page and shared
  - the worker clock; the three canvases; feathering from the confidence mask
  - the 60 ms guard, reported through `onFailure(reason)`
- **`lib/effects/noise.ts`:** `NoiseSuppressor`
  - `start(rawTrack) → processedTrack` and `stop()`
  - its own 48 kHz `AudioContext`; the running check
  - `onFailure` from the worklet's `processorerror`
  - on stop: closes the worklet port and the context (a Chromium leak otherwise)
- **`lib/effects/preferences.ts`:** reads and writes `rendezvu.effects` inside try/catch.
- **Peer store:**
  - `rawCameraTrack`, `rawMicTrack`
  - `backgroundEffect`, `backgroundImage` (an object URL, for this page only), `noiseSuppression`
  - `setBackgroundEffect(effect)` and `setNoiseSuppression(on)`, both resolving to whether the effect is now really on
  - `enableCamera`, `enableMic`, `switchCamera` and `setVideoInput` / `setAudioInput` apply the saved effect to the new raw track
  - `disableCamera`, `disableMic` and `clearAll` stop processors and raw tracks
  - all of it under the existing device generations
- **`useCallControls`:** the interruption watcher observes `rawCameraTrack ?? camera track` and `rawMicTrack ?? mic track`.
- **Settings → Effects** (lobby and call):
  - background: Off, Subtle, Medium, Strong, Picture (a file input that accepts images up to 10 MB)
  - a noise suppression switch
  - a spinner on the option that's loading; disabled while the camera (or mic) is off, with a hint
- **Footer:** a blur button (Medium on, off) next to the camera button, shown only while the camera is on and not sharing.
- **Toasts** for every fallback, at most one per effect at a time.

## Deliberate differences from the reference

- **Self-hosted model and WASM** instead of jsDelivr and Google Storage at call time.
- **A Web Worker clock** for segmentation, so blur doesn't freeze in a background tab.
- **The slow-device guard** (60 ms average over 30 frames switches blur off). The first 15 frames don't count: they include compiling the model for the device, and in testing they alone tripped the guard on a machine that then ran blur fine.
- **An npm package for RNNoise** (`@sapphi-red/web-noise-suppressor`, MIT) instead of a worklet bundle copied into `public/`, so its version and license are visible in `package.json`.
- **A 48 kHz context and a running check** for noise suppression. The reference uses the default sample rate and doesn't check.
- **The interruption watcher follows the raw tracks** (the reference does the same in its call screen; here it's in `useCallControls`).

## Not in this phase

- Effects on screen shares.
- Virtual backgrounds from a built-in gallery: only your own picture for now.
- Running segmentation in a worker with `OffscreenCanvas` and `MediaStreamTrackProcessor`. That would be faster, but it's Chrome-only; the main-thread canvas works in every browser.

## Done when

1. In a call, turn blur on in Settings: within about 2 s (the first time) the others see your background blurred. In `chrome://webrtc-internals` the publish connection doesn't renegotiate and its sender keeps its id. Turn it off: your normal camera is back, also with no renegotiation.
2. Switch between Subtle, Medium, Strong and a picture: each change shows for the others within a moment.
3. Turn noise suppression on and type loudly near the mic: the others hear your voice but much less of the typing. Turn it off mid-sentence: no dropout longer than a blink.
4. Reload the page: the lobby comes back with the same blur and noise settings already applied in the preview.
5. In DevTools → Network, block `/models/selfie_segmenter.tflite` and turn blur on: the toast says it isn't available, your normal video keeps going for everyone, and the setting shows Off.
6. With blur on, switch to another tab for a minute: the others still see you moving smoothly.
7. With blur on, unplug the camera: the "Camera was interrupted" toast appears and the others see your avatar (Phase 9 behaviour, now through the raw track).
8. Toggle blur and the camera quickly a few times: the result matches the last thing you chose, and no camera light stays on when the camera is off.
9. On a slow phone, if blur can't keep up, it turns itself off with the "keep your call smooth" message, and the call carries on.
