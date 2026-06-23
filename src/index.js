const verbs = ["Brave", "Calm", "Dancing", "Flying", "Gentle", "Happy", "Lucky", "Mighty", "Swift", "Witty"];
const nouns = ["Badger", "Falcon", "Koala", "Otter", "Panda", "Raven", "Tiger", "Turtle", "Whale", "Wolf"];
const app = document.querySelector("#app");
const LAN_HOST_ALIAS_SUFFIX = "sslip.io";
redirectIpHostToDnsAlias();
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
let pendingLocalPlaylist = false;
let syncAdjustmentCycle = null;
const VOLUME_STORAGE_KEY = "watchparty:volume";
let playerVolume = readStoredVolume();

if (!roomId) renderSplash(); else renderRoom(roomId);

function redirectIpHostToDnsAlias() {
  if (!isLanIpv4Host(location.hostname) || sessionStorage.getItem("watchparty:skipLanAliasRedirect") === "1") return;
  const alias = `${location.hostname.replaceAll(".", "-")}.${LAN_HOST_ALIAS_SUFFIX}`;
  location.replace(`${location.protocol}//${alias}${location.port ? `:${location.port}` : ""}${location.pathname}${location.search}${location.hash}`);
}
function isLanIpv4Host(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  if (parts[0] === 127 || parts[0] === 0) return false;
  return true;
}

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
  app.innerHTML = `<main class="room"><section class="stage"><div id="video" class="video"><div class="empty">Add a YouTube or Facebook video URL</div><div id="syncOverlay" class="sync-overlay is-hidden" aria-live="polite">Syncing playback…</div></div><div class="controls"><button id="playPause">Play</button><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Seek"/><input id="volume" type="range" min="0" max="100" value="50" aria-label="Volume" title="Volume"/></div><div id="users" class="users"></div></section><aside class="playlist"><h2>Room ${escapeHtml(id)}</h2><form id="urlForm" class="url-form"><input id="urlInput" placeholder="Paste URL and press Enter"/></form><div id="queue"></div></aside></main><div id="playbackGate" class="playback-gate" role="dialog" aria-modal="true" aria-labelledby="playbackGateTitle"><div class="playback-gate__panel"><h2 id="playbackGateTitle">Enable playback</h2><p>Your browser needs a click before shared room media can play.</p><button id="enablePlayback" class="primary">Enable</button></div></div>`;
  socket = io(serverHost, { query: { roomId: id, name } });
  socket.on("state", (state) => {
    if (!pendingLocalPlaylist) {
      playlist = state.playlist;
      playback = localPlayback(state.playback);
    }
    users = state.users;
    setSyncStatus("Joining");
    paintAll();
    updatePlaybackGate();
    if (pendingLocalPlaylist) emitPlaylist();
    if (!isPlaybackGateVisible()) beginSync();
  });
  socket.on("playlist", (next) => { pendingLocalPlaylist = false; playlist = next; paintQueue(); loadCurrent(); });
  socket.on("playback", (next) => { const wasPlaying = playback.playing; const changed = next.itemId !== playback.itemId; playback = localPlayback(next); updatePlaybackGate(); beginSync(); if (changed) loadCurrent(); else applyPlayback(true, { skipSeek: !wasPlaying && playback.playing }); });
  socket.on("users", (next) => { users = next; paintUsers(); });
  socket.on("syncCheck", (check) => {
    socket?.emit("playbackPosition", { itemId: playback.itemId, playing: playback.playing, time: getCurrentSeekTime(), cycle: check?.cycle });
  });
  socket.on("syncAdjustment", (adjustment) => {
    applyServerSyncAdjustment(adjustment);
  });
  socket.on("serverPong", () => {
    const ping = Date.now() - pingStart;
    pingSamples.push(ping);
    pingSamples = pingSamples.slice(-2);
    socket?.emit("pongMs", ping);
  });
  setInterval(() => { pingStart = Date.now(); socket?.emit("clientPing"); }, 500);
  byId("playPause").onclick = togglePlay;
  byId("seek").oninput = seek;
  byId("volume").value = String(playerVolume);
  byId("volume").oninput = changeVolume;
  byId("urlForm").onsubmit = handleUrlFormSubmit;
  byId("urlInput").onkeydown = handleUrlInputKeydown;
  byId("enablePlayback").onclick = unlockPlayback;
  updatePlaybackGate();
  loadYouTubeApi();
}
function handleUrlFormSubmit(event) {
  event.preventDefault();
  addUrl();
}
function handleUrlInputKeydown(event) {
  if (event.isComposing || (event.key !== "Enter" && event.code !== "Enter")) return;
  event.preventDefault();
  addUrl();
}
async function addUrl() {
  const input = byId("urlInput");
  const url = normalizeUrlInput(input.value);
  if (!url) return;

  const item = { id: createItemId(), url, provider: providerFromUrl(url), title: url };
  input.value = "";
  playlist.push(item);
  if (!playback.itemId) playback = { ...playback, itemId: item.id, playing: false, time: 0, updatedAt: Date.now() };
  emitPlaylist();

  try {
    const response = await fetch(`${serverHost}/api/metadata?url=${encodeURIComponent(url)}`);
    if (!response.ok) return;
    const meta = await response.json();
    playlist = playlist.map((current) => (current.id === item.id ? { ...current, ...meta, id: item.id, url } : current));
    emitPlaylist();
  } catch (error) {
    console.warn("Unable to load URL metadata", error);
  }
}
function createItemId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const randomPart = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
}

function paintAll() { paintQueue(); paintUsers(); loadCurrent(); }
function paintQueue() {
  byId("queue").innerHTML = playlist.map((item) => `<article class="card" draggable="true" data-id="${item.id}" data-current="${item.id === playback.itemId}">${item.thumbnail ? `<img src="${item.thumbnail}"/>` : ""}<div><button class="card-title" data-play="${item.id}" type="button">${escapeHtml(item.title)}</button><small>${item.provider}${item.duration ? ` · ${item.duration}` : ""}${item.views ? ` · ${item.views}` : ""}</small></div><button data-del="${item.id}" aria-label="Remove">×</button></article>`).join("");
  document.querySelectorAll(".card").forEach((card) => {
    card.ondragstart = (e) => e.dataTransfer?.setData("text/plain", card.dataset.id);
    card.ondragover = (e) => { e.preventDefault(); card.classList.add("over"); };
    card.ondragleave = () => card.classList.remove("over");
    card.ondrop = (e) => reorder(e, card.dataset.id);
  });
  document.querySelectorAll("[data-play]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); playPlaylistItem(button.dataset.play); });
  document.querySelectorAll("[data-del]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); playlist = playlist.filter((i) => i.id !== button.dataset.del); if (playback.itemId === button.dataset.del) playback = { ...playback, playing: false, updatedAt: Date.now() }; emitPlaylist(); });
}
function paintUsers() {
  byId("users").innerHTML = users.map((u) => `<button class="user" data-own="${u.id === socket?.id}" data-sync="${escapeHtml(u.syncStatus || "Pending")}"><span class="user-name">${escapeHtml(u.name)}${u.id === socket?.id ? " ✎" : ""}</span><small>${escapeHtml(u.syncStatus || "Pending")} · ${u.ping ?? "—"}ms</small><small class="user-time">${formatSeekTime(u.seekTime)}</small></button>`).join("");
  document.querySelector('[data-own="true"]')?.addEventListener("click", editName);
}
function loadCurrent() {
  const item = playlist.find((i) => i.id === playback.itemId);
  paintQueue();
  if (!item) { showEmptyVideo(); return; }
  if (item.provider === "youtube") loadYoutube(item.url);
  else if (item.provider === "facebook") { ytPlayer = null; currentVideoId = null; byId("video").innerHTML = `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(item.url)}&show_text=false" allow="autoplay; encrypted-media" allowfullscreen style="display: block;"></iframe>`; ensurePlayerIframesDisplayBlock(); ensureSyncOverlay(); }
}
function showEmptyVideo() {
  ytPlayer = null;
  currentVideoId = null;
  ytReady = false;
  byId("video").innerHTML = `<div class="empty">Add a YouTube or Facebook video URL</div>`;
  ensureSyncOverlay();
}
function ensurePlayerHost() {
  byId("video").innerHTML = `<div id="player" class="youtube-player-host" aria-label="YouTube video player"></div>`;
  ensureSyncOverlay();
}
function loadYoutube(url) {
  const id = youtubeId(url);
  if (!id || !window.YT?.Player) return;
  if (!ytPlayer) {
    ensurePlayerHost();
    currentVideoId = id;
    ytReady = false;
    ytPlayer = new window.YT.Player("player", {
      width: "100%",
      height: "100%",
      videoId: id,
      playerVars: youtubePlayerVars(),
      events: { onReady: onYouTubeReady, onStateChange: syncFromPlayer, onError: onYouTubeError },
    });
  } else if (currentVideoId !== id) {
    currentVideoId = id;
    withIgnoredPlayerEvents(() => {
      if (playback.playing && playbackUnlocked && hasYtMethod("loadVideoById")) ytPlayer.loadVideoById(id, targetPlaybackTime());
      else if (hasYtMethod("cueVideoById")) ytPlayer.cueVideoById(id, targetPlaybackTime());
    });
    setTimeout(applyPlayback, 250);
  } else {
    applyPlayback();
  }
}
function onYouTubeReady() {
  ytReady = true;
  sizeYouTubeIframe();
  setPlayerVolume();
  applyPlayback();
}
function applyPlayback(fineAdjust = false, options = {}) {
  byId("playPause").textContent = playback.playing ? "Pause" : "Play";
  if (!ytReady || !isYouTubePlayer()) return;

  const t = targetPlaybackTime();
  withIgnoredPlayerEvents(() => {
    if (!options.skipSeek && hasYtMethod("seekTo") && (!fineAdjust || Math.abs(getYtTime() - t) > 0.12)) ytPlayer.seekTo(t, true);
    if ((!playback.playing || !playbackUnlocked) && hasYtMethod("pauseVideo")) ytPlayer.pauseVideo();
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
function changeVolume() { playerVolume = Number(byId("volume").value); localStorage.setItem(VOLUME_STORAGE_KEY, String(playerVolume)); setPlayerVolume(); }
function setPlayerVolume() { if (hasYtMethod("setVolume")) ytPlayer.setVolume(playerVolume); }
setInterval(() => { const d = getYtDuration(); if (d) byId("seek").value = String((getYtTime() / d) * 1000); }, 500);
function emitPlaylist() { pendingLocalPlaylist = true; socket?.emit("playlist", playlist); paintQueue(); loadCurrent(); }
function emitPlayback(playing = playback.playing, time = getYtTime() || playback.time, itemId = playback.itemId) { setSyncStatus("Pending"); socket?.emit("playback", { itemId, playing, time }); }
function playPlaylistItem(itemId) { if (!itemId || itemId === playback.itemId) return; unlockPlayback(); emitPlayback(true, 0, itemId); }
function reorder(event, targetId) { event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer?.getData("text/plain"); if (!id || id === targetId) return; const dragged = playlist.find((i) => i.id === id); playlist = playlist.filter((i) => i.id !== id); playlist.splice(playlist.findIndex((i) => i.id === targetId), 0, dragged); emitPlaylist(); }
function editName() { const next = prompt("Edit your display name", localStorage.getItem("watchparty:name") || ""); if (next) { localStorage.setItem("watchparty:name", next); socket?.emit("setName", next); } }
function unlockPlayback() { playbackUnlocked = true; updatePlaybackGate(); beginSync(); applyPlayback(true); }
function updatePlaybackGate() { byId("playbackGate")?.classList.toggle("is-hidden", !isPlaybackGateVisible()); }
function isPlaybackGateVisible() { return !playbackUnlocked && playback.playing && Boolean(playback.itemId); }
function localPlayback(next) { return { ...next, updatedAt: Date.now() }; }
function avgPing() { return pingSamples.length ? pingSamples.reduce((sum, value) => sum + value, 0) / pingSamples.length / 2 : 0; }
function targetPlaybackTime() {
  if (!playback.playing) return playback.time;
  return playback.time + Math.max(0, Date.now() - playback.updatedAt) / 1000;
}
function beginSync() {
  clearTimeout(syncTimer);
  if (isPlaybackGateVisible()) { setSyncStatus("Joining"); return; }
  setSyncStatus("Syncing");
  scheduleSyncedStatus();
}
function scheduleSyncedStatus() {
  clearTimeout(syncTimer);
  if (isPlaybackGateVisible()) { setSyncStatus("Joining"); return; }
  syncTimer = setTimeout(() => setSyncStatus("Sync"), 700 + avgPing());
}
function setSyncStatus(status) { syncStatus = status; socket?.emit("syncStatus", status); const own = users.find((u) => u.id === socket?.id); if (own) own.syncStatus = status; paintUsers(); updateSyncOverlay(); }
function ensureSyncOverlay() {
  if (!byId("syncOverlay")) byId("video")?.insertAdjacentHTML("beforeend", `<div id="syncOverlay" class="sync-overlay is-hidden" aria-live="polite">Syncing playback…</div>`);
  updateSyncOverlay();
}
function updateSyncOverlay() {
  ensureSyncOverlayElement();
  byId("syncOverlay")?.classList.toggle("is-hidden", !(syncStatus === "Syncing" && playback.playing && !isPlaybackGateVisible()));
}
function ensureSyncOverlayElement() {
  if (!byId("syncOverlay") && byId("video")) byId("video").insertAdjacentHTML("beforeend", `<div id="syncOverlay" class="sync-overlay is-hidden" aria-live="polite">Syncing playback…</div>`);
}
function withIgnoredPlayerEvents(callback) { ignorePlayerEvents = true; callback(); setTimeout(() => { ignorePlayerEvents = false; }, 1000); }
function isYouTubePlayer() { return ytPlayer && typeof ytPlayer === "object" && hasYtMethod("getIframe"); }
function hasYtMethod(method) { return typeof ytPlayer?.[method] === "function"; }
function getYtDuration() { return hasYtMethod("getDuration") ? ytPlayer.getDuration() || 0 : 0; }
function getYtTime() { return hasYtMethod("getCurrentTime") ? ytPlayer.getCurrentTime() || 0 : 0; }
function getCurrentSeekTime() { return isYouTubePlayer() ? getYtTime() : targetPlaybackTime(); }
function applyServerSyncAdjustment(adjustment) {
  if (!adjustment || adjustment.itemId !== playback.itemId || syncAdjustmentCycle === adjustment.cycle) return;
  const skipAhead = Number(adjustment.skipAhead);
  if (!Number.isFinite(skipAhead) || skipAhead <= 0.01 || !isYouTubePlayer() || !hasYtMethod("seekTo")) return;
  syncAdjustmentCycle = adjustment.cycle;
  withIgnoredPlayerEvents(() => ytPlayer.seekTo(getYtTime() + skipAhead, true));
}
function formatSeekTime(time) {
  const seconds = Number(time);
  if (!Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function sizeYouTubeIframe() {
  const iframe = hasYtMethod("getIframe") ? ytPlayer.getIframe() : byId("video")?.querySelector("iframe");
  if (!iframe) return;
  iframe.classList.add("youtube-iframe");
  iframe.style.display = "block";
  ensurePlayerIframesDisplayBlock();
  iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  iframe.setAttribute("allowfullscreen", "");
  iframe.referrerPolicy = "origin-when-cross-origin";
  iframe.removeAttribute("width");
  iframe.removeAttribute("height");
}
function ensurePlayerIframesDisplayBlock() {
  document.querySelectorAll('#video iframe, iframe[src*="/embed/"]').forEach((iframe) => {
    iframe.style.display = "block";
  });
}

function getRoomId() { return location.pathname.match(/^\/watch\/([^/]+)/)?.[1] || location.pathname.match(/^\/r\/([^/]+)/)?.[1] || ""; }
function go(id) { location.href = `/watch/${id.replace(/[^a-zA-Z0-9_-]/g, "")}`; }
function byId(id) { return document.getElementById(id); }
function randomName() { return `${verbs[Math.floor(Math.random() * verbs.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`; }
function youtubeId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0] || "";
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(pathParts[0])) return pathParts[1] || "";
  return parsed.searchParams.get("v") || "";
}
function normalizeUrlInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
function providerFromUrl(url) {
  if (/youtu\.be|youtube\.com/i.test(url)) return "youtube";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  return "unknown";
}
function youtubePlayerVars() {
  return {
    enablejsapi: 1,
    origin: location.origin,
    widget_referrer: location.href,
    playsinline: 1,
    rel: 0,
    controls: 0,
  };
}
function readStoredVolume() { const stored = Number(localStorage.getItem(VOLUME_STORAGE_KEY)); return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 50; }
function loadYouTubeApi() { if (window.YT?.Player) return loadCurrent(); const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); window.onYouTubeIframeAPIReady = loadCurrent; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
