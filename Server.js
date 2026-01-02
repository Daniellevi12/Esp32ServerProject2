const WebSocket = require('ws');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// --- 1. FIREBASE SETUP (Render Secret File Fix) ---
const possiblePaths = [
    '/etc/secrets/serviceAccountKey.json', // Render standard secret path
    './serviceAccountKey.json',             // Local root
    '../serviceAccountKey.json'             // Parent directory
];

let serviceAccountPath = "";

for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        serviceAccountPath = p;
        break;
    }
}

if (!serviceAccountPath) {
    console.error("❌ ERROR: serviceAccountKey.json NOT FOUND!");
    process.exit(1);
}

// Initialize Admin only ONCE
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

console.log(`✅ Firebase Ready using: ${serviceAccountPath}`);
console.log(`🚀 CarSense Server active on port ${PORT}`);

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
                console.log("⏺️ Start Command Received");
                if (esp32 && esp32.readyState === 1) esp32.send("START");
            } else if (msgStr === "STOP") {
                console.log("⏹️ Stop Command Received");
                if (esp32 && esp32.readyState === 1) esp32.send("STOP");
                saveFile();
            }
        } else if (isBinary || Buffer.isBuffer(data)) {
            audioChunks.push(data);
        }
    });

    ws.on('close', () => {
        console.log(`❌ ${type} disconnected`);
        if (type === "ESP32") esp32 = null;
        if (type === "Browser") browser = null;
    });
});

// --- 4. FIREBASE UPLOAD ---
async function saveFile() {
    try {
        if (audioChunks.length === 0) {
            console.log("⚠️ No audio data to save.");
            return;
        }

        console.log(`📦 Concatenating ${audioChunks.length} chunks...`);
        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000); 

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        console.log("📤 Uploading to Firebase...");
        await file.save(wavBuffer, {
            metadata: { contentType: 'audio/wav' },
            resumable: false 
        });

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2030'
        });

        console.log("✅ File Uploaded! URL sent to Browser.");

        if (browser && browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ audioUrl: url }));
        }
        audioChunks = [];

    } catch (error) {
        console.error("🔥 Firebase Save Error:", error.message);
    }
}
