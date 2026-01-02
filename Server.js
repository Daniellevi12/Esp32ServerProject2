const WebSocket = require('ws');
const admin = require('firebase-admin');

// --- 1. FIREBASE SETUP ---
// Make sure serviceAccount.json is in the same folder!
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "carsense-abb24.firebasestorage.app"
});
const bucket = admin.storage().bucket();

const wss = new WebSocket.Server({ port: 10000 });
let audioChunks = [];
let browser = null;
let esp32 = null;

console.log("🚀 CarSense Server started on port 10000");

// Helper to add WAV Header
function addWavHeader(rawBuffer, sampleRate) {
    const blockAlign = 2;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); // 16-bit
    header.write('data', 36);
    header.writeUInt32LE(rawBuffer.length, 40);
    return Buffer.concat([header, rawBuffer]);
}

wss.on('connection', (ws, req) => {
    const type = req.url.includes("type=ESP32") ? "ESP32" : "Browser";
    console.log(`✨ New Connection: ${type} (URL: ${req.url})`);

    if (type === "ESP32") esp32 = ws;
    if (type === "Browser") browser = ws;

    // MESSAGE HANDLER
    ws.on('message', (data, isBinary) => {
        // IMMEDIATE check: Is it a tiny text command? 
        // We handle this FIRST before doing anything with buffers.
        if (!isBinary && data.length < 10) {
            const msgStr = data.toString().trim();
            console.log(`📩 COMMAND: ${msgStr}`);

            if (msgStr === "START") {
                audioChunks = [];
                if (esp32 && esp32.readyState === 1) esp32.send("START");
                return; // Exit early
            }
            if (msgStr === "STOP") {
                if (esp32 && esp32.readyState === 1) esp32.send("STOP");
                saveFile();
                return; // Exit early
            }
        }

        // It's binary audio - push it to the array
        if (isBinary || Buffer.isBuffer(data)) {
            audioChunks.push(data);
        }
    });

    ws.on('close', () => {
        console.log(`❌ ${type} disconnected`);
        if (type === "ESP32") esp32 = null;
        if (type === "Browser") browser = null;
    });

    ws.on('error', (err) => console.error(`🔥 Socket Error (${type}):`, err));
});

async function saveFile() {
    try {
        if (audioChunks.length === 0) {
            console.log("❌ No data captured. Cannot save file.");
            return;
        }

        console.log(`📦 Processing ${audioChunks.length} chunks...`);
        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000);

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        console.log(`📤 Uploading to Firebase: ${fileName} (${wavBuffer.length} bytes)`);
        await file.save(wavBuffer, {
            metadata: { contentType: 'audio/wav' }
        });

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2030'
        });

        console.log("✅ File ready! Link:", url);

        if (browser && browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ audioUrl: url }));
        }
    } catch (error) {
        console.error("🔥 Firebase Save Error:", error);
    }
}
