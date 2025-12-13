const WebSocket = require('ws');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set } = require('firebase/database');

// --- 1. FIREBASE CONFIGURATION ---
// IMPORTANT: Use YOUR exact Firebase Config here
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

// --- 2. SERVER SETUP ---
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port });

let esp32Client = null;
let browserClient = null;
let audioChunks = [];

console.log(`Server started on port ${port}`);

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`New connection established: ${clientType}`);

    if (clientType === "ESP32") {
        esp32Client = ws;
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {
        // --- ULTRA-DIAGNOSTIC LOGGING ---
        console.log(`[${clientType}] Raw Message Received. Is Buffer: ${Buffer.isBuffer(message)}, Length: ${message.length || 'N/A'}`);

        let msgString = null;

        // A. Handle Binary Data (Audio / Browser Command)
        if (Buffer.isBuffer(message)) {
            if (clientType === "ESP32") {
                // ESP32 sends audio
                audioChunks.push(message);
            } else if (clientType === "Browser" && message.length < 50) {
                // **FIXED BUG**: Browser sends command as small binary buffer, convert it.
                msgString = message.toString().trim();
            }
        }
        // B. Handle Text Data
        else {
            msgString = message.toString().trim();
        }

        // --- Execute Command Logic ---
        if (msgString) {
            console.log(`[${clientType}] Command received (processed): ${msgString}`);

            if (msgString === "START_RECORDING_REQUEST") {
                console.log("Tell ESP32 to start recording...");
                audioChunks = []; // Clear old audio buffer

                if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
                    esp32Client.send("START");
                    console.log("SUCCESS: 'START' sent to ESP32.");
                } else {
                    console.log("ERROR: Cannot send 'START'. ESP32 client is not open or connected.");
                }
            } else if (msgString === "END_RECORDING") {
                console.log("ESP32 finished. Processing WAV and uploading...");
                processAndUploadAudio();
            }
        }
    });

    ws.on('close', () => {
        console.log(`${clientType} disconnected`);
    });

    ws.on('error', (err) => {
        console.error(`WebSocket Error for ${clientType}:`, err.message);
    });
});

// --- 3. AUDIO PROCESSING (RAW PCM -> WAV -> FIREBASE) ---
function processAndUploadAudio() {
    if (audioChunks.length === 0) {
        console.log("WARNING: Attempted upload but audioChunks array is empty.");
        return;
    }

    const rawBuffer = Buffer.concat(audioChunks);
    const wavBuffer = addWavHeader(rawBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString('base64');

    console.log(`Uploading to Firebase... Raw buffer size: ${rawBuffer.length} bytes.`);

    set(ref(db, 'latest_recording'), {
            timestamp: Date.now(),
            audioData: "data:audio/wav;base64," + base64Audio,
            status: "ready"
        })
        .then(() => {
            console.log("Firebase Upload successful!");
            if (browserClient && browserClient.readyState === WebSocket.OPEN) {
                browserClient.send("UPLOAD_COMPLETE"); // <-- Signals HTML to fetch data
            }
        })
        .catch((error) => {
            console.error("Firebase upload error:", error);
        });
}

// Helper to construct a proper WAV header for the RAW PCM data
function addWavHeader(samples, sampleRate, numChannels, bitDepth) {
    const byteRate = (sampleRate * numChannels * bitDepth) / 8;
    const blockAlign = (numChannels * bitDepth) / 8;
    const buffer = Buffer.alloc(44 + samples.length);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples.length, 4);
    buffer.write('WAVE', 8);

    // FMT sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);

    // DATA sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length, 40);
    samples.copy(buffer, 44);

    return buffer;
}