const dgram = require("node:dgram");

const WSJTX_MAGIC = 0xadbccbda;
const MESSAGE_TYPES = new Map([
  [0, "Heartbeat"],
  [1, "Status"],
  [2, "Decode"],
  [3, "Clear"],
  [4, "Reply"],
  [5, "QSO Logged"],
  [6, "Close"],
  [7, "Replay"],
  [8, "Halt Tx"],
  [9, "Free Text"],
  [10, "WSPR Decode"],
  [11, "Location"],
  [12, "Logged ADIF"],
]);

function createWsjtxReceiver(config, onMessage = () => {}) {
  if (!config.WSJTX_ENABLED) return null;

  const socket = dgram.createSocket("udp4");
  const state = {
    host: config.WSJTX_HOST,
    port: config.WSJTX_PORT,
    listening: false,
    lastMessage: null,
    lastError: null,
  };

  socket.on("message", (buffer, remote) => {
    const message = parseWsjtxMessage(buffer, remote);
    state.lastMessage = message;
    onMessage(message);
  });

  socket.on("error", (error) => {
    state.lastError = error.message;
    console.warn(`WSJT-X UDP receiver error: ${error.message}`);
  });

  socket.bind(state.port, state.host, () => {
    state.listening = true;
    const address = socket.address();
    console.log(`WSJT-X UDP receiver listening on ${address.address}:${address.port}`);
  });

  return {
    state,
    close: () => socket.close(),
  };
}

function parseWsjtxMessage(buffer, remote) {
  const fallback = {
    valid: false,
    type: null,
    typeName: "Unknown",
    id: "",
    size: buffer.length,
    remote: { address: remote.address, port: remote.port },
    receivedAt: new Date().toISOString(),
  };

  if (buffer.length < 12) return fallback;
  const magic = buffer.readUInt32BE(0);
  const schema = buffer.readUInt32BE(4);
  const type = buffer.readUInt32BE(8);
  const id = readUtf8Field(buffer, 12);

  return {
    ...fallback,
    valid: magic === WSJTX_MAGIC,
    magic,
    schema,
    type,
    typeName: MESSAGE_TYPES.get(type) || `Type ${type}`,
    id: id.value,
  };
}

function readUtf8Field(buffer, offset) {
  if (offset + 4 > buffer.length) return { value: "", nextOffset: offset };
  const length = buffer.readUInt32BE(offset);
  const valueStart = offset + 4;
  const valueEnd = valueStart + length;
  if (length === 0xffffffff || valueEnd > buffer.length) return { value: "", nextOffset: valueStart };
  return { value: buffer.toString("utf8", valueStart, valueEnd), nextOffset: valueEnd };
}

module.exports = { createWsjtxReceiver, parseWsjtxMessage };
