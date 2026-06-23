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
const SYNC_CHECK_INTERVAL_MS = 5000;
const SYNC_CHECK_RESPONSE_MS = 750;
const SYNC_ADJUST_THRESHOLD_SECONDS = 0.01;
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
  room.users.set(socket.id, { id: socket.id, name, ip, ping: null, pings: [], syncStatus: "Joining", seekTime: null, adjustedCycle: null });
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
      const oneWayPing = Math.round(nextPing / 2);
      user.pings.push(oneWayPing);
      user.pings = user.pings.slice(-2);
      user.ping = Math.round(user.pings.reduce((sum, value) => sum + value, 0) / user.pings.length);
    }
    broadcastUsers(roomId);
  });

  socket.on("playbackPosition", (position) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    const time = Number(position?.time);
    user.seekTime = Number.isFinite(time) ? Math.max(0, time) : null;
    user.position = {
      itemId: typeof position?.itemId === "string" ? position.itemId : null,
      playing: Boolean(position?.playing),
      time: user.seekTime,
      receivedAt: Date.now(),
      cycle: Number.isInteger(position?.cycle) ? position.cycle : room.adjustmentCycle,
    };
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
    if (!room.playback.itemId && room.playlist[0]) {
      room.playback = { itemId: room.playlist[0].id, playing: false, time: 0, updatedAt: Date.now() };
    }
    if (room.playback.itemId && !room.playlist.some((item) => item.id === room.playback.itemId)) {
      room.playback = { ...room.playback, playing: false, updatedAt: Date.now() };
    }
    broadcastPlaylist(roomId, room);
    schedulePlayback(roomId, room, room.playback);
  });

  socket.on("playback", (playback) => {
    const requestedItem = typeof playback.itemId === "string" ? playback.itemId : room.playback.itemId;
    const nextPlaying = Boolean(playback.playing);
    const nextItemId = room.playlist.some((item) => item.id === requestedItem) ? requestedItem : room.playback.itemId;
    const startsPlaybackCycle = nextPlaying && (!room.playback.playing || nextItemId !== room.playback.itemId);
    if (startsPlaybackCycle) {
      room.adjustmentCycle += 1;
      for (const user of room.users.values()) user.adjustedCycle = null;
    }
    room.playback = {
      itemId: nextItemId,
      playing: nextPlaying,
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
setInterval(checkRoomSync, SYNC_CHECK_INTERVAL_MS);
function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { playlist: [], playback: { itemId: null, playing: false, time: 0, updatedAt: Date.now() }, users: new Map(), playbackTimers: [], adjustmentCycle: 0 };
    rooms.set(id, room);
  }
  return room;
}
function serializeForSocket(room, socketId) { return { playlist: room.playlist, playback: playbackForUser(room, socketId), users: publicUsers(room) }; }
function publicUsers(room) { return [...room.users.values()].map(({ id, name, ip, ping, syncStatus, seekTime }) => ({ id, name, ip, ping, syncStatus, seekTime })); }
function broadcastUsers(roomId) { const room = rooms.get(roomId); if (room) io.to(roomId).emit("users", publicUsers(room)); }
function broadcastPlaylist(roomId, room) { io.to(roomId).emit("playlist", room.playlist); }
function schedulePlayback(roomId, room, basePlayback, originId = null) {
  clearPlaybackTimers(room);
  const usersByPing = [...room.users.values()].sort((a, b) => (b.ping || 0) - (a.ping || 0));
  const maxOneWayPing = usersByPing[0]?.ping || 0;
  if (basePlayback.playing) basePlayback.updatedAt = Date.now() + maxOneWayPing;

  for (const user of usersByPing) {
    const userOneWayPing = user.ping || 0;
    const sendDelayMs = basePlayback.playing ? Math.max(0, maxOneWayPing - userOneWayPing) : 0;
    const sendPlayback = () => {
      if (!rooms.get(roomId)?.users.has(user.id)) return;
      io.to(user.id).emit("playback", playbackForUser(room, user.id, basePlayback, originId, true));
    };

    if (sendDelayMs === 0) sendPlayback();
    else room.playbackTimers.push(setTimeout(sendPlayback, sendDelayMs));
  }
}
function playbackForUser(room, socketId, basePlayback = room.playback, originId = null, isScheduledPlayback = false) {
  const user = room.users.get(socketId);
  const now = Date.now();
  const elapsedMs = basePlayback.playing && !isScheduledPlayback ? Math.max(0, now - basePlayback.updatedAt + (user?.ping || 0)) : 0;
  return {
    ...basePlayback,
    originId,
    time: Math.max(0, basePlayback.time + elapsedMs / 1000),
    updatedAt: now,
  };
}
function checkRoomSync() {
  const startedAt = Date.now();
  for (const [roomId, room] of rooms) {
    if (!room.playback.playing || !room.playback.itemId || room.users.size < 2) continue;
    io.to(roomId).emit("syncCheck", { itemId: room.playback.itemId, cycle: room.adjustmentCycle });
    setTimeout(() => adjustRoomSync(roomId, startedAt, room.adjustmentCycle, room.playback.itemId), SYNC_CHECK_RESPONSE_MS);
  }
}
function adjustRoomSync(roomId, checkStartedAt, cycle, itemId) {
  const room = rooms.get(roomId);
  if (!room || !room.playback.playing || room.playback.itemId !== itemId || room.adjustmentCycle !== cycle) return;
  const positions = [...room.users.values()]
    .map((user) => ({ user, position: user.position, currentTime: adjustedPositionTime(user, checkStartedAt, cycle, itemId) }))
    .filter((entry) => Number.isFinite(entry.currentTime));
  if (positions.length < 2) return;
  const furthestTime = Math.max(...positions.map((entry) => entry.currentTime));
  for (const { user, currentTime } of positions) {
    if (user.adjustedCycle === cycle) continue;
    const skipAhead = furthestTime - currentTime;
    if (skipAhead <= SYNC_ADJUST_THRESHOLD_SECONDS) continue;
    user.adjustedCycle = cycle;
    io.to(user.id).emit("syncAdjustment", { itemId, cycle, skipAhead });
  }
}
function adjustedPositionTime(user, checkStartedAt, cycle, itemId) {
  const position = user.position;
  if (!position || position.cycle !== cycle || position.itemId !== itemId || !Number.isFinite(position.time)) return NaN;
  if (position.receivedAt < checkStartedAt) return NaN;
  const receiveDelaySeconds = (user.ping || 0) / 1000;
  const elapsedSinceReceiveSeconds = position.playing ? Math.max(0, Date.now() - position.receivedAt) / 1000 : 0;
  return Math.max(0, position.time + receiveDelaySeconds + elapsedSinceReceiveSeconds);
}
function clearPlaybackTimers(room) {
  for (const timer of room.playbackTimers || []) clearTimeout(timer);
  room.playbackTimers = [];
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
