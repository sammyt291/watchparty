const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const http = require("node:http");
const dgram = require("node:dgram");
const { Server } = require("socket.io");
const config = require("./config.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: {}, transports: ["websocket", "polling"] });
const rooms = new Map();
const DEFAULT_PLAY_START_DELAY_CAP_MS = 500;
const PLAY_START_DELAY_MS = readPlayStartDelayCap();
const NTP_HOST = process.env.NTP_HOST || "pool.ntp.org";
const NTP_PORT = Number(process.env.NTP_PORT) || 123;
const NTP_POLL_INTERVAL_MS = 60_000;
const NTP_TIMEOUT_MS = 2_000;
let ntpOffsetMs = 0;
let ntpUpdatedAt = 0;

app.use(cors());
app.use(express.json());
app.get("/ping", (_req, res) => { res.json("pong"); });
app.get("/api/ntp-time", async (_req, res) => {
  if (!ntpUpdatedAt || Date.now() - ntpUpdatedAt > NTP_POLL_INTERVAL_MS) await refreshNtpOffset();
  res.json({ now: ntpNow(), offset: ntpOffsetMs, syncedAt: ntpUpdatedAt, host: NTP_HOST });
});
app.get("/api/metadata", async (req, res) => {
  const url = String(req.query.url || "");
  res.json(await getMetadata(url));
});

const clientPath = path.resolve(__dirname, "..", config.CLIENT_DIRECTORY);
const indexPath = path.join(clientPath, "index.html");

app.use("/src", express.static(path.join(clientPath, "src")));
app.get(/.*/, (_req, res) => {
  if (!fs.existsSync(indexPath)) {
    res.status(503).send(`Client file not found at ${indexPath}.`);
    return;
  }

  res.sendFile(indexPath);
});

io.on("connection", (socket) => {
  const roomId = safeRoomId(String(socket.handshake.query.roomId || ""));
  if (!roomId) return socket.disconnect(true);

  const room = getRoom(roomId);
  const ip = getIp(socket.handshake.address);
  const name = safeName(String(socket.handshake.query.name || ""));
  room.users.set(socket.id, { id: socket.id, name, ip, ping: null, pings: [], syncStatus: "Joining" });
  socket.join(roomId);
  socket.emit("state", serializeForSocket(room, socket.id));
  broadcastUsers(roomId);
  logRooms();

  socket.on("setName", (nextName) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    user.name = safeName(nextName);
    broadcastUsers(roomId);
    logRooms();
  });

  socket.on("clientPing", () => socket.emit("serverPong"));

  socket.on("pongMs", (ping) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    const nextPing = Number.isFinite(ping) ? Math.max(0, Math.round(ping)) : null;
    if (nextPing == null) {
      user.ping = null;
    } else {
      user.pings.push(nextPing);
      user.pings = user.pings.slice(-10);
      user.ping = Math.round(user.pings.reduce((sum, value) => sum + value, 0) / user.pings.length);
    }
    broadcastUsers(roomId);
  });

  socket.on("syncStatus", (status) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    user.syncStatus = cleanSyncStatus(status);
    broadcastUsers(roomId);
  });

  socket.on("playlist", (playlist) => {
    room.playlist = Array.isArray(playlist) ? playlist.map(cleanItem).filter(Boolean) : [];
    if (!room.playback.itemId && room.playlist[0]) room.playback.itemId = room.playlist[0].id;
    if (room.playback.itemId && !room.playlist.some((item) => item.id === room.playback.itemId)) {
      room.playback = { itemId: room.playlist[0]?.id || null, playing: false, time: 0, updatedAt: Date.now() };
    }
    broadcastPlaylist(roomId, room);
    schedulePlayback(roomId, room, room.playback);
  });

  socket.on("playback", (playback) => {
    const requestedItem = typeof playback.itemId === "string" ? playback.itemId : room.playback.itemId;
    room.playback = {
      itemId: room.playlist.some((item) => item.id === requestedItem) ? requestedItem : room.playback.itemId,
      playing: Boolean(playback.playing),
      time: Number.isFinite(playback.time) ? Math.max(0, Number(playback.time)) : room.playback.time,
      updatedAt: Date.now(),
    };
    schedulePlayback(roomId, room, room.playback, socket.id);
  });

  socket.on("disconnect", () => {
    room.users.delete(socket.id);
    if (room.users.size === 0) rooms.delete(roomId);
    else broadcastUsers(roomId);
    logRooms();
  });
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`WatchParty listening on http://${config.HOST}:${config.PORT}`);
});
function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { playlist: [], playback: { itemId: null, playing: false, time: 0, updatedAt: Date.now() }, users: new Map(), playbackTimers: [] };
    rooms.set(id, room);
  }
  return room;
}
function serializeForSocket(room, socketId) { return { playlist: room.playlist, playback: playbackForUser(room, socketId), users: publicUsers(room) }; }
function publicUsers(room) { return [...room.users.values()].map(({ id, name, ip, ping, syncStatus }) => ({ id, name, ip, ping, syncStatus })); }
function broadcastUsers(roomId) { const room = rooms.get(roomId); if (room) io.to(roomId).emit("users", publicUsers(room)); }
function broadcastPlaylist(roomId, room) { io.to(roomId).emit("playlist", room.playlist); }
function schedulePlayback(roomId, room, basePlayback, originId = null) {
  clearPlaybackTimers(room);
  const usersByPing = [...room.users.values()].sort((a, b) => (b.ping || 0) - (a.ping || 0));
  const maxPing = usersByPing[0]?.ping || 0;
  // `ping` is a full round trip, so schedule start using a one-way latency estimate.
  const playLeadMs = basePlayback.playing ? Math.min(PLAY_START_DELAY_MS, maxPing) : 0;
  const scheduleStartedAt = Date.now();

  for (const user of usersByPing) {
    const userPing = user.ping || 0;
    const oneWayLatencyMs = userPing / 2;
    const startDelayMs = basePlayback.playing ? Math.max(0, playLeadMs - oneWayLatencyMs) : 0;
    const targetStartAt = basePlayback.playing ? scheduleStartedAt + startDelayMs : null;
    const emitPlayback = () => {
      if (!rooms.get(roomId)?.users.has(user.id)) return;
      io.to(user.id).emit("playback", playbackForUser(room, user.id, basePlayback, originId, targetStartAt));
    };

    emitPlayback();
  }
}
function playbackForUser(room, socketId, basePlayback = room.playback, originId = null, targetStartAt = null) {
  const user = room.users.get(socketId);
  const now = Date.now();
  const fallbackElapsed = basePlayback.playing ? (now - basePlayback.updatedAt + (user?.ping || 0) / 2) / 1000 : 0;
  const startTime = targetStartAt == null ? null : Math.max(0, basePlayback.time + (targetStartAt - basePlayback.updatedAt) / 1000);
  return {
    ...basePlayback,
    originId,
    startDelayMs: targetStartAt == null ? 0 : Math.max(0, targetStartAt - now),
    targetStartAt,
    startTime,
    time: startTime ?? Math.max(0, basePlayback.time + fallbackElapsed),
    updatedAt: now,
  };
}
function clearPlaybackTimers(room) {
  for (const timer of room.playbackTimers || []) clearTimeout(timer);
  room.playbackTimers = [];
}
function readPlayStartDelayCap() {
  const value = Number(process.env.PLAY_START_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_PLAY_START_DELAY_CAP_MS;
}
function logRooms() {
  console.clear();
  console.log("Rooms");
  for (const [roomId, room] of rooms) {
    console.log(roomId);
    for (const user of room.users.values()) console.log(`\t${user.ip}\t${user.name}`);
  }
}
function safeRoomId(value) { return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }
function safeName(value) { return String(value).replace(/[\t\n\r]/g, " ").trim().slice(0, 32) || "Quiet Otter"; }
function getIp(address) { return address.replace(/^::ffff:/, ""); }
function cleanItem(item) { return item?.id && item?.url ? { ...item, title: item.title || item.url } : null; }
function cleanSyncStatus(status) { return ["Pending", "Joining", "Syncing", "Sync"].includes(status) ? status : "Pending"; }
function provider(url) {
  if (/youtu\.be|youtube\.com/i.test(url)) return "youtube";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  return "unknown";
}
async function getMetadata(url) {
  const base = { url, provider: provider(url), title: url };
  if (base.provider !== "youtube") return base;
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!response.ok) return base;
    const data = await response.json();
    return { ...base, title: data.title || url, thumbnail: data.thumbnail_url };
  } catch {
    return base;
  }
}
