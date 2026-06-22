# WatchParty

![screenshot](https://github.com/howardchung/watchparty/raw/master/public/screenshot_full.png)

A website for watching videos together.

## Description

- Synchronizes the video being watched with the current room
- Plays, pauses, and seeks are synced to all watchers
- Supports:
  - Screen sharing (full screen, browser tab or application)
  - Launch a shared virtual browser in the cloud (similar to rabb.it)
  - Stream-your-own-file
  - Video files on the Internet (anything accessible via HTTP)
  - YouTube videos
  - Magnet links (via WebTorrent)
  - .m3u8 streams (HLS)
- Create separate rooms for users on demand
- Text chat
- Video chat

## Quick Start

- Clone this repo via `git clone git@github.com:howardchung/watchparty.git`
- Install npm dependencies for the project via `npm install`
- Start the server and React application together via `npm run dev`
  - The server defaults to port 8080. Customize it with `PORT=3000 npm run dev` (macOS/Linux), `$env:PORT=3000; npm run dev` (PowerShell), or `npm run dev -- --port 3000`.
  - The React app defaults to port 5173. Open the URL printed by Vite, usually `http://localhost:5173`.
  - `npm run dev` automatically points the React app at the local server. You can still override this with `VITE_SERVER_HOST`.
  - Set `SSL_KEY_FILE` and `SSL_CRT_FILE` for HTTPS. HTTPS is required by the browser for some WebRTC features (camera, etc.).
- To run the two pieces separately, start the API with `npm run dev:server` and the React app with `npm run ui` in another shell.
- Duplicate the `.env.example` file
- Rename it to `.env`
- Add config for the features you want as described in the advanced setup

## Advanced Setup (optional)

All of these are optional and the application should work without them. Some functionality may be missing.

### YouTube API (video search)

This project uses the YouTube API for video search, which requires an API key. You can get one from Google [here](https://console.developers.google.com).

Without an API key you won't be able to search for videos via the searchbox.

After creating a **YouTube Data API V3** access, you can create an API key which you can add to your environment variables by copying the `.env.example`, renaming it to `.env` and adding the key to the YOUTUBE_API_KEY variable.

After that restart your server to enable the YouTube API access on your server.

### Firebase Config (user authentication)

This project uses Firebase for authentication. This is used for user login, account management, subscriptions, and handling some features like room locking/permanence.

To set up, create a new Firebase app (or reuse an old one) from [here](https://console.firebase.google.com/). After creating an application, click on the settings cog icon in the left menu next to "Project overview" and click on project settings. From there, scroll down, create a web application and copy the Firebase SDK configuration snippet JSON data.

Next, you have to stringify it: `JSON.stringify(PASTE_CONFIG_HERE)` in your browser console, then add it to `VITE_FIREBASE_CONFIG` in your .env file.

For server verification of accounts you'll also need `FIREBASE_ADMIN_SDK_CONFIG`, which you should do the same steps for.

### Virtual Browser Setup

This project supports creating virtual browsers (using https://github.com/m1k1o/neko) either on a cloud provider or with Docker containers. For development, Docker is easiest.

- Install Docker: `curl -fsSL https://get.docker.com | sh`
- Make sure you have an SSH key pair set up on the server (`id_rsa` in `~/.ssh` directory), if not, use `ssh-keygen`.
- Configure `DOCKER_VM_HOST_SSH_USER` if `root` is not the correct user
- Note: If your web client is not running on the same physical machine as the server, you will also need to configure `DOCKER_VM_HOST` to a publically-resolvable value (i.e. not localhost)
- If you want to run managed instance pools (whether on cloud or with Docker), configure `VM_MANAGER_CONFIG` and run the vmWorker service.

### Room Persistence

- Configure Postgres by adding DATABASE_URL to your .env file and then setting up the database schema
- This allows rooms to persist between server restarts

## Tech

- React
- TypeScript
- Node.js
- Redis
- PostgreSQL
- Docker
