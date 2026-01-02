const WebSocket = require('ws');
const admin = require('firebase-admin');
const path = require('path');

// --- 1. FIREBASE SETUP (Using Render Secret File) ---
// Render places secret files in the root directory of your project
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath),
    storageBucket: "carsense-abb24.firebasestorage.app"
});

const bucket = admin.storage().bucket();
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

let audioChunks = [];
let browser = null;
let esp32 = null;

console.log(`🚀 CarSense Server active. Using Secret File: ${serviceAccountPath}`);

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

// --- 3. WEBSOCKET HANDLER ---
wss.on('connection', (ws, req) => {
    const type = req.url.includes("type=ESP32") ? "ESP32" : "Browser";
    console.log(`✨ New Connection: ${type}`);

    if (type === "ESP32") esp32 = ws;
    if (type === "Browser") browser = ws;

    ws.on('message', (data, isBinary) => {
        if (!isBinary && data.length < 20) {
            const msgStr = data.toString().trim();
            if (msgStr === "START") {
                audioChunks = [];
                if (esp32 && esp32.readyState === 1) esp32.send("START");
            } else if (msgStr === "STOP") {
                if (esp32 && esp32.readyState === 1) esp32.send("STOP");
                saveFile();
            }
        } else if (isBinary || Buffer.isBuffer(data)) {
            audioChunks.push(data);
        }
    });

    ws.on('close', () => {
        if (type === "ESP32") esp32 = null;
        if (type === "Browser") browser = null;
    });
});

// --- 4. FIREBASE UPLOAD ---
async function saveFile() {
    try {
        if (audioChunks.length === 0) return;

        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000); 

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        await file.save(wavBuffer, {
            metadata: { contentType: 'audio/wav' },
            resumable: false 
        });

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2030'
        });

        console.log("✅ File Uploaded Successfully!");

        if (browser && browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ audioUrl: url }));
        }
        audioChunks = [];

    } catch (error) {
        console.error("🔥 Firebase Save Error:", error.message);
    }
}
