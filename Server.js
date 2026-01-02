const WebSocket = require('ws');
const admin = require('firebase-admin');

// --- 1. FIREBASE SETUP (Render/Cloud Ready) ---
let serviceAccount;

try {
    // If you use a Render "Secret File", it will find it here
    serviceAccount = require("./serviceAccountKey.json");
    
    // THE FIX: Repair the private key for Cloud environment
    // Cloud systems often break the line-breaks in the private key
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
} catch (e) {
    console.error("❌ Could not find serviceAccountKey.json. Make sure it is uploaded to Render!");
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "carsense-abb24.firebasestorage.app"
});

const bucket = admin.storage().bucket();

// Render uses port 10000 by default, but process.env.PORT is best practice
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

let audioChunks = [];
let browser = null;
let esp32 = null;

console.log(`🚀 CarSense Server started on port ${PORT}`);

// --- 2. AUDIO PROCESSING HELPER ---
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

// --- 3. WEBSOCKET LOGIC ---
wss.on('connection', (ws, req) => {
    const type = req.url.includes("type=ESP32") ? "ESP32" : "Browser";
    console.log(`✨ New Connection: ${type} (URL: ${req.url})`);

    if (type === "ESP32") esp32 = ws;
    if (type === "Browser") browser = ws;

    ws.on('message', (data, isBinary) => {
        // Handle Text Commands
        if (!isBinary && data.length < 15) {
            const msgStr = data.toString().trim();
            console.log(`📩 COMMAND: ${msgStr}`);

            if (msgStr === "START") {
                audioChunks = [];
                console.log("⏺️ Recording started...");
                if (esp32 && esp32.readyState === 1) esp32.send("START");
                return;
            }
            if (msgStr === "STOP") {
                console.log("⏹️ Recording stopped. Processing...");
                if (esp32 && esp32.readyState === 1) esp32.send("STOP");
                saveFile();
                return;
            }
        }

        // Handle Binary Audio
        if (isBinary || Buffer.isBuffer(data)) {
            audioChunks.push(data);
        }
    });

    ws.on('close', () => {
        console.log(`❌ ${type} disconnected`);
        if (type === "ESP32") esp32 = null;
        if (type === "Browser") browser = null;
    });
});

// --- 4. FIREBASE UPLOAD LOGIC ---
async function saveFile() {
    try {
        if (audioChunks.length === 0) {
            console.log("❌ No data captured. Cannot save.");
            return;
        }

        console.log(`📦 Concatenating ${audioChunks.length} chunks...`);
        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000);

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        console.log(`📤 Uploading to Firebase: ${fileName}`);
        
        await file.save(wavBuffer, {
            metadata: { contentType: 'audio/wav' },
            resumable: false // Better for small audio files on Render
        });

        // Generate Signed URL for the Browser/AI
        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2030'
        });

        console.log("✅ File Saved & Signed! URL sent to Browser.");

        if (browser && browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ audioUrl: url }));
        }
        
        // Clear chunks to save memory
        audioChunks = [];

    } catch (error) {
        console.error("🔥 Firebase Save Error:", error.message);
        if (error.message.includes("JWT")) {
            console.error("💡 TIP: Your private_key is still invalid. Check your JSON formatting!");
        }
    }
}
