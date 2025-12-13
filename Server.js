// server.js (WITH INITIAL MESSAGE FILTER - PURE CONSOLE DEBUG MODE)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http');
const { Buffer } = require('buffer');

// --- 2. SERVER SETUP & CLIENT TRACKING ---
const server = http.createServer();
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let browserClient = null;
let audioChunks = [];
let processingFlag = false;

// CRITICAL FIX: Set to 159 chunks to match the observed 5-second recording length
const EXPECTED_CHUNK_COUNT = 159;

// --- 3. AUDIO PROCESSING (RAW PCM LOGGING ONLY) ---

function logBufferSample(buffer, name) {
    if (buffer.length === 0) {
        console.log(`[${name}] WARNING: Buffer is empty.`);
        return;
    }
    
    const sampleLength = Math.min(buffer.length, 16);
    const startBytes = buffer.subarray(0, sampleLength).toString('hex');
    const endBytes = buffer.subarray(buffer.length - sampleLength, buffer.length).toString('hex');

    const isSilent = buffer.every(byte => byte === 0);

    console.log(`[${name}] Size: ${buffer.length} bytes. Silent? ${isSilent}`);
    console.log(`[${name}] Head Sample (Hex - 16 bytes): ${startBytes}...`);
    console.log(`[${name}] Tail Sample (Hex - 16 bytes): ...${endBytes}`);
}

function processAndLogAudio() {
    if (audioChunks.length === 0 || processingFlag) {
        console.log("WARNING: Attempted process but audioChunks array is empty or processing is already active.");
        return;
    }

    processingFlag = true;

    console.log("-------------------------------------------------------");
    console.log(`STEP 1: Starting Final Logging. Total chunks received: ${audioChunks.length}`);

    const rawBuffer = Buffer.concat(audioChunks);

    logBufferSample(rawBuffer, "RAW_PCM_FINAL");

    console.log(`STEP 2: Total Raw Buffer Size: ${rawBuffer.length} bytes.`);
    
    // Clear chunks
    audioChunks = [];

    if (browserClient && browserClient.readyState === WebSocket.OPEN) {
        browserClient.send("UPLOAD_COMPLETE"); 
    }

    console.log("-------------------------------------------------------");
    processingFlag = false;
}


// --- 4. WEBSOCKET CONNECTION AND MESSAGE HANDLERS ---

// --- NEW CRITICAL TRACKER ---
let esp32InitialMessageReceived = false;

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`\n### NEW CONNECTION ESTABLISHED: ${clientType} ###`);

    if (clientType === "ESP32") {
        esp32Client = ws;
        // Reset the flag for a new ESP32 connection
        esp32InitialMessageReceived = false; 
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {

        // A. Handle Binary Data (Audio from ESP32)
        if (clientType === "ESP32" && Buffer.isBuffer(message)) {
            
            // CRITICAL FILTER: Check if the message is the "ESP32_CONNECTED" string 
            // even though it arrived as a Buffer.
            const messageAsString = message.toString('utf8').trim();
            if (messageAsString === "ESP32_CONNECTED" && !esp32InitialMessageReceived) {
                 console.log(`[ESP32 Filter] Ignored initial identification message: "${messageAsString}"`);
                 esp32InitialMessageReceived = true;
                 return; // DO NOT treat this as an audio chunk
            }

            // --- CRITICAL LOG: CHUNK INSPECTION ---
            if (audioChunks.length % 50 === 0 || audioChunks.length < 5) {
                 console.log(`\n--- Incoming CHUNK_${audioChunks.length} ---`);
                 logBufferSample(message, `CHUNK_${audioChunks.length}`);
            }
            // --- END CRITICAL LOG ---

            audioChunks.push(message);

            if (audioChunks.length >= EXPECTED_CHUNK_COUNT && !processingFlag) {
                console.log(`\n!!! CRITICAL HIT (CHUNK COUNT): Reached ${EXPECTED_CHUNK_COUNT} chunks. Starting final log process...`);
                processAndLogAudio();
                return;
            }
            return;
        }

        // B. Handle Text Data
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Fallback trigger)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! FALLBACK HIT (TEXT SIGNAL): END_RECORDING received. Starting final log process...");
            processAndLogAudio();
            return;
        }

        // 2. Check for simple commands from the browser or ESP32
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
        } else if (msgString === "ESP32_CONNECTED") {
             // This branch handles the text message, but the filter above handles the binary message
             console.log("ESP32 identified itself (as text).");
        } else if (msgString === "PREDICT_REQUEST") {
            console.log(`[Browser] Received prediction request, ignoring in debug mode.`);
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
    console.log(`Server listening on port ${port} (INITIAL MESSAGE FILTER ADDED)`);
});
