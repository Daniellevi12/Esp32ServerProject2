// server.js (PURE CONSOLE DEBUG MODE - NO FIREBASE - NO FS)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http');
const { Buffer } = require('buffer');
// NO fs module required for this version

// --- 1. CONFIGURATION ---
// No Firebase configuration needed.

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

/**
 * Utility to print a sample of the buffer content for inspection.
 * This is the core function for diagnosing silence.
 */
function logBufferSample(buffer, name) {
    if (buffer.length === 0) {
        console.log(`[${name}] WARNING: Buffer is empty.`);
        return;
    }
    
    // Use subarray for non-destructive inspection
    const sampleLength = Math.min(buffer.length, 16); // Check 16 bytes (8 samples) at start and end
    const startBytes = buffer.subarray(0, sampleLength).toString('hex');
    const endBytes = buffer.subarray(buffer.length - sampleLength, buffer.length).toString('hex');

    // This is the CRITICAL check for silence: check if all bytes are zero
    const isSilent = buffer.every(byte => byte === 0);

    // If it's 16-bit PCM, silence is represented by 0x0000.
    // If the data is truly silent, the log will show "Silent? true"
    
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

    // CRITICAL CHECK: Print the final raw buffer content
    logBufferSample(rawBuffer, "RAW_PCM_FINAL");

    console.log(`STEP 2: Total Raw Buffer Size: ${rawBuffer.length} bytes.`);
    
    // Clear chunks
    audioChunks = [];

    if (browserClient && browserClient.readyState === WebSocket.OPEN) {
        // Signals the HTML client that the streaming/processing is logically complete
        browserClient.send("UPLOAD_COMPLETE"); 
    }

    console.log("-------------------------------------------------------");
    processingFlag = false;
}


// --- 4. WEBSOCKET CONNECTION AND MESSAGE HANDLERS ---

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`\n### NEW CONNECTION ESTABLISHED: ${clientType} ###`);

    if (clientType === "ESP32") {
        esp32Client = ws;
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {

        // A. Handle Binary Data (Audio from ESP32)
        if (clientType === "ESP32" && Buffer.isBuffer(message)) {
            
            // --- CRITICAL LOG: CHUNK INSPECTION ---
            // Log the chunk BEFORE storing it
            if (audioChunks.length % 50 === 0 || audioChunks.length < 5) {
                 // Log every chunk for the first 5, then every 50 chunks for brevity
                 console.log(`\n--- Incoming CHUNK_${audioChunks.length} ---`);
                 logBufferSample(message, `CHUNK_${audioChunks.length}`);
            }
            // --- END CRITICAL LOG ---

            audioChunks.push(message);

            // CRITICAL FIX: Trigger processing immediately after the expected chunk count
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
        } else if (msgString === "ESP32_CONNECTED") {
             console.log("ESP32 identified itself.");
        } else if (msgString === "PREDICT_REQUEST") {
            // Log only the request, but do nothing as we are in debug mode
            console.log(`[Browser] Received prediction request, ignoring in debug mode: ${msgString}`);
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
    console.log(`Server listening on port ${port} (PURE CONSOLE DEBUG MODE)`);
});
