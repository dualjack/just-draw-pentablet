# iPad Pen Tablet MVP

Input-only MVP for using an iPad web app as an Apple Pencil surface and sending events to a Windows receiver.

## What It Does

- SvelteKit PWA opens full-screen on iPad.
- The black input surface captures Pointer Events from Apple Pencil and touch.
- Events include position, normalized position, pressure, tilt, buttons and timestamps.
- A Node.js WebSocket receiver logs samples and sends acknowledgements for RTT/debug stats.

This MVP currently has two receiver modes: debug logging and experimental RobotJS mouse control. It is still not true Windows Ink / HID pen injection yet.

## Run

Install dependencies:

```sh
npm install
```

`robotjs` is optional. Install succeeds without it; the default receiver only logs pointer events. Mouse control (`receiver:mouse`, `receiver:pencil`) needs `robotjs`, which is a native addon on Windows. If mouse mode reports `robotjs unavailable`, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload, then run:

```sh
npm install robotjs
```

Start the receiver on the Windows machine:

```sh
npm run receiver
```

Start experimental mouse control with finger/mouse-style pointer input:

```sh
npm run receiver:mouse
```

Start Apple Pencil mode. This ignores touch input and presses the left mouse button only when Pencil pressure is above the threshold:

```sh
npm run receiver:pencil
```

You can tune the pressure threshold:

```sh
PRESSURE_THRESHOLD=0.12 npm run receiver:pencil
```

Start the SvelteKit dev server:

```sh
npm run dev
```

Open the SvelteKit URL on the iPad, then enter the receiver URL printed by the receiver, for example:

```text
ws://192.168.1.50:8787
```

## Next Steps

- Add a native Windows input bridge after validating sample rate and latency.
- Test WebRTC DataChannel against WebSocket if jitter is too high.
- Map touch gestures to commands like pan, zoom, undo or modifier keys.
