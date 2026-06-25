const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWsjtxMessage } = require("../server/wsjtx.js");

test("parses WSJT-X heartbeat header and id", () => {
  const id = Buffer.from("WSJT-X", "utf8");
  const packet = Buffer.alloc(16 + id.length);
  packet.writeUInt32BE(0xadbccbda, 0);
  packet.writeUInt32BE(3, 4);
  packet.writeUInt32BE(0, 8);
  packet.writeUInt32BE(id.length, 12);
  id.copy(packet, 16);

  const message = parseWsjtxMessage(packet, { address: "127.0.0.1", port: 2237 });

  assert.equal(message.valid, true);
  assert.equal(message.schema, 3);
  assert.equal(message.type, 0);
  assert.equal(message.typeName, "Heartbeat");
  assert.equal(message.id, "WSJT-X");
  assert.deepEqual(message.remote, { address: "127.0.0.1", port: 2237 });
});

test("marks non-WSJT-X packets invalid", () => {
  const packet = Buffer.alloc(12);
  packet.writeUInt32BE(0, 0);
  packet.writeUInt32BE(3, 4);
  packet.writeUInt32BE(2, 8);

  const message = parseWsjtxMessage(packet, { address: "127.0.0.1", port: 2237 });

  assert.equal(message.valid, false);
  assert.equal(message.typeName, "Decode");
});
