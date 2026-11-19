"use strict";

const SIGNALING_URL = "wss://inai-col3.fishrungames.com/signaling/";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// --- DOM ---
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusEl = document.getElementById("status");
const callBtn = document.getElementById("callBtn");
const hangupBtn = document.getElementById("hangupBtn");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const reconnectBtn = document.getElementById("reconnectBtn");

// --- State ---
let ws = null;
let pc = null;
let localStream = null;
let pendingCandidates = []; // кандидаты, пришедшие до setRemoteDescription

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
}

// ---------- Signaling ----------

function connectSignaling() {
  reconnectBtn.hidden = true;
  setStatus("Подключение к серверу…", "warn");

  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    setStatus("Подключено. Нажмите «Позвонить» или ждите звонка", "ok");
    callBtn.disabled = !localStream || !!pc;
  };

  ws.onmessage = async (event) => {
    let raw = event.data;
    if (raw instanceof Blob) raw = await raw.text();

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn("Не JSON:", raw);
      return;
    }

    try {
      await handleSignal(msg);
    } catch (e) {
      console.error("Ошибка обработки сообщения", msg, e);
    }
  };

  ws.onclose = () => {
    setStatus("Соединение с сервером закрыто (возможно, подключился третий)", "err");
    callBtn.disabled = true;
    reconnectBtn.hidden = false;
    closePeer();
  };

  ws.onerror = (e) => console.error("WebSocket error", e);
}

function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function handleSignal(msg) {
  switch (msg.type) {
    case "offer": {
      // Нам звонят
      if (pc) closePeer(); // на случай «зависшего» старого соединения
      createPeer();
      await pc.setRemoteDescription(msg.offer ? msg.offer : msg);
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", answer: pc.localDescription });
      setStatus("Соединяемся…", "warn");
      break;
    }

    case "answer": {
      if (!pc) return;
      await pc.setRemoteDescription(msg.answer ? msg.answer : msg);
      await flushCandidates();
      break;
    }

    case "candidate": {
      if (!msg.candidate) return;
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(msg.candidate);
      } else {
        pendingCandidates.push(msg.candidate);
      }
      break;
    }

    case "hangup":
    case "peer-left": {
      setStatus(msg.type === "hangup" ? "Собеседник завершил звонок" : "Собеседник отключился", "warn");
      closePeer();
      break;
    }

    default:
      console.log("Неизвестное сообщение:", msg);
  }
}

async function flushCandidates() {
  for (const c of pendingCandidates) {
    try {
      await pc.addIceCandidate(c);
    } catch (e) {
      console.warn("addIceCandidate failed", e);
    }
  }
  pendingCandidates = [];
}

// ---------- WebRTC ----------

function createPeer() {
  pc = new RTCPeerConnection(RTC_CONFIG);
  pendingCandidates = [];

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: "candidate", candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case "connected":
        setStatus("Звонок идёт", "ok");
        break;
      case "disconnected":
        setStatus("Связь потеряна…", "warn");
        break;
      case "failed":
        setStatus("Не удалось установить соединение", "err");
        closePeer();
        break;
    }
  };

  callBtn.disabled = true;
  hangupBtn.disabled = false;
}

async function startCall() {
  if (!localStream || pc) return;
  createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: "offer", offer: pc.localDescription });
  setStatus("Звоним…", "warn");
}

function closePeer() {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  pendingCandidates = [];
  remoteVideo.srcObject = null;
  hangupBtn.disabled = true;
  callBtn.disabled = !(localStream && ws && ws.readyState === WebSocket.OPEN);
}

function hangup() {
  closePeer();
  // Сообщаем собеседнику: у сервера нет «hangup», поэтому шлём своё сообщение
  sendSignal({ type: "hangup" });
  setStatus("Звонок завершён", "");
}

// ---------- UI ----------

callBtn.onclick = startCall;
hangupBtn.onclick = hangup;
reconnectBtn.onclick = connectSignaling;

micBtn.onclick = () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = "🎤 Микрофон: " + (track.enabled ? "вкл" : "выкл");
  micBtn.classList.toggle("off", !track.enabled);
};

camBtn.onclick = () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = "📷 Камера: " + (track.enabled ? "вкл" : "выкл");
  camBtn.classList.toggle("off", !track.enabled);
};

// ---------- Init ----------

(async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;
    micBtn.disabled = false;
    camBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("Нет доступа к камере/микрофону: " + e.message, "err");
    return;
  }
  connectSignaling();
})();
