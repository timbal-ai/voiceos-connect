/** Dev-only: prove Baileys works under Bun — socket opens, QR event fires. */
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from "baileys";
import pino from "pino";

const { state, saveCreds } = await useMultiFileAuthState("/tmp/wa-smoke-auth");
const { version } = await fetchLatestBaileysVersion();
console.error("WA web version:", version.join("."));

const sock = makeWASocket({
  version,
  auth: state,
  logger: pino({ level: "silent" }),
});
sock.ev.on("creds.update", saveCreds);

const timeout = setTimeout(() => {
  console.error("FAIL: no qr/connection event within 20s");
  process.exit(1);
}, 20_000);

sock.ev.on("connection.update", (u) => {
  if (u.qr) {
    console.error("OK: QR received (socket + noise handshake + crypto all work under Bun)");
    clearTimeout(timeout);
    process.exit(0);
  }
  if (u.connection === "close") {
    console.error("connection closed:", JSON.stringify(u.lastDisconnect?.error?.message ?? u));
  }
});
