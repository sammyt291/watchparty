const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const http = require("node:http");
const { Server } = require("socket.io");
const config = require("./config.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: {}, transports: ["websocket", "polling"] });
const rooms = new Map();

app.use(cors());
app.use(express.json());
app.get("/ping", (_req, res) => { res.json("pong"); });
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
    room = { playlist: [], playback: { itemId: null, playing: false, time: 0, updatedAt: Date.now() }, users: new Map() };
    rooms.set(id, room);
  }
  return room;
}
function serializeForSocket(room, socketId) { return { playlist: room.playlist, playback: playbackForUser(room, socketId), users: publicUsers(room) }; }
function publicUsers(room) { return [...room.users.values()].map(({ id, name, ip, ping, syncStatus }) => ({ id, name, ip, ping, syncStatus })); }
function broadcastUsers(roomId) { const room = rooms.get(roomId); if (room) io.to(roomId).emit("users", publicUsers(room)); }
function broadcastPlaylist(roomId, room) { io.to(roomId).emit("playlist", room.playlist); }
function schedulePlayback(roomId, room, basePlayback, originId = null) {
  const maxPing = Math.max(0, ...[...room.users.values()].map((user) => user.ping || 0));
  for (const [socketId, user] of room.users) {
    const delay = Math.max(0, maxPing - (user.ping || 0));
    setTimeout(() => io.to(socketId).emit("playback", playbackForUser(room, socketId, basePlayback, originId)), delay);
  }
}
function playbackForUser(room, socketId, basePlayback = room.playback, originId = null) {
  const user = room.users.get(socketId);
  const elapsed = basePlayback.playing ? (Date.now() - basePlayback.updatedAt + (user?.ping || 0) / 2) / 1000 : 0;
  return { ...basePlayback, originId, time: Math.max(0, basePlayback.time + elapsed), updatedAt: Date.now() };
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
