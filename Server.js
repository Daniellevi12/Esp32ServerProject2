// server.js (MODIFIED: WAV Upload Only - Prediction Disabled)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http'); 
const { Buffer } = require('buffer'); // Ensure Buffer is available

// *** NOTE: AI-related imports (node-fetch, tf, web-audio-api) have been removed or commented out ***

// --- FIREBASE MODULES (Using standard v9 syntax) ---
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set } = require('firebase/database');

// --- 1. FIREBASE CONFIGURATION (Use your actual config) ---
const firebaseConfig = {
    apiKey: "AIzaSyDfmDZO12RvN9h5Suk2v2Air6LIr4dGIE4",
    authDomain: "carsense-abb24.firebaseapp.com",
    databaseURL: "https://carsense-abb24-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "carsense-abb24",
    storageBucket: "carsense-abb24.firebasestorage.app",
    messagingSenderId: "225453696410",
    appId: "1:225453696410:web:54ff1fba95d4b02f9f8623",
    measurementId: "G-W5DP1WBC4S"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// --- 2. SERVER SETUP & CLIENT TRACKING ---
const server = http.createServer(); 
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let browserClient = null;
let audioChunks = [];
let processingFlag = false; 

// --- 3. CORE AUDIO PROCESSING (RAW PCM -> WAV -> FIREBASE) ---

function addWavHeader(samples, sampleRate, numChannels, bitDepth) {
    const byteRate = (sampleRate * numChannels * bitDepth) / 8;
    const blockAlign = (numChannels * bitDepth) / 8;
    const buffer = Buffer.alloc(44 + samples.length);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples.length, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); 
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length, 40);
    samples.copy(buffer, 44);

    return buffer;
}

function processAndUploadAudio() {
    if (audioChunks.length === 0 || processingFlag) {
        console.log("WARNING: Attempted upload but audioChunks array is empty or processing is already active.");
        return;
    }
    
    processingFlag = true; 

    const rawBuffer = Buffer.concat(audioChunks);
    const wavBuffer = addWavHeader(rawBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString('base64');

    console.log(`Uploading to Firebase... Raw buffer size: ${rawBuffer.length} bytes.`);
    
    audioChunks = []; 

    set(ref(db, 'latest_recording'), {
            timestamp: Date.now(),
            audioData: "data:audio/wav;base64," + base64Audio,
            status: "ready"
        })
        .then(() => {
            console.log("Firebase Upload successful!");
            // NO signal to browser, as prediction is disabled.
        })
        .catch((error) => {
            console.error("Firebase upload error:", error);
        })
        .finally(() => {
            processingFlag = false; 
        });
}


// --- 4. WEBSOCKET CONNECTION AND MESSAGE HANDLERS ---

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`New connection established: ${clientType}`);

    if (clientType === "ESP32") {
        esp32Client = ws;
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {
        
        // A. Handle Binary Data (Audio from ESP32)
        if (clientType === "ESP32" && Buffer.isBuffer(message)) {
            audioChunks.push(message);
            console.log(`[ESP32] Received audio chunk. Chunk size: ${message.length} bytes. Total chunks: ${audioChunks.length}`); 
            return;
        }

        // B. Handle Text Data 
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Trigger WAV upload)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! CRITICAL HIT: END_RECORDING received. Starting upload..."); 
            processAndUploadAudio();
            return;
        }

        // 2. Handle simple commands
        if (msgString === "START_RECORDING_REQUEST") {
            console.log("[Browser] Tell ESP32 to start recording...");
            audioChunks = []; 
            processingFlag = false; 

            if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                esp32Client.send("START"); 
                console.log("SUCCESS: 'START' sent to ESP32.");
            } else {
                console.log("ERROR: Cannot send 'START'. ESP32 client is not open or connected.");
            }
        } else if (msgString === "ESP32_CONNECTED") {
             console.log("ESP32 identified itself."); 
        }
        
        // 3. IGNORE PREDICTION REQUESTS
        try {
            const data = JSON.parse(msgString);
            if (data.type === 'PREDICT_REQUEST') {
                console.log("[Browser] Prediction request ignored (Server running in WAV-Only mode).");
                return;
            }
        } catch (e) {}

    });

    ws.on('close', () => {
        console.log(`${clientType} disconnected`);
        if (clientType === "ESP32") esp32Client = null;
        if (clientType === "Browser") browserClient = null;
        processingFlag = false; 
    });

    ws.on('error', (err) => {
        console.error(`WebSocket Error for ${clientType}:`, err.message);
        processingFlag = false; 
    });
});

// --- 5. START SERVER ---
server.listen(port, () => {
    console.log(`Server listening on port ${port} in WAV-Only Mode.`);
});
