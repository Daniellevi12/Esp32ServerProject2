const WebSocket = require("ws");
const http = require("http");
const { Buffer } = require("buffer");
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set } = require("firebase/database");

const firebaseApp = initializeApp({
  apiKey: "AIzaSyDfmDZO12RvN9h5Suk2v2Air6LIr4dGIE4",
  databaseURL: "https://carsense-abb24-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = getDatabase(firebaseApp);

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let esp32 = null;
let browser = null;
let chunks = [];

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

wss.on("connection", (ws, req) => {
  const isESP32 = req.url.includes("ESP32");
  if (isESP32) esp32 = ws;
  else browser = ws;

  ws.on("message", msg => {
    if (Buffer.isBuffer(msg)) {
      chunks.push(msg);
      return;
    }

    msg = msg.toString();

    if (msg === "START_RECORDING_REQUEST") {
      chunks = [];
      esp32?.send("START");
    }

    if (msg === "END_RECORDING") {
      const pcm = Buffer.concat(chunks);
      const wavData = wav(pcm).toString("base64");

      set(ref(db, "latest_recording"), {
        timestamp: Date.now(),
        audioData: "data:audio/wav;base64," + wavData,
        status: "ready"
      });

      browser?.send("UPLOAD_COMPLETE");
      chunks = [];
    }
  });
});

server.listen(process.env.PORT || 8080);
