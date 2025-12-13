// server.js (DEBUGGING MODE - NO FIREBASE - LOGGING INTENSIVE)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http');
const { Buffer } = require('buffer');
const fs = require('fs'); // Added for local file output during debugging

// --- 1. CONFIGURATION ---
// Server does NOT need Firebase config in this mode.
// We keep client tracking variables from the original code.

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

// --- 3. AUDIO PROCESSING (RAW PCM -> WAV -> LOCAL FILE) ---

/**
 * Utility to print a sample of the buffer content for inspection.
 */
function logBufferSample(buffer, name) {
    if (buffer.length < 10) {
        console.log(`[${name}] Data: ${buffer.toString('hex')}`);
        return;
    }
    // Print first 8 bytes and last 8 bytes
    const startBytes = buffer.subarray(0, 8).toString('hex');
    const endBytes = buffer.subarray(buffer.length - 8, buffer.length).toString('hex');

    // This is the core check for silence!
    const isSilent = buffer.every(byte => byte === 0);

    console.log(`[${name}] Size: ${buffer.length} bytes. Silent? ${isSilent}`);
    console.log(`[${name}] Head Sample (Hex): ${startBytes}...`);
    console.log(`[${name}] Tail Sample (Hex): ...${endBytes}`);
}

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

function processAndSaveAudio() {
    if (audioChunks.length === 0 || processingFlag) {
        console.log("WARNING: Attempted process but audioChunks array is empty or processing is already active.");
        return;
    }

    processingFlag = true;

    console.log("-------------------------------------------------------");
    console.log(`STEP 1: Starting Final Processing. Total chunks: ${audioChunks.length}`);

    const rawBuffer = Buffer.concat(audioChunks);

    logBufferSample(rawBuffer, "RAW_PCM_FINAL");

    // 16000 Hz, Mono (1), 16-bit
    const wavBuffer = addWavHeader(rawBuffer, 16000, 1, 16);

    console.log(`STEP 2: WAV Buffer Size: ${wavBuffer.length} bytes.`);
    
    // Clear chunks immediately after processing starts
    audioChunks = [];

    // --- CRITICAL DEBUG STEP: WRITE FILE LOCALLY ---
    try {
        const filePath = 'test_output.wav';
        fs.writeFileSync(filePath, wavBuffer);
        console.log(`STEP 3: Successfully wrote WAV file to ${filePath}. Download and check it!`);
    } catch (e) {
        console.error(`STEP 3: WARNING: Could not write file locally (fs error). This is expected on some cloud platforms like Render:`, e.message);
    }
    
    if (browserClient && browserClient.readyState === WebSocket.OPEN) {
        // Signals the HTML client that processing is done.
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
            logBufferSample(message, `CHUNK_${audioChunks.length}`);
            // --- END CRITICAL LOG ---

            audioChunks.push(message);

            // CRITICAL FIX: Trigger processing immediately after the expected chunk count
            if (audioChunks.length >= EXPECTED_CHUNK_COUNT && !processingFlag) {
                console.log(`!!! CRITICAL HIT (CHUNK COUNT): Reached ${EXPECTED_CHUNK_COUNT} chunks. Starting local file creation...`);
                processAndSaveAudio();
                return;
            }
            return;
        }

        // B. Handle Text Data
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Fallback trigger)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! FALLBACK HIT (TEXT SIGNAL): END_RECORDING received. Starting local file creation...");
            processAndSaveAudio();
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
    console.log(`Server listening on port ${port} (DEBUG MODE)`);
});
