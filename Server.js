const WebSocket = require('ws');
const admin = require('firebase-admin');
const tf = require('@tensorflow/tfjs-node');

// --- 1. FIREBASE SETUP (PASTE YOUR JSON HERE) ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "carsense-abb24",
  "private_key_id": "1ce2687e7102d13da09a5eab63bf7a894585554f",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCY6oxZUzU793zh\n2Rn3R+L4rXKCyZgOfRER6ZX7xxnPSSsrSRuV1aZkcUtzvxp45K+F1TxGFRAUkJK8\nkqehbPpYqp03b8EYnSsuiYWTDYy/7emNoEIdLlurY34HTlRfMVd6CR8ZJ0JpMvEV\nx3O1Rp/8vR6rlKbwragbTXHLqMR4QiqO0tJfv4af6VUdHHCGiBVhAJ+e1MVQYZis\nhzGVrULDguPA8a2jnK+hrZiiihLN0ztg/Qt3BGk8/tvZVZ40/ByzRGOEaYxCA4Re\nE/+4XEHbcxUpa3cW33jX3v636i6jTVjy48jDK5uKVkOG3GqURTU0KOguweWgg++U\nU4t/LxtZAgMBAAECggEAI07xJkT4w0ZzjwCepsLyDSKbkMh0tE+7i8vIRnEkLAFE\nlwOT+4ZwG7wvRGQpfCWtw7THbJU7d8wkHaetTjBIJAYNNDo5N3I/AMlfTuOvjrek\nGIAbE/raztmzxYMYJzzQ6oxFony2sGzDTxiVRpOuqGCQvuSdoXAvo1JABtsKtouR\nPOWHW5q7HhrFFxka1kOthL9pOqRHjdDDmjeIe+K1QyAO0H6Vg8ktYCghec4di3yq\nccQ8sp+QLK9Wflq/HqgJN2TL3/B3nXWo9wTy2nRSzn+rR7nLFfxImg/c0ZyI8jNQ\nkbGdFaPakUi4VFWjZi7S6ktEWQOHeeIjo7Sr1Gu4SwKBgQDKGLcJab2vCYfmRvs0\n6rOUMgCWAPAczIBmmLYnClZsJW+2gPNmdpT/bXzdSZwctAOYP4Zdll9xyF8ewx3J\nGXJODr0culDFLwef9U/2cHEL+GS5xV/0RkPHohZl0poa2PLfULulS7UAKVM9WC9S\nW1945CAG6cTTYxiMapyhHHAgDwKBgQDBs8Rv4YtXdYd8JwzSxDHBjg8roMKxkHPG\nvxFBbwIQSF3mtEi2tHdUsWLfTC5M00VoXq8ZSZGxXyoNBqIdilOdcKsenZCZ+Vuv\n9E8bQ/2yVUXvECazPoNfSn/UbYy7qiN7Kg7rL+vfqbvvn02cHKz6BChnH1DjSaG7\ny4FytAYmFwKBgCKmzDOD+u8ZPkEAqK/xEit1y13s+T6m3dk5k/nrrtfKL3Zmc9V8\nvZ1yQ3eZ2HefcgJX2g0P7HuQ9KZMpD3H7C5wHoLfe1vj7XXC1RwXOXro8zRbIFG8\n/oArTZXV33B9BF+/8vyrl3RYoZoiFbMUUbFjxA4LZSEtm5bv7L0/KAaHAoGAeytd\nSKtJmHZyjX6jR85buTEk8mAKDTDGfeV3Cn2U+Vea5h1Tc2Iz0xXswgLGGjHpm6FB\nhDnku73AloHWSiRwYNeI6DHXBiGqrKsUNkk4o9JXYtmJUkb48HoF6MU0TQy1/RZU\nYDabrSBYEdnhVthhIaXNLy2ZmL10a17PVGmm00cCgYEAvupAkp0DxPkhY/E+Xr0o\nF7f3+RjImQltDepP3kOsYy2Rs+hGX35mi8htvM9DlDtUFmx4fBKiX6X05Fn62LOR\n+2kvqGSLHlCX0hh3djH4gVqliYUxfGahAI4wVTXnOjSMSAerReYEGFgppqnEtuqE\nmPqVKjZaYtYf3eRS6IU7UJ4=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@carsense-abb24.iam.gserviceaccount.com",
  "client_id": "111566575451857240436",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40carsense-abb24.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://carsense-abb24-default-rtdb.europe-west1.firebasedatabase.app",
    storageBucket: "carsense-abb24.firebasestorage.app"
});

const bucket = admin.storage().bucket();
const db = admin.database();

// --- 2. AI SETUP ---
const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/7KA0738CC/model.json';
const LABELS = ['Background Noise', 'Car Horn']; 
let model;
(async () => {
    try { 
        model = await tf.loadLayersModel(MODEL_URL); 
        console.log("✅ SYSTEM: AI Model Loaded"); 
    } catch (e) { console.error("❌ SYSTEM: Model Load Failed", e); }
})();

// --- 3. SERVER LOGIC ---
const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: port }, () => {
    console.log(`🚀 SYSTEM: Server started on port ${port}`);
});

// GLOBAL CLIENT HOLDERS
let esp32Client = null;
let browserClient = null;
let audioChunks = [];

wss.on('connection', (ws, req) => {
    const url = req.url;
    console.log(`🔌 CONNECTION ATTEMPT: ${url}`);

    if (url.includes("ESP32")) {
        esp32Client = ws;
        console.log("✅ CLIENT IDENTIFIED: ESP32 Connected");
    } else if (url.includes("Browser")) {
        browserClient = ws;
        console.log("✅ CLIENT IDENTIFIED: Browser Connected");
    } else {
        console.log("⚠️ UNKNOWN CLIENT CONNECTED");
    }

    ws.on('message', async (message) => {
        // --- CASE 1: BINARY AUDIO DATA ---
        if (Buffer.isBuffer(message)) {
            if (ws === esp32Client) {
                audioChunks.push(message);
                if (audioChunks.length % 50 === 0) {
                    const totalSize = Buffer.concat(audioChunks).length;
                    console.log(`🎤 AUDIO: Receiving... Total Buffer: ${totalSize} bytes`);
                }
            }
            return;
        }

        // --- CASE 2: TEXT COMMANDS ---
        const msgString = message.toString().trim();
        console.log(`📩 MESSAGE RECEIVED: [${msgString}]`);

        // FROM BROWSER: START
        if (msgString === "START_RECORDING") {
            console.log("👉 ACTION: Browser requested Start");
            audioChunks = []; // Reset buffer

            if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                esp32Client.send("START");
                console.log("📤 SENT: 'START' command sent to ESP32");
            } else {
                console.log("❌ ERROR: ESP32 is NOT connected or NOT ready");
                if (browserClient) browserClient.send(JSON.stringify({ error: "ESP32 Offline" }));
            }
        }

        // FROM ESP32: STOP (Recording Done)
        if (msgString === "STOP") {
            console.log("🛑 ACTION: ESP32 sent STOP. Processing Audio...");
            const fullAudio = Buffer.concat(audioChunks);
            console.log(`📊 PROCESSING: Final Audio Size: ${fullAudio.length} bytes`);
            
            // Process even if small, just to test flow
            if (fullAudio.length > 1000) { 
                processAndUpload(fullAudio);
            } else {
                console.log("❌ ERROR: Audio file too small/empty");
                if (browserClient) browserClient.send(JSON.stringify({ error: "Audio Empty" }));
            }
            audioChunks = []; // clear memory
        }
    });

    ws.on('close', () => {
        if (ws === esp32Client) {
            console.log("❌ DISCONNECT: ESP32 went offline");
            esp32Client = null;
        } else if (ws === browserClient) {
            console.log("❌ DISCONNECT: Browser went offline");
            browserClient = null;
        }
    });
});

async function processAndUpload(buffer) {
    try {
        console.log("🧠 AI: Starting Inference...");
        const float32 = new Float32Array(buffer.length / 2);
        for (let i = 0; i < float32.length; i++) {
            float32[i] = buffer.readInt16LE(i * 2) / 32768.0;
        }
        
        // Pad or Trim to 1 second (16000 samples) for simple test
        const inputTensor = tf.tensor(float32.slice(0, 16000), [1, 16000]);
        const prediction = await model.predict(inputTensor).data();
        const maxIdx = prediction.indexOf(Math.max(...prediction));
        const resultLabel = LABELS[maxIdx];
        const conf = (prediction[maxIdx] * 100).toFixed(1);

        console.log(`🧠 AI RESULT: ${resultLabel} (${conf}%)`);

        // Upload
        console.log("☁️ FIREBASE: Uploading...");
        const fileName = `scans/scan_${Date.now()}.wav`;
        const file = bucket.file(fileName);
        
        await file.save(buffer, { metadata: { contentType: 'audio/wav' } });
        await file.makePublic();
        
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        console.log(`☁️ URL GENERATED: ${publicUrl}`);

        const payload = {
            label: resultLabel,
            confidence: conf,
            audioUrl: publicUrl
        };

        // Notify Browser
        if (browserClient && browserClient.readyState === WebSocket.OPEN) {
            browserClient.send(JSON.stringify(payload));
            console.log("✅ SUCCESS: Result sent to Browser");
        }

    } catch (err) {
        console.error("❌ CRITICAL ERROR:", err);
    }
}
