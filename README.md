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

## Configuration

Environment variables are optional:

- `HOST` — server bind host, default `0.0.0.0`.
- `PORT` — server port, default `8080`.
- `CLIENT_DIRECTORY` — directory containing `index.html` and `src/`, default current project root.
