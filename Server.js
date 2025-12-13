// server.js (FINAL WORKING VERSION - Production Ready)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http');
const { Buffer } = require('buffer');

// --- FIREBASE MODULES (Using standard v9 syntax) ---
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set } = require('firebase/database');

// --- 1. FIREBASE CONFIGURATION (Using your actual config) ---
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

// CRITICAL VALUES (SYNCHRONIZED FOR 10 seconds recording)
// (16000 Hz * 1 channel * 2 bytes/sample * 10 seconds) / 1024 bytes/chunk = 312.5 chunks
const EXPECTED_CHUNK_COUNT = 313; 
const MONO_CHUNK_SIZE_BYTES = 1024; 
const EXPECTED_RAW_SIZE = EXPECTED_CHUNK_COUNT * MONO_CHUNK_SIZE_BYTES;


// --- 3. AUDIO PROCESSING (RAW PCM -> WAV -> FIREBASE) ---

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
    
    // --- CONCATENATE ALL CHUNKS ---
    let rawBuffer = Buffer.concat(audioChunks);
    
    // --- CRITICAL SAFEGUARD: TRIM IF OVERSIZED DUE TO TEXT COMMAND ---
    if (rawBuffer.length > EXPECTED_RAW_SIZE) {
        console.log(`WARNING: Trimming raw buffer from ${rawBuffer.length} to expected ${EXPECTED_RAW_SIZE} bytes (removing trailing text).`);
        rawBuffer = rawBuffer.subarray(0, EXPECTED_RAW_SIZE);
    }
    // -----------------------------------------------------------------

    // 16000 Hz, Mono (1), 16-bit
    const wavBuffer = addWavHeader(rawBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString('base64');

    console.log(`Uploading to Firebase... Raw buffer size: ${rawBuffer.length} bytes. Total chunks processed: ${audioChunks.length}`);

    // Clear chunks immediately after processing starts
    audioChunks = [];

    set(ref(db, 'latest_recording'), {
            timestamp: Date.now(),
            audioData: "data:audio/wav;base64," + base64Audio,
            status: "ready"
        })
        .then(() => {
            console.log("Firebase Upload successful! Check the WAV file in your database.");
            if (browserClient && browserClient.readyState === WebSocket.OPEN) {
                // Signals the HTML client that the file is ready
                browserClient.send("UPLOAD_COMPLETE");
            }
        })
        .catch((error) => {
            console.error("Firebase upload error:", error);
        })
        .finally(() => {
            processingFlag = false;
        });
}


// --- 4. WEBSOCKET CONNECTION AND MESSAGE HANDLERS ---

let esp32InitialMessageReceived = false;

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`\n### NEW CONNECTION ESTABLISHED: ${clientType} ###`);

    if (clientType === "ESP32") {
        esp32Client = ws;
        esp32InitialMessageReceived = false; // Reset the flag for a new ESP32 connection
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {

        // A. Handle Binary Data (Audio from ESP32)
        if (clientType === "ESP32" && Buffer.isBuffer(message)) {

            // CRITICAL FILTER: Ignore the initial "ESP32_CONNECTED" message
            const messageAsString = message.toString('utf8').trim();
            if (messageAsString === "ESP32_CONNECTED" && !esp32InitialMessageReceived) {
                 console.log(`[ESP32 Filter] Ignored initial identification message: "${messageAsString}"`);
                 esp32InitialMessageReceived = true;
                 return; // DO NOT treat this as an audio chunk
            }
            
            audioChunks.push(message);

            if (audioChunks.length % 50 === 0 || audioChunks.length < 5) {
                console.log(`Received chunk ${audioChunks.length}. Size: ${message.length} bytes.`);
            }


            // CRITICAL FIX: Trigger processing immediately after the expected chunk count
            if (audioChunks.length >= EXPECTED_CHUNK_COUNT && !processingFlag) {
                console.log(`\n!!! CRITICAL HIT (CHUNK COUNT): Reached ${EXPECTED_CHUNK_COUNT} chunks. Starting upload to Firebase...`);
                processAndUploadAudio();
                return;
            }
            return;
        }

        // B. Handle Text Data
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Fallback trigger)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! FALLBACK HIT (TEXT SIGNAL): END_RECORDING received. Starting upload to Firebase...");
            processAndUploadAudio();
            return;
        }

        // 2. Check for simple commands from the browser
        if (msgString === "START_RECORDING_REQUEST") {
            console.log("[Browser] Tell ESP32 to start recording...");
            audioChunks = [];
            processingFlag = false;

            if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                esp32Client.send("START");
                console.log("SUCCESS: 'START' sent to ESP32. Waiting for chunks...");
            } else {
                console.log("ERROR: Cannot send 'START'. ESP32 client is not open or connected.");
                if (browserClient) browserClient.send("ERROR: ESP32 not connected.");
            }
        }
    });

    ws.on('close', () => {
        console.log(`${clientType} disconnected`);
        if (clientType === "ESP32") esp32Client = null;
        if (clientType === "Browser") browserClient = null;
    });

    ws.on('error', (err) => {
        console.error(`WebSocket Error for ${clientType}:`, err.message);
    });
});

// --- 5. START SERVER ---
server.listen(port, () => {
    console.log(`Server listening on port ${port} (PRODUCTION MODE)`);
});
