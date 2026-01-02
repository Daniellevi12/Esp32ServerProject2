const WebSocket = require('ws');
const admin = require('firebase-admin');
const tf = require('@tensorflow/tfjs-node');

// --- 1. FIREBASE ADMIN SETUP (NO JSON FILE NEEDED) ---
// This looks for the text you pasted into Render's Dashboard
const serviceAccount = {

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
    const type = req.url.includes("ESP32") ? "ESP32" : "Browser";
    
    if (type === "ESP32") {
        esp32 = ws;
        console.log("ESP32: Connected");
    } else {
        browser = ws;
        console.log("Browser: Connected");
    }

    ws.on('message', async (data) => {
        // Handle Text Commands
        if (!Buffer.isBuffer(data)) {
            const msg = data.toString();
            if (msg === "START_RECORDING") {
                console.log("Action: Website requested scan.");
                audioBuffer = []; 
                if (esp32 && esp32.readyState === WebSocket.OPEN) {
                    esp32.send("START");
                } else {
                    if(browser) browser.send(JSON.stringify({label: "Error", confidence: "0", error: "ESP32 Offline"}));
                }
            }
            return;
        }

        // Handle Audio from ESP32
        if (type === "ESP32") {
            audioBuffer.push(data);
            
            // LOGGING: See how much data we are getting
            let currentSize = Buffer.concat(audioBuffer).length;
            
            // If we have at least 9.5 seconds of audio, process it.
            // (16000 samples/sec * 2 bytes * 9.5 sec = 304,000)
            if (currentSize >= 304000) { 
                console.log(`Action: Audio received (${currentSize} bytes). Analyzing...`);
                const fullBuffer = Buffer.concat(audioBuffer);
                processAndUpload(fullBuffer);
                audioBuffer = []; // Clear for next time
            }
        }
    });

    ws.on('close', () => {
        console.log(`${type} Disconnected`);
        // Fallback: If ESP32 disconnects but we have audio, process it
        if (type === "ESP32" && audioBuffer.length > 50) {
            processAndUpload(Buffer.concat(audioBuffer));
            audioBuffer = [];
        }
    });
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
