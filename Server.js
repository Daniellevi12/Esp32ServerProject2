const WebSocket = require('ws');
const admin = require('firebase-admin');

// --- 1. FIREBASE SETUP (The Bulletproof Version) ---
try {
    // 1. Parse the 'key' environment variable
    if (!process.env.key) {
        throw new Error("Environment variable 'key' is missing!");
    }
    
    const serviceAccount = JSON.parse(process.env.key);

    // 2. THE ULTIMATE KEY REPAIR
    // This removes extra quotes, handles double-escaped backslashes, 
    // and ensures the header/footer are clean.
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key
            .replace(/\\n/g, '\n')     // Convert literal \n to real newline
            .replace(/"/g, '')         // Remove any accidental wrapping quotes
            .replace(/-----BEGIN PRIVATE KEY-----/, '-----BEGIN PRIVATE KEY-----\n')
            .replace(/-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----\n')
            .replace(/\n+/g, '\n');    // Remove accidental double newlines
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: "carsense-abb24.firebasestorage.app"
    });

    console.log("✅ Firebase initialized. Signature repair applied.");
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
                console.log("⏺️ Recording started...");
                if (esp32 && esp32.readyState === 1) esp32.send("START");
            } else if (msgStr === "STOP") {
                console.log("⏹️ Recording stopped. Saving...");
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
        if (audioChunks.length === 0) return;

        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000); 

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        // 1. Create a random token (bypass key)
        const downloadToken = "bypass_" + Date.now(); 

        // 2. Save with the token in the metadata
        await file.save(wavBuffer, {
            metadata: { 
                contentType: 'audio/wav',
                metadata: {
                    firebaseStorageDownloadTokens: downloadToken
                }
            },
            resumable: false 
        });

        // 3. Construct the "Firebase Direct" URL
        // This format bypasses the Google Cloud 'Signed URL' CORS bouncer
        const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${downloadToken}`;

        console.log("✅ Bypass URL generated. Sending to website...");

        if (browser && browser.readyState === 1) { // 1 = OPEN
            browser.send(JSON.stringify({ audioUrl: url }));
        }
        audioChunks = [];

    } catch (error) {
        console.error("🔥 Firebase Save Error:", error.message);
    }
}
