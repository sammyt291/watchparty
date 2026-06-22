import { io, Socket } from "socket.io-client";
import "./style.css";

type Provider = "youtube" | "facebook" | "unknown";
type PlaylistItem = { id: string; url: string; provider: Provider; title: string; thumbnail?: string; duration?: string; views?: string };
type UserInfo = { id: string; name: string; ping: number | null };
type Playback = { itemId: string | null; playing: boolean; time: number; updatedAt: number };

declare global { interface Window { YT?: typeof YT; onYouTubeIframeAPIReady?: () => void; FB?: { XFBML: { parse: (el?: HTMLElement) => void } } } }

const verbs = ["Brave", "Calm", "Dancing", "Flying", "Gentle", "Happy", "Lucky", "Mighty", "Swift", "Witty"];
const nouns = ["Badger", "Falcon", "Koala", "Otter", "Panda", "Raven", "Tiger", "Turtle", "Whale", "Wolf"];
const app = document.querySelector<HTMLDivElement>("#app")!;
const roomId = getRoomId();
let socket: Socket | null = null;
let playlist: PlaylistItem[] = [];
let playback: Playback = { itemId: null, playing: false, time: 0, updatedAt: Date.now() };
let users: UserInfo[] = [];
let ytPlayer: YT.Player | null = null;
let suppress = false;
let pingStart = 0;

if (!roomId) renderSplash(); else renderRoom(roomId);

function renderSplash() {
  app.innerHTML = `<main class="splash"><h1>WatchParty</h1><section class="join"><form id="joinForm"><label>Enter a room ID</label><input id="roomInput" autofocus placeholder="room-id"/><button>Enter</button></form><div class="sep"><span></span><b>or</b><span></span></div><button id="newRoom" class="primary">New room</button></section></main>`;
  byId<HTMLFormElement>("joinForm").onsubmit = (event) => { event.preventDefault(); go(byId<HTMLInputElement>("roomInput").value); };
  byId<HTMLButtonElement>("newRoom").onclick = () => go(Math.random().toString(36).slice(2, 8));
}
function renderRoom(id: string) {
  const saved = localStorage.getItem("watchparty:name");
  let name = saved || randomName();
  if (!saved) {
    name = prompt("Choose your display name", name) || name;
    localStorage.setItem("watchparty:name", name);
  }
  app.innerHTML = `<main class="room"><section class="stage"><div id="video" class="video"><div class="empty">Add a YouTube or Facebook video URL</div></div><div class="controls"><button id="playPause">Play</button><input id="seek" type="range" min="0" max="1000" value="0"/></div><div id="users" class="users"></div></section><aside class="playlist"><h2>Room ${id}</h2><input id="urlInput" placeholder="Paste URL and press Enter"/><div id="queue"></div></aside></main>`;
  socket = io({ query: { roomId: id, name } });
  socket.on("state", (state: { playlist: PlaylistItem[]; playback: Playback; users: UserInfo[] }) => { playlist = state.playlist; playback = state.playback; users = state.users; paintAll(); });
  socket.on("playlist", (next) => { playlist = next; paintQueue(); loadCurrent(); });
  socket.on("playback", (next) => { playback = next; applyPlayback(); });
  socket.on("users", (next) => { users = next; paintUsers(); });
  socket.on("serverPong", () => socket?.emit("pongMs", Date.now() - pingStart));
  setInterval(() => { pingStart = Date.now(); socket?.emit("clientPing"); }, 3000);
  byId<HTMLButtonElement>("playPause").onclick = togglePlay;
  byId<HTMLInputElement>("seek").oninput = seek;
  byId<HTMLInputElement>("urlInput").onkeydown = addUrl;
  loadYouTubeApi();
}
async function addUrl(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  const input = event.currentTarget as HTMLInputElement;
  const url = input.value.trim();
  if (!url) return;
  input.value = "";
  const meta = await (await fetch(`/api/metadata?url=${encodeURIComponent(url)}`)).json() as Omit<PlaylistItem, "id">;
  playlist.push({ id: crypto.randomUUID(), ...meta });
  if (!playback.itemId) playback.itemId = playlist[0].id;
  emitPlaylist();
}
function paintAll() { paintQueue(); paintUsers(); loadCurrent(); }
function paintQueue() {
  byId("queue").innerHTML = playlist.map((item) => `<article class="card" draggable="true" data-id="${item.id}">${item.thumbnail ? `<img src="${item.thumbnail}"/>` : ""}<div><b>${escapeHtml(item.title)}</b><small>${item.provider}${item.duration ? ` · ${item.duration}` : ""}${item.views ? ` · ${item.views}` : ""}</small></div><button data-del="${item.id}">×</button></article>`).join("");
  document.querySelectorAll<HTMLElement>(".card").forEach((card) => {
    card.ondragstart = (e) => e.dataTransfer?.setData("text/plain", card.dataset.id!);
    card.ondragover = (e) => { e.preventDefault(); card.classList.add("over"); };
    card.ondragleave = () => card.classList.remove("over");
    card.ondrop = (e) => reorder(e, card.dataset.id!);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((button) => button.onclick = () => { playlist = playlist.filter((i) => i.id !== button.dataset.del); if (playback.itemId === button.dataset.del) playback.itemId = playlist[0]?.id ?? null; emitPlaylist(); });
}
function paintUsers() { byId("users").innerHTML = users.map((u) => `<button class="user" data-own="${u.id === socket?.id}">${escapeHtml(u.name)}<small>${u.ping ?? "—"}ms</small>${u.id === socket?.id ? "✎" : ""}</button>`).join(""); document.querySelector<HTMLButtonElement>('[data-own="true"]')?.addEventListener("click", editName); }
function loadCurrent() {
  const item = playlist.find((i) => i.id === playback.itemId);
  if (!item) return;
  if (item.provider === "youtube") loadYoutube(item.url);
  else if (item.provider === "facebook") byId("video").innerHTML = `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(item.url)}&show_text=false" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
}
function loadYoutube(url: string) { const id = youtubeId(url); if (!id || !window.YT?.Player) return; if (!ytPlayer) ytPlayer = new window.YT.Player("video", { videoId: id, playerVars: { controls: 0, rel: 0 }, events: { onReady: applyPlayback, onStateChange: syncFromPlayer } }); else ytPlayer.cueVideoById(id, playback.time); }
function applyPlayback() { const t = playback.playing ? playback.time + (Date.now() - playback.updatedAt) / 1000 : playback.time; suppress = true; ytPlayer?.seekTo(t, true); playback.playing ? ytPlayer?.playVideo() : ytPlayer?.pauseVideo(); byId<HTMLButtonElement>("playPause").textContent = playback.playing ? "Pause" : "Play"; suppress = false; }
function syncFromPlayer(e: YT.OnStateChangeEvent) { if (suppress) return; if (e.data === window.YT?.PlayerState.PLAYING || e.data === window.YT?.PlayerState.PAUSED) emitPlayback(e.data === window.YT.PlayerState.PLAYING); }
function togglePlay() { emitPlayback(!playback.playing); }
function seek() { const duration = ytPlayer?.getDuration() || 0; const time = (Number(byId<HTMLInputElement>("seek").value) / 1000) * duration; emitPlayback(playback.playing, time); }
setInterval(() => { const d = ytPlayer?.getDuration() || 0; if (d) byId<HTMLInputElement>("seek").value = String(((ytPlayer?.getCurrentTime() || 0) / d) * 1000); }, 500);
function emitPlaylist() { socket?.emit("playlist", playlist); paintQueue(); loadCurrent(); }
function emitPlayback(playing = playback.playing, time = ytPlayer?.getCurrentTime() ?? playback.time) { playback = { ...playback, playing, time, updatedAt: Date.now() }; socket?.emit("playback", playback); applyPlayback(); }
function reorder(event: DragEvent, targetId: string) { event.preventDefault(); const id = event.dataTransfer?.getData("text/plain"); if (!id || id === targetId) return; const dragged = playlist.find((i) => i.id === id)!; playlist = playlist.filter((i) => i.id !== id); playlist.splice(playlist.findIndex((i) => i.id === targetId), 0, dragged); emitPlaylist(); }
function editName() { const next = prompt("Edit your display name", localStorage.getItem("watchparty:name") || ""); if (next) { localStorage.setItem("watchparty:name", next); socket?.emit("setName", next); } }
function getRoomId() { return location.pathname.match(/^\/watch\/([^/]+)/)?.[1] || location.pathname.match(/^\/r\/([^/]+)/)?.[1] || ""; }
function go(id: string) { location.href = `/watch/${id.replace(/[^a-zA-Z0-9_-]/g, "")}`; }
function byId<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
function randomName() { return `${verbs[Math.floor(Math.random() * verbs.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`; }
function youtubeId(url: string) { return new URL(url).hostname.includes("youtu.be") ? new URL(url).pathname.slice(1) : new URL(url).searchParams.get("v"); }
function loadYouTubeApi() { if (window.YT) return; const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); window.onYouTubeIframeAPIReady = loadCurrent; }
function escapeHtml(value: string) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
