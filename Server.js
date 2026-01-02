const WebSocket = require('ws');
const admin = require('firebase-admin');

// --- 1. FIREBASE SETUP ---
try {
    if (!process.env.key) throw new Error("Environment variable 'key' is missing!");
    const serviceAccount = JSON.parse(process.env.key);

    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key
            .replace(/\\n/g, '\n')
            .replace(/"/g, '')
            .replace(/-----BEGIN PRIVATE KEY-----/, '-----BEGIN PRIVATE KEY-----\n')
            .replace(/-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----\n')
            .replace(/\n+/g, '\n');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: "carsense-abb24.firebasestorage.app"
    });
    console.log("✅ Firebase Ready");
} catch (error) {
    console.error("❌ Firebase Init Failed:", error.message);
    process.exit(1);
}

const bucket = admin.storage().bucket();
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

let audioChunks = [];
let browser = null;
let esp32 = null;

// --- 2. WAV HEADER HELPER ---
function addWavHeader(rawBuffer, sampleRate) {
    const blockAlign = 2;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); 
    header.writeUInt16LE(1, 22); 
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); 
    header.write('data', 36);
    header.writeUInt32LE(rawBuffer.length, 40);
    return Buffer.concat([header, rawBuffer]);
}

// --- 3. WEBSOCKET LOGIC ---
wss.on('connection', (ws, req) => {
    const type = req.url.includes("type=ESP32") ? "ESP32" : "Browser";
    if (type === "ESP32") esp32 = ws;
    if (type === "Browser") browser = ws;
    console.log(`✨ Connected: ${type}`);

    ws.on('message', (data, isBinary) => {
        if (!isBinary && data.length < 20) {
            const msg = data.toString().trim();
            if (msg === "START") {
                audioChunks = [];
                if (esp32?.readyState === 1) esp32.send("START");
            } else if (msg === "STOP") {
                if (esp32?.readyState === 1) esp32.send("STOP");
                saveAndSend();
            }
        } else {
            audioChunks.push(data);
        }
    });
});

// --- 4. THE BYPASS SEND ---
async function saveAndSend() {
    if (audioChunks.length === 0) return;
    const wavBuffer = addWavHeader(Buffer.concat(audioChunks), 16000);

    // BYPASS: Convert to Base64 String
    const base64Audio = wavBuffer.toString('base64');
    const dataUrl = `data:audio/wav;base64,${base64Audio}`;

    if (browser?.readyState === 1) {
        console.log("🚀 Sending Audio Data String...");
        browser.send(JSON.stringify({ audioData: dataUrl }));
    }

    // Backup to Firebase
    const file = bucket.file(`scans/audio_${Date.now()}.wav`);
    file.save(wavBuffer, { metadata: { contentType: 'audio/wav' }, resumable: false })
        .then(() => console.log("☁️ Saved to Firebase Backup"))
        .catch(e => console.error("Firebase Error:", e.message));

    audioChunks = [];
}
console.log(`🚀 Server on ${PORT}`);
