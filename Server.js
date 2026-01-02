const WebSocket = require('ws');
const admin = require('firebase-admin');
const tf = require('@tensorflow/tfjs-node');

// --- 1. FIREBASE ADMIN SETUP (NO JSON FILE NEEDED) ---
// This looks for the text you pasted into Render's Dashboard
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
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://carsense-abb24-default-rtdb.europe-west1.firebasedatabase.app",
    storageBucket: "carsense-abb24.firebasestorage.app"
});

const db = admin.database();
const bucket = admin.storage().bucket();

// --- 2. AI CONFIGURATION ---
const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/7KA0738CC/model.json';
const LABELS = ['Background Noise', 'Car Horn']; // Ensure these match your TM classes exactly
let model;

async function loadModel() {
    try {
        model = await tf.loadLayersModel(MODEL_URL);
        console.log("✅ AI Model Loaded");
    } catch (err) {
        console.error("❌ Model Load Failed:", err);
    }
}
loadModel();

// --- 3. SERVER LOGIC ---
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
let esp32 = null;
let browser = null;
let audioBuffer = [];

console.log("🚀 Render Server Started...");

wss.on('connection', (ws, req) => {
    // Detect if it's the ESP32 or the Browser connecting
    const type = req.url.includes("ESP32") ? "ESP32" : "Browser";
    
    if (type === "ESP32") {
        esp32 = ws;
        console.log("ESP32: Connected");
    } else {
        browser = ws;
        console.log("Browser: Connected");
    }

    ws.on('message', async (data) => {
        const msg = data.toString();

        // If Website clicks "Start"
        if (msg === "START_RECORDING") {
            console.log("Action: Website requested scan. Pinging ESP32...");
            audioBuffer = []; // Clear old data
            if (esp32 && esp32.readyState === WebSocket.OPEN) {
                esp32.send("START");
            } else {
                console.log("Error: ESP32 not online");
                if(browser) browser.send(JSON.stringify({error: "ESP32 Offline"}));
            }
        } 
        
        // If it's incoming audio from the ESP32
        else if (Buffer.isBuffer(data) && type === "ESP32") {
            audioBuffer.push(data);
            
            // Check if we have 10 seconds of 16-bit 16kHz audio
            // 16000 samples * 2 bytes per sample = 320,000 bytes
            const currentSize = Buffer.concat(audioBuffer).length;
            if (currentSize >= 320000) {
                console.log("Action: 10s Audio Received. Starting AI...");
                processAndUpload(Buffer.concat(audioBuffer).subarray(0, 320000));
                audioBuffer = []; // Reset for next time
            }
        }
    });

    ws.on('close', () => console.log(`${type} Disconnected`));
});

async function processAndUpload(rawBuffer) {
    try {
        // 1. Convert Buffer to Float32 for AI
        const float32 = new Float32Array(rawBuffer.length / 2);
        for (let i = 0; i < float32.length; i++) {
            float32[i] = rawBuffer.readInt16LE(i * 2) / 32768.0;
        }

        // 2. Run Inference (1 second snapshot)
        const input = tf.tensor(float32.subarray(0, 16000), [1, 16000]);
        const prediction = await model.predict(input).data();
        const maxIdx = prediction.indexOf(Math.max(...prediction));
        
        const result = { 
            label: LABELS[maxIdx], 
            confidence: (prediction[maxIdx] * 100).toFixed(1) 
        };

        // 3. Create a WAV file and upload to Firebase Storage
        const fileName = `scans/scan_${Date.now()}.wav`;
        const file = bucket.file(fileName);
        
        // Simple WAV Header Wrapper (Basic)
        await file.save(rawBuffer, { 
            metadata: { contentType: 'audio/wav' },
            public: true 
        });

        // Get the link
        const [url] = await file.getSignedUrl({ 
            action: 'read', 
            expires: '01-01-2030' 
        });

        // 4. Save to RTDB & Send back to Website
        const scanData = { ...result, audioUrl: url, timestamp: Date.now() };
        await db.ref('latest_scan').set(scanData);
        
        if (browser) browser.send(JSON.stringify(scanData));
        console.log("✅ Analysis Complete:", result.label);

    } catch (error) {
        console.error("Processing Error:", error);
    }
}
