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
const SYNC_CHECK_INTERVAL_MS = 1000;
const SYNC_TARGET_TOLERANCE_MS = 50;
const MAX_SYNC_ADJUSTMENT_ATTEMPTS = 5;
const SYNC_ADJUSTMENT_GAIN = 1;
const SYNC_ADJUSTMENT_WORSENING_GAIN = 0.45;
const SYNC_ADJUSTMENT_SIGN_FLIP_GAIN = 0.6;
const SYNC_ADJUSTMENT_MAX_STEP_SECONDS = 2;
const SYNC_ADJUSTMENT_LARGE_OFFSET_SECONDS = 2;
const SYNC_LATENCY_UNCERTAINTY_FACTOR = 1;
const PLAYBACK_START_SAFETY_MARGIN_MS = 50;
const POST_PLAYBACK_SYNC_SETTLE_MS = 250;
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
  room.users.set(socket.id, { id: socket.id, name, ip, ping: null, pings: [], syncStatus: "Joining", seekTime: null, seekOffset: null, adjustedCycle: null, adjustedAttempt: 0, syncHistory: null, syncSettled: false });
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
      attempt: Number.isInteger(position?.attempt) ? position.attempt : room.adjustmentAttempt,
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
      room.adjustmentAttempt = 0;
      room.syncCheckInProgress = false;
      room.syncAnchorUserId = socket.id;
      room.syncReferenceUserId = socket.id;
      for (const user of room.users.values()) {
        user.syncSettled = false;
        user.adjustedCycle = null;
        user.adjustedAttempt = 0;
        user.seekOffset = null;
        user.syncHistory = null;
      }
    }
    room.playback = {
      itemId: nextItemId,
      playing: nextPlaying,
      time: Number.isFinite(playback.time) ? Math.max(0, Number(playback.time)) : room.playback.time,
      updatedAt: Date.now(),
    };
    if (startsPlaybackCycle) broadcastUsers(roomId);
    if (!nextPlaying && room.playback.itemId) {
      room.syncCheckInProgress = false;
      room.syncAnchorUserId = null;
      room.syncReferenceUserId = null;
      markRoomPausedInSync(room);
      broadcastUsers(roomId);
    }
    schedulePlayback(roomId, room, room.playback, socket.id);
  });

  socket.on("disconnect", () => {
    room.users.delete(socket.id);
    if (room.users.size === 0) rooms.delete(roomId);
    else {
      if (room.syncAnchorUserId === socket.id) room.syncAnchorUserId = null;
      if (room.syncReferenceUserId === socket.id) room.syncReferenceUserId = null;
      broadcastUsers(roomId);
    }
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
    room = { playlist: [], playback: { itemId: null, playing: false, time: 0, updatedAt: Date.now() }, users: new Map(), playbackTimers: [], syncCheckTimer: null, adjustmentCycle: 0, adjustmentAttempt: 0, syncCheckInProgress: false, syncAnchorUserId: null, syncReferenceUserId: null };
    rooms.set(id, room);
  }
  return room;
}
function serializeForSocket(room, socketId) { return { playlist: room.playlist, playback: playbackForUser(room, socketId), users: publicUsers(room) }; }
function publicUsers(room) { return [...room.users.values()].map(({ id, name, ip, ping, syncStatus, seekTime, seekOffset }) => ({ id, name, ip, ping, syncStatus, seekTime, seekOffset })); }
function broadcastUsers(roomId) { const room = rooms.get(roomId); if (room) io.to(roomId).emit("users", publicUsers(room)); }
function broadcastPlaylist(roomId, room) { io.to(roomId).emit("playlist", room.playlist); }
function schedulePlayback(roomId, room, basePlayback, originId = null) {
  clearPlaybackTimers(room);
  const usersByPing = [...room.users.values()].sort((a, b) => (b.ping || 0) - (a.ping || 0));
  const maxOneWayPing = usersByPing[0]?.ping || 0;
  const scheduledStartAt = basePlayback.playing ? Date.now() + maxOneWayPing + PLAYBACK_START_SAFETY_MARGIN_MS : null;
  if (basePlayback.playing) basePlayback.updatedAt = scheduledStartAt;

  for (const user of usersByPing) {
    const userOneWayPing = user.ping || 0;
    const sendDelayMs = basePlayback.playing ? Math.max(0, scheduledStartAt - Date.now() - userOneWayPing) : 0;
    const sendPlayback = () => {
      if (!rooms.get(roomId)?.users.has(user.id)) return;
      const remainingStartDelayMs = basePlayback.playing ? Math.max(0, scheduledStartAt - Date.now() - userOneWayPing) : 0;
      io.to(user.id).emit("playback", playbackForUser(room, user.id, basePlayback, originId, true, remainingStartDelayMs));
    };

    if (sendDelayMs === 0) sendPlayback();
    else room.playbackTimers.push(setTimeout(sendPlayback, sendDelayMs));
  }

  if (basePlayback.playing) schedulePostPlaybackSyncCheck(roomId, room, maxOneWayPing);
}
function playbackForUser(room, socketId, basePlayback = room.playback, originId = null, isScheduledPlayback = false, startDelayMs = 0) {
  const user = room.users.get(socketId);
  const now = Date.now();
  const elapsedMs = basePlayback.playing && !isScheduledPlayback ? Math.max(0, now - basePlayback.updatedAt + (user?.ping || 0)) : 0;
  return {
    ...basePlayback,
    originId,
    time: Math.max(0, basePlayback.time + elapsedMs / 1000),
    updatedAt: now + Math.max(0, Math.round(startDelayMs)),
    startDelayMs: Math.max(0, Math.round(startDelayMs)),
  };
}
function markPlaybackOriginInSync(room, socketId) {
  const user = room.users.get(socketId);
  if (!user) return;
  user.seekTime = room.playback.time;
  user.seekOffset = 0;
  user.syncStatus = "Sync";
  user.syncSettled = true;
  user.position = {
    itemId: room.playback.itemId,
    playing: room.playback.playing,
    time: room.playback.time,
    receivedAt: Date.now(),
    cycle: room.adjustmentCycle,
    attempt: room.adjustmentAttempt,
  };
}
function markRoomPausedInSync(room) {
  for (const user of room.users.values()) {
    user.seekTime = room.playback.time;
    user.seekOffset = 0;
    user.syncStatus = "Sync";
    user.position = {
      itemId: room.playback.itemId,
      playing: false,
      time: room.playback.time,
      receivedAt: Date.now(),
      cycle: room.adjustmentCycle,
      attempt: room.adjustmentAttempt,
    };
  }
}

function checkRoomSync() {
  const startedAt = Date.now();
  for (const [roomId, room] of rooms) {
    if (!room.playback.playing || !room.playback.itemId || room.users.size < 2 || room.syncCheckInProgress || roomUsersAreSyncSettled(room) || roomHasNoSyncUser(room)) continue;
    room.adjustmentAttempt = 0;
    room.syncCheckInProgress = true;
    for (const user of room.users.values()) {
      user.adjustedCycle = null;
      user.adjustedAttempt = 0;
      user.syncHistory = null;
    }
    room.syncReferenceUserId = room.syncAnchorUserId;
    io.to(roomId).emit("syncCheck", { itemId: room.playback.itemId, cycle: room.adjustmentCycle, attempt: room.adjustmentAttempt });
    setTimeout(() => adjustRoomSync(roomId, startedAt, room.adjustmentCycle, room.adjustmentAttempt, room.playback.itemId), 750);
  }
}
function adjustRoomSync(roomId, checkStartedAt, cycle, attempt, itemId) {
  const room = rooms.get(roomId);
  if (!room || !room.playback.playing || room.playback.itemId !== itemId || room.adjustmentCycle !== cycle || room.adjustmentAttempt !== attempt) return;
  const positions = [...room.users.values()]
    .map((user) => ({ user, position: user.position, currentTime: adjustedPositionTime(user, checkStartedAt, cycle, attempt, itemId) }))
    .filter((entry) => Number.isFinite(entry.currentTime));
  if (positions.length < 2) {
    room.syncCheckInProgress = false;
    return;
  }
  const targetTime = syncTargetTime(room, positions);
  let adjusted = false;
  for (const { user, currentTime } of positions) {
    const offset = currentTime - targetTime;
    user.seekOffset = offset;
    const measurement = recordSyncMeasurement(user, cycle, attempt, offset);
    const seekDelta = -offset;
    if (Math.abs(seekDelta) <= syncToleranceSecondsForUser(user)) {
      user.syncStatus = "Sync";
      user.syncSettled = true;
      continue;
    }
    if (user.adjustedCycle === cycle && user.adjustedAttempt >= attempt + 1) continue;
    if (attempt >= MAX_SYNC_ADJUSTMENT_ATTEMPTS) {
      user.syncStatus = "No Sync";
      continue;
    }
    user.syncStatus = "Syncing";
    user.syncSettled = false;
    user.adjustedCycle = cycle;
    user.adjustedAttempt = attempt + 1;
    adjusted = true;
    const requestedSeekDelta = computeSyncAdjustment(user, seekDelta);
    if (measurement) measurement.nextRequestedSeekDelta = requestedSeekDelta;
    io.to(user.id).emit("syncAdjustment", { itemId, cycle, attempt: attempt + 1, seekDelta: requestedSeekDelta, skipAhead: Math.max(0, requestedSeekDelta) });
  }
  broadcastUsers(roomId);
  if (adjusted) recheckRoomSync(roomId, cycle, attempt + 1, itemId);
  else {
    room.syncCheckInProgress = false;
    for (const { user } of positions) user.syncSettled = true;
  }
}
function recheckRoomSync(roomId, cycle, attempt, itemId) {
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (!room || !room.playback.playing || room.playback.itemId !== itemId || room.adjustmentCycle !== cycle) return;
    if (room.adjustmentAttempt !== attempt - 1) {
      room.syncCheckInProgress = false;
      return;
    }
    room.adjustmentAttempt = attempt;
    const startedAt = Date.now();
    io.to(roomId).emit("syncCheck", { itemId, cycle, attempt });
    setTimeout(() => adjustRoomSync(roomId, startedAt, cycle, attempt, itemId), 750);
  }, 900);
}

function secondsFromMs(ms) { return ms / 1000; }
function syncToleranceSecondsForUser(user) {
  const latencyUncertaintyMs = Number.isFinite(user?.ping) ? user.ping * SYNC_LATENCY_UNCERTAINTY_FACTOR : 0;
  return secondsFromMs(SYNC_TARGET_TOLERANCE_MS + latencyUncertaintyMs);
}
function syncTargetTime(room, positions) {
  const existingReference = positions.find(({ user }) => user.id === room.syncReferenceUserId);
  if (existingReference) return existingReference.currentTime;

  const anchorPosition = positions.find(({ user }) => user.id === room.syncAnchorUserId && user.syncSettled && user.syncStatus === "Sync");
  if (anchorPosition) {
    room.syncReferenceUserId = anchorPosition.user.id;
    return anchorPosition.currentTime;
  }

  const settledPosition = positions.find(({ user }) => user.syncSettled && user.syncStatus === "Sync");
  if (settledPosition) {
    room.syncReferenceUserId = settledPosition.user.id;
    return settledPosition.currentTime;
  }

  const leadingPosition = positions.reduce((leader, entry) => (entry.currentTime > leader.currentTime ? entry : leader), positions[0]);
  room.syncReferenceUserId = leadingPosition.user.id;
  return leadingPosition.currentTime;
}
function recordSyncMeasurement(user, cycle, attempt, offset) {
  if (!user.syncHistory || user.syncHistory.cycle !== cycle) {
    user.syncHistory = { cycle, measurements: [] };
  }

  const previousMeasurement = user.syncHistory.measurements[user.syncHistory.measurements.length - 1];
  const measurement = {
    attempt,
    offset,
    previousOffset: previousMeasurement?.offset ?? null,
  };
  user.syncHistory.measurements.push(measurement);
  user.syncHistory.measurements = user.syncHistory.measurements.slice(-MAX_SYNC_ADJUSTMENT_ATTEMPTS - 1);
  return measurement;
}
function computeSyncAdjustment(user, targetSeekDelta) {
  const measurements = user.syncHistory?.measurements || [];
  const measurement = measurements[measurements.length - 1];
  if (!measurement || !Number.isFinite(targetSeekDelta)) return targetSeekDelta;

  const previousOffset = Number.isFinite(measurement.previousOffset) ? measurement.previousOffset : null;
  const currentOffset = measurement.offset;
  const absTarget = Math.abs(targetSeekDelta);
  let gain = SYNC_ADJUSTMENT_GAIN;

  if (previousOffset != null) {
    const signFlipped = Math.sign(previousOffset) !== Math.sign(currentOffset);
    const gotWorse = Math.abs(currentOffset) > Math.abs(previousOffset);
    if (signFlipped) gain = Math.min(gain, SYNC_ADJUSTMENT_SIGN_FLIP_GAIN);
    if (gotWorse) gain = Math.min(gain, SYNC_ADJUSTMENT_WORSENING_GAIN);
  }

  const maxGain = absTarget < 0.25 ? 0.85 : 1;
  const effectiveGain = clamp(gain, 0, maxGain);
  const maxStep = syncAdjustmentMaxStepSeconds(absTarget, previousOffset != null);
  const requestedSeekDelta = Math.sign(targetSeekDelta) * Math.min(maxStep, absTarget * effectiveGain);
  measurement.adjustment = { gain: effectiveGain, configuredGain: gain, maxStep, requestedSeekDelta };
  return requestedSeekDelta;
}
function syncAdjustmentMaxStepSeconds(absTarget, hasPreviousMeasurement) {
  if (!Number.isFinite(absTarget)) return SYNC_ADJUSTMENT_MAX_STEP_SECONDS;
  if (absTarget >= SYNC_ADJUSTMENT_LARGE_OFFSET_SECONDS && !hasPreviousMeasurement) return absTarget;
  return Math.min(absTarget, Math.max(SYNC_ADJUSTMENT_MAX_STEP_SECONDS, absTarget * 0.75));
}
function roomUsersAreSyncSettled(room) {
  return [...room.users.values()].every((user) => user.syncSettled);
}
function roomHasNoSyncUser(room) {
  return [...room.users.values()].some((user) => user.syncStatus === "No Sync");
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function adjustedPositionTime(user, checkStartedAt, cycle, attempt, itemId) {
  const position = user.position;
  if (!position || position.cycle !== cycle || position.attempt !== attempt || position.itemId !== itemId || !Number.isFinite(position.time)) return NaN;
  if (position.receivedAt < checkStartedAt) return NaN;
  const receiveDelaySeconds = (user.ping || 0) / 1000;
  const elapsedSinceReceiveSeconds = position.playing ? Math.max(0, Date.now() - position.receivedAt) / 1000 : 0;
  return Math.max(0, position.time + receiveDelaySeconds + elapsedSinceReceiveSeconds);
}
function schedulePostPlaybackSyncCheck(roomId, room, maxOneWayPing) {
  if (room.syncCheckTimer) clearTimeout(room.syncCheckTimer);
  room.syncCheckTimer = setTimeout(() => {
    room.syncCheckTimer = null;
    checkRoomSync();
  }, maxOneWayPing + PLAYBACK_START_SAFETY_MARGIN_MS + POST_PLAYBACK_SYNC_SETTLE_MS);
}
function clearPlaybackTimers(room) {
  for (const timer of room.playbackTimers || []) clearTimeout(timer);
  room.playbackTimers = [];
  if (room.syncCheckTimer) clearTimeout(room.syncCheckTimer);
  room.syncCheckTimer = null;
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
function cleanSyncStatus(status) { return ["Pending", "Joining", "Syncing", "Sync", "No Sync"].includes(status) ? status : "Pending"; }
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
