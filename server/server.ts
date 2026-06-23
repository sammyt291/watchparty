import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import http from "node:http";
import { Server } from "socket.io";
import config from "./config.ts";

type PlaylistItem = {
  id: string;
  url: string;
  provider: "youtube" | "facebook" | "unknown";
  title: string;
  thumbnail?: string;
  duration?: string;
  views?: string;
};

type UserInfo = { id: string; name: string; ip: string; ping: number | null };
type Playback = { itemId: string | null; playing: boolean; time: number; updatedAt: number };
type RoomState = { playlist: PlaylistItem[]; playback: Playback; users: Map<string, UserInfo> };

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: {}, transports: ["websocket", "polling"] });
const rooms = new Map<string, RoomState>();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());
app.get("/ping", (_req, res) => { res.json("pong"); });
app.get("/api/metadata", async (req, res) => {
  const url = String(req.query.url ?? "");
  res.json(await getMetadata(url));
});

const buildPath = path.resolve(__dirname, "..", config.BUILD_DIRECTORY);
const indexPath = path.join(buildPath, "index.html");
const hasClientBuild = fs.existsSync(indexPath);

app.use(express.static(buildPath));
app.get(/.*/, (_req, res) => {
  if (!hasClientBuild) {
    res.status(503).send(
      `Client build not found at ${indexPath}. Run "npm run build" before "npm start", or use "npm run dev" during development.`,
    );
    return;
  }

  res.sendFile(indexPath);
});

io.on("connection", (socket) => {
  const roomId = safeRoomId(String(socket.handshake.query.roomId ?? ""));
  if (!roomId) return socket.disconnect(true);

  const room = getRoom(roomId);
  const ip = getIp(socket.handshake.address);
  const name = safeName(String(socket.handshake.query.name ?? ""));
  room.users.set(socket.id, { id: socket.id, name, ip, ping: null });
  socket.join(roomId);
  socket.emit("state", serialize(room));
  broadcastUsers(roomId);
  logRooms();

  socket.on("setName", (nextName: string) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    user.name = safeName(nextName);
    broadcastUsers(roomId);
    logRooms();
  });

  socket.on("clientPing", () => socket.emit("serverPong"));

  socket.on("pongMs", (ping: number) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    user.ping = Number.isFinite(ping) ? Math.max(0, Math.round(ping)) : null;
    broadcastUsers(roomId);
  });

  socket.on("playlist", (playlist: PlaylistItem[]) => {
    room.playlist = playlist.map(cleanItem).filter(Boolean) as PlaylistItem[];
    if (!room.playback.itemId && room.playlist[0]) room.playback.itemId = room.playlist[0].id;
    io.to(roomId).emit("playlist", room.playlist);
    io.to(roomId).emit("playback", room.playback);
  });

  socket.on("playback", (playback: Partial<Playback>) => {
    room.playback = {
      itemId: typeof playback.itemId === "string" ? playback.itemId : room.playback.itemId,
      playing: Boolean(playback.playing),
      time: Number.isFinite(playback.time) ? Number(playback.time) : room.playback.time,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit("playback", room.playback);
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

function getRoom(id: string): RoomState {
  let room = rooms.get(id);
  if (!room) {
    room = { playlist: [], playback: { itemId: null, playing: false, time: 0, updatedAt: Date.now() }, users: new Map() };
    rooms.set(id, room);
  }
  return room;
}
function serialize(room: RoomState) { return { playlist: room.playlist, playback: room.playback, users: [...room.users.values()] }; }
function broadcastUsers(roomId: string) { io.to(roomId).emit("users", [...(rooms.get(roomId)?.users.values() ?? [])]); }
function logRooms() {
  console.clear();
  console.log("Rooms");
  for (const [roomId, room] of rooms) {
    console.log(roomId);
    for (const user of room.users.values()) console.log(`\t${user.ip}\t${user.name}`);
  }
}
function safeRoomId(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }
function safeName(value: string) { return value.replace(/[\t\n\r]/g, " ").trim().slice(0, 32) || "Quiet Otter"; }
function getIp(address: string) { return address.replace(/^::ffff:/, ""); }
function cleanItem(item: PlaylistItem) { return item?.id && item?.url ? { ...item, title: item.title || item.url } : null; }
function provider(url: string): PlaylistItem["provider"] {
  if (/youtu\.be|youtube\.com/i.test(url)) return "youtube";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  return "unknown";
}
async function getMetadata(url: string): Promise<Omit<PlaylistItem, "id">> {
  const base = { url, provider: provider(url), title: url };
  if (base.provider !== "youtube") return base;
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!response.ok) return base;
    const data = (await response.json()) as { title?: string; thumbnail_url?: string };
    return { ...base, title: data.title ?? url, thumbnail: data.thumbnail_url };
  } catch {
    return base;
  }
}
