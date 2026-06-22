# WatchParty Lite

A deliberately small watch-party app for shared YouTube rooms, with best-effort Facebook embeds.

## What it does

- Splash screen with two choices: enter a room ID, or create a random new room.
- Rooms are URL-addressable at `/watch/:roomId`.
- Users get a random `Adjective Noun` style name on first join, can set their own name, and the name is saved in `localStorage`.
- The room page has:
  - a video player on the left,
  - play/pause and click-to-seek controls,
  - a horizontal user/ping list below the seek bar,
  - a 200px playlist on the right.
- Pasting a URL into the playlist input and pressing Enter adds a card.
- Playlist cards can be deleted or drag-reordered.
- The server console prints rooms with tab-delimited `IP/name` user rows.

## Run locally

```sh
npm install
npm run dev
```

The server defaults to `http://localhost:8080`; the Vite UI defaults to `http://localhost:5173`.

## Build and run

```sh
npm run build
npm start
```

Then open `http://localhost:8080`.

## Configuration

Environment variables are optional:

- `HOST` — server bind host, default `0.0.0.0`.
- `PORT` — server port, default `8080`.
- `BUILD_DIRECTORY` — production client build directory, default `build`.
- `VITE_SERVER_HOST` — dev UI server target, default `http://localhost:$PORT` when using `npm run dev`.
