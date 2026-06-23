const verbs = ["Brave", "Calm", "Dancing", "Flying", "Gentle", "Happy", "Lucky", "Mighty", "Swift", "Witty"];
const nouns = ["Badger", "Falcon", "Koala", "Otter", "Panda", "Raven", "Tiger", "Turtle", "Whale", "Wolf"];
const app = document.querySelector("#app");
const serverHost = location.origin;
const roomId = getRoomId();
let socket = null;
let playlist = [];
let playback = { itemId: null, playing: false, time: 0, updatedAt: Date.now() };
let users = [];
let ytPlayer = null;
let currentVideoId = null;
let ignorePlayerEvents = false;
let ytReady = false;
let pingStart = 0;
let pingSamples = [];
let playbackUnlocked = false;
let syncStatus = "Pending";
let syncTimer = null;

if (!roomId) renderSplash(); else renderRoom(roomId);

function renderSplash() {
  app.innerHTML = `<main class="splash"><h1>WatchParty</h1><section class="join"><form id="joinForm"><label>Enter a room ID</label><input id="roomInput" autofocus placeholder="room-id"/><button>Enter</button></form><div class="sep"><span></span><b>or</b><span></span></div><button id="newRoom" class="primary">New room</button></section></main>`;
  byId("joinForm").onsubmit = (event) => { event.preventDefault(); go(byId("roomInput").value); };
  byId("newRoom").onclick = () => go(Math.random().toString(36).slice(2, 8));
}
function renderRoom(id) {
  const saved = localStorage.getItem("watchparty:name");
  let name = saved || randomName();
  if (!saved) {
    name = prompt("Choose your display name", name) || name;
    localStorage.setItem("watchparty:name", name);
  }
  app.innerHTML = `<main class="room"><section class="stage"><div id="video" class="video"><div class="empty">Add a YouTube or Facebook video URL</div></div><div class="controls"><button id="playPause">Play</button><input id="seek" type="range" min="0" max="1000" value="0"/></div><div id="users" class="users"></div></section><aside class="playlist"><h2>Room ${escapeHtml(id)}</h2><input id="urlInput" placeholder="Paste URL and press Enter"/><div id="queue"></div></aside></main><div id="playbackGate" class="playback-gate" role="dialog" aria-modal="true" aria-labelledby="playbackGateTitle"><div class="playback-gate__panel"><h2 id="playbackGateTitle">Enable playback</h2><p>Your browser needs a click before shared room media can play.</p><button id="enablePlayback" class="primary">Enable</button></div></div>`;
  socket = io(serverHost, { query: { roomId: id, name } });
  socket.on("state", (state) => { playlist = state.playlist; playback = localPlayback(state.playback); users = state.users; setSyncStatus("Joining"); paintAll(); updatePlaybackGate(); });
  socket.on("playlist", (next) => { playlist = next; paintQueue(); loadCurrent(); });
  socket.on("playback", (next) => { const changed = next.itemId !== playback.itemId; playback = localPlayback(next); setSyncStatus("Syncing"); updatePlaybackGate(); if (changed) loadCurrent(); else applyPlayback(true); scheduleSyncedStatus(); });
  socket.on("users", (next) => { users = next; paintUsers(); });
  socket.on("serverPong", () => {
    const ping = Date.now() - pingStart;
    pingSamples.push(ping);
    pingSamples = pingSamples.slice(-10);
    socket?.emit("pongMs", ping);
    if (syncStatus === "Syncing" && pingSamples.length >= 3) applyFineSyncAdjustment();
  });
  setInterval(() => { pingStart = Date.now(); socket?.emit("clientPing"); }, 500);
  byId("playPause").onclick = togglePlay;
  byId("seek").oninput = seek;
  byId("urlInput").onkeydown = addUrl;
  byId("enablePlayback").onclick = unlockPlayback;
  updatePlaybackGate();
  loadYouTubeApi();
}
async function addUrl(event) {
  if (event.key !== "Enter") return;
  const input = event.currentTarget;
  const url = input.value.trim();
  if (!url) return;
  input.value = "";
  const meta = await (await fetch(`${serverHost}/api/metadata?url=${encodeURIComponent(url)}`)).json();
  playlist.push({ id: crypto.randomUUID(), ...meta });
  if (!playback.itemId) playback.itemId = playlist[0].id;
  emitPlaylist();
}
function paintAll() { paintQueue(); paintUsers(); loadCurrent(); }
function paintQueue() {
  byId("queue").innerHTML = playlist.map((item) => `<article class="card" draggable="true" data-id="${item.id}" data-current="${item.id === playback.itemId}">${item.thumbnail ? `<img src="${item.thumbnail}"/>` : ""}<div><b>${escapeHtml(item.title)}</b><small>${item.provider}${item.duration ? ` · ${item.duration}` : ""}${item.views ? ` · ${item.views}` : ""}</small></div><button data-del="${item.id}" aria-label="Remove">×</button></article>`).join("");
  document.querySelectorAll(".card").forEach((card) => {
    card.ondragstart = (e) => e.dataTransfer?.setData("text/plain", card.dataset.id);
    card.ondragover = (e) => { e.preventDefault(); card.classList.add("over"); };
    card.ondragleave = () => card.classList.remove("over");
    card.ondrop = (e) => reorder(e, card.dataset.id);
    card.onclick = () => playPlaylistItem(card.dataset.id);
  });
  document.querySelectorAll("[data-del]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); playlist = playlist.filter((i) => i.id !== button.dataset.del); if (playback.itemId === button.dataset.del) playback.itemId = playlist[0]?.id || null; emitPlaylist(); });
}
function paintUsers() {
  byId("users").innerHTML = users.map((u) => `<button class="user" data-own="${u.id === socket?.id}" data-sync="${escapeHtml(u.syncStatus || "Pending")}">${escapeHtml(u.name)}<small>${escapeHtml(u.syncStatus || "Pending")} · ${u.ping ?? "—"}ms</small>${u.id === socket?.id ? "✎" : ""}</button>`).join("");
  document.querySelector('[data-own="true"]')?.addEventListener("click", editName);
}
function loadCurrent() {
  const item = playlist.find((i) => i.id === playback.itemId);
  paintQueue();
  if (!item) return;
  if (item.provider === "youtube") loadYoutube(item.url);
  else if (item.provider === "facebook") { ytPlayer = null; currentVideoId = null; byId("video").innerHTML = `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(item.url)}&show_text=false" allow="autoplay; encrypted-media" allowfullscreen></iframe>`; }
}
function ensurePlayerHost(videoId) {
  const embedUrl = youtubeEmbedUrl(videoId);
  byId("video").innerHTML = `<iframe id="player" class="youtube-player" src="${escapeHtml(embedUrl)}" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" style="display: block;"></iframe>`;
}
function loadYoutube(url) {
  const id = youtubeId(url);
  if (!id || !window.YT?.Player) return;
  if (!ytPlayer) {
    ensurePlayerHost(id);
    currentVideoId = id;
    ytReady = false;
    ytPlayer = new window.YT.Player("player", { events: { onReady: onYouTubeReady, onStateChange: syncFromPlayer, onError: onYouTubeError } });
  } else if (currentVideoId !== id) {
    currentVideoId = id;
    withIgnoredPlayerEvents(() => {
      if (hasYtMethod("loadVideoById")) ytPlayer.loadVideoById(id, playback.time || 0);
      else if (hasYtMethod("cueVideoById")) ytPlayer.cueVideoById(id, playback.time || 0);
    });
    setTimeout(applyPlayback, 250);
  } else {
    applyPlayback();
  }
}
function onYouTubeReady() {
  ytReady = true;
  sizeYouTubeIframe();
  applyPlayback();
}
function applyPlayback(fineAdjust = false) {
  byId("playPause").textContent = playback.playing ? "Pause" : "Play";
  if (!ytReady || !isYouTubePlayer()) return;

  const t = playback.playing ? playback.time + (Date.now() - playback.updatedAt) / 1000 : playback.time;
  withIgnoredPlayerEvents(() => {
    if (hasYtMethod("seekTo") && (!fineAdjust || Math.abs(getYtTime() - t) > 0.12)) ytPlayer.seekTo(t, true);
    if (!playback.playing && hasYtMethod("pauseVideo")) ytPlayer.pauseVideo();
    if (playback.playing && playbackUnlocked && hasYtMethod("playVideo")) ytPlayer.playVideo();
  });
}
function syncFromPlayer(e) {
  sizeYouTubeIframe();
  if (ignorePlayerEvents) return;
  if (e.data === window.YT?.PlayerState.ENDED) emitPlayback(false, 0);
}
function onYouTubeError(e) {
  const item = playlist.find((i) => i.id === playback.itemId);
  const watchUrl = item?.url || (currentVideoId ? `https://www.youtube.com/watch?v=${currentVideoId}` : "https://www.youtube.com");
  byId("video").insertAdjacentHTML("beforeend", `<a class="youtube-fallback" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener">Open this video on YouTube</a>`);
  console.warn("YouTube player error", e?.data);
}
function togglePlay() { unlockPlayback(); emitPlayback(!playback.playing); }
function seek() { const duration = getYtDuration(); const time = (Number(byId("seek").value) / 1000) * duration; emitPlayback(playback.playing, time); }
setInterval(() => { const d = getYtDuration(); if (d) byId("seek").value = String((getYtTime() / d) * 1000); }, 500);
function emitPlaylist() { socket?.emit("playlist", playlist); paintQueue(); loadCurrent(); }
function emitPlayback(playing = playback.playing, time = getYtTime() || playback.time, itemId = playback.itemId) { setSyncStatus("Pending"); socket?.emit("playback", { itemId, playing, time }); }
function playPlaylistItem(itemId) { if (!itemId || itemId === playback.itemId) return; unlockPlayback(); emitPlayback(true, 0, itemId); }
function reorder(event, targetId) { event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer?.getData("text/plain"); if (!id || id === targetId) return; const dragged = playlist.find((i) => i.id === id); playlist = playlist.filter((i) => i.id !== id); playlist.splice(playlist.findIndex((i) => i.id === targetId), 0, dragged); emitPlaylist(); }
function editName() { const next = prompt("Edit your display name", localStorage.getItem("watchparty:name") || ""); if (next) { localStorage.setItem("watchparty:name", next); socket?.emit("setName", next); } }
function unlockPlayback() { playbackUnlocked = true; updatePlaybackGate(); applyPlayback(); }
function updatePlaybackGate() { byId("playbackGate")?.classList.toggle("is-hidden", playbackUnlocked || (!playback.playing && !playback.itemId)); }
function localPlayback(next) { return { ...next, updatedAt: Date.now() }; }
function avgPing() { return pingSamples.length ? pingSamples.reduce((sum, value) => sum + value, 0) / pingSamples.length : 0; }
function applyFineSyncAdjustment() { applyPlayback(true); scheduleSyncedStatus(); }
function scheduleSyncedStatus() { clearTimeout(syncTimer); syncTimer = setTimeout(() => setSyncStatus("Sync"), 700 + avgPing()); }
function setSyncStatus(status) { syncStatus = status; socket?.emit("syncStatus", status); const own = users.find((u) => u.id === socket?.id); if (own) own.syncStatus = status; paintUsers(); }
function withIgnoredPlayerEvents(callback) { ignorePlayerEvents = true; callback(); setTimeout(() => { ignorePlayerEvents = false; }, 1000); }
function isYouTubePlayer() { return ytPlayer && typeof ytPlayer === "object" && hasYtMethod("getIframe"); }
function hasYtMethod(method) { return typeof ytPlayer?.[method] === "function"; }
function getYtDuration() { return hasYtMethod("getDuration") ? ytPlayer.getDuration() || 0 : 0; }
function getYtTime() { return hasYtMethod("getCurrentTime") ? ytPlayer.getCurrentTime() || 0 : 0; }
function sizeYouTubeIframe() {
  const iframe = hasYtMethod("getIframe") ? ytPlayer.getIframe() : byId("player")?.querySelector("iframe");
  if (!iframe) return;
  iframe.classList.add("youtube-iframe");
  iframe.style.display = "block";
  iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  iframe.setAttribute("allowfullscreen", "");
  iframe.removeAttribute("width");
  iframe.removeAttribute("height");
}
function getRoomId() { return location.pathname.match(/^\/watch\/([^/]+)/)?.[1] || location.pathname.match(/^\/r\/([^/]+)/)?.[1] || ""; }
function go(id) { location.href = `/watch/${id.replace(/[^a-zA-Z0-9_-]/g, "")}`; }
function byId(id) { return document.getElementById(id); }
function randomName() { return `${verbs[Math.floor(Math.random() * verbs.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`; }
function youtubeId(url) {
  const parsed = new URL(url);
  if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0] || "";
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(pathParts[0])) return pathParts[1] || "";
  return parsed.searchParams.get("v") || "";
}
function youtubeEmbedUrl(videoId) {
  const params = new URLSearchParams({
    enablejsapi: "1",
    origin: location.origin,
    playsinline: "1",
    rel: "0",
    controls: "0",
  });
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params}`;
}
function loadYouTubeApi() { if (window.YT?.Player) return loadCurrent(); const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); window.onYouTubeIframeAPIReady = loadCurrent; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
