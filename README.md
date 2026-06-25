# WatchParty Lite

A deliberately small watch-party app for shared YouTube rooms, with best-effort Facebook embeds.

## What it does

- Splash screen with two choices: enter a room ID, or create a random new room.
- Rooms are URL-addressable at `/watch/:roomId`.
- Users get a random `Adjective Noun` style name on first join, can set their own name, and the name is saved in `localStorage`.
- The room page has:
  - a video player on the left,
  - compact play/pause and click-to-seek controls in one card,
  - a horizontal user/ping list below the seek bar,
  - a 400px playlist on the right.
- Pasting a URL into the playlist input and pressing Enter adds a card.
- Playlist cards can be clicked to skip everyone to that video, deleted, or drag-reordered.
- The server console prints rooms with tab-delimited `IP/name` user rows.

## Run locally

```sh
npm install
npm run dev
```

The server defaults to `http://localhost:8080` and serves the plain static client directly.

## Run without watch mode

```sh
npm start
```

Then open `http://localhost:8080`. No build step is required.

When you open the app from another device by typing a numeric LAN address such as `http://192.168.1.20:8080`, the client redirects to an equivalent `sslip.io` hostname. YouTube embeds require a hostname in some local-network browsers, while `localhost` is special-cased by the browser.

## Configuration

Environment variables are optional:

- `HOST` — server bind host, default `0.0.0.0`.
- `PORT` — server port, default `8080`.
- `CLIENT_DIRECTORY` — directory containing `index.html` and `src/`, default current project root.
- `WSJTX_ENABLED` — set to `false` to disable the WSJT-X UDP receiver, default enabled.
- `WSJTX_HOST` — WSJT-X UDP bind host, default `127.0.0.1`. Configure WSJT-X to send to this address.
- `WSJTX_PORT` — WSJT-X UDP bind port, default `2237`. Configure WSJT-X to send UDP messages to this port.

The server exposes the WSJT-X receiver status at `/api/wsjtx` and broadcasts parsed packet metadata to connected Socket.IO clients as `wsjtx` events.
