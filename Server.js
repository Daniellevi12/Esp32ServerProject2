// server.js (FINAL WORKING VERSION - Production Ready with AI)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http');
const { Buffer } = require('buffer');

// --- AI & FIREBASE MODULES ---
// NOTE: Make sure to run 'npm install @tensorflow/tfjs @tensorflow/tfjs-node firebase node-fetch'
const tf = require('@tensorflow/tfjs');
const tfNode = require('@tensorflow/tfjs-node'); // For native performance
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set } = require('firebase/database');

// --- 1. AI CONFIGURATION ---
const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/7KA0738CC/model.json';
const MODEL_LABELS = ['Background Noise', 'Car Horn'];
const AUDIO_LENGTH_SAMPLES = 16000; // 1 second of 16kHz audio
let tmModel = null;

async function loadModel() {
    console.log('Loading TensorFlow Model...');
    try {
        // Use tf.loadLayersModel for Teachable Machine models
        tmModel = await tf.loadLayersModel(MODEL_URL);
        console.log('✅ TensorFlow Model loaded successfully.');
    } catch (error) {
        console.error('❌ Failed to load TensorFlow Model:', error.message);
    }
}


// --- 2. FIREBASE CONFIGURATION ---
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

// --- 3. SERVER SETUP & CRITICAL VALUES ---
const server = http.createServer();
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let browserClient = null;
let audioChunks = [];
let processingFlag = false;

// SYNCHRONIZED FOR 10 seconds recording
const EXPECTED_CHUNK_COUNT = 313; 
const MONO_CHUNK_SIZE_BYTES = 1024; 
const EXPECTED_RAW_SIZE = EXPECTED_CHUNK_COUNT * MONO_CHUNK_SIZE_BYTES;


// --- 4. AUDIO UTILITIES ---

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


// --- 5. AI PREDICTION LOGIC ---

function runPrediction(rawBuffer) {
    if (!tmModel) {
        return { predictedClass: 'Error: Model not loaded', consensusConfidence: 0, windowVotes: [] };
    }

    const TOTAL_SAMPLES = rawBuffer.length / 2;
    // We expect 10 seconds (160,000 samples). This ensures we only process the expected length.
    const NUM_WINDOWS = Math.floor(TOTAL_SAMPLES / AUDIO_LENGTH_SAMPLES); 
    
    if (NUM_WINDOWS === 0) {
        return { predictedClass: 'Error: Not enough audio data', consensusConfidence: 0, windowVotes: [] };
    }

    // Convert raw 16-bit buffer (Int16) to Float32 array for the model
    // This creates a view into the underlying Buffer memory
    const int16Array = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, TOTAL_SAMPLES);
    
    // Normalize to [-1, 1] range expected by the model
    const float32Array = new Float32Array(TOTAL_SAMPLES);
    for (let i = 0; i < TOTAL_SAMPLES; i++) {
        // 32768.0 is 2^15, the maximum positive value for a signed 16-bit integer
        float32Array[i] = int16Array[i] / 32768.0; 
    }

    const windowVotes = [];
    
    // Process in 1-second windows (16000 samples)
    for (let i = 0; i < NUM_WINDOWS; i++) {
        tf.tidy(() => {
            const windowData = float32Array.subarray(
                i * AUDIO_LENGTH_SAMPLES,
                (i + 1) * AUDIO_LENGTH_SAMPLES
            );
            
            // Reshape to [1, 16000] and run prediction
            const inputTensor = tf.tensor(windowData, [1, AUDIO_LENGTH_SAMPLES]);
            
            const output = tmModel.predict(inputTensor);
            const prediction = output.dataSync();

            // Find the predicted class index and confidence
            const maxConfidence = Math.max(...prediction);
            const maxIndex = prediction.indexOf(maxConfidence);
            const predictedLabel = MODEL_LABELS[maxIndex];
            
            windowVotes.push(predictedLabel);
        });
    }
    
    // Calculate Consensus and Final Result
    const voteCounts = {};
    windowVotes.forEach(vote => {
        voteCounts[vote] = (voteCounts[vote] || 0) + 1;
    });

    let finalLabel = 'Background Noise'; // Default to the safest option
    let maxVotes = 0;

    for (const label in voteCounts) {
        if (voteCounts[label] > maxVotes) {
            maxVotes = voteCounts[label];
            finalLabel = label;
        }
    }

    const confidence = (maxVotes / NUM_WINDOWS) * 100;

    const result = {
        predictedClass: finalLabel,
        consensusConfidence: confidence,
        windowVotes: windowVotes,
    };
    
    return result;
}


// --- 6. CORE AUDIO PROCESSING AND UPLOAD ---

function processAndAnalyzeAudio() {
    if (audioChunks.length === 0 || processingFlag) {
        console.log("WARNING: Attempted upload but audioChunks array is empty or processing is already active.");
        return;
    }

    processingFlag = true;
    
    // 1. CONCATENATE ALL CHUNKS
    let rawBuffer = Buffer.concat(audioChunks);
    
    // CRITICAL SAFEGUARD: TRIM if oversized (to remove trailing text)
    if (rawBuffer.length > EXPECTED_RAW_SIZE) {
        rawBuffer = rawBuffer.subarray(0, EXPECTED_RAW_SIZE);
    }

    // 2. RUN AI PREDICTION
    console.log('Starting AI analysis...');
    const analysisResult = runPrediction(rawBuffer);
    console.log('AI Analysis Complete:', analysisResult);

    // 3. CREATE WAV FILE
    // 16000 Hz, Mono (1), 16-bit
    const wavBuffer = addWavHeader(rawBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString('base64');

    console.log(`Uploading to Firebase... Raw buffer size: ${rawBuffer.length} bytes.`);

    // Clear chunks immediately after processing starts
    audioChunks = [];

    // 4. UPLOAD to Firebase
    set(ref(db, 'latest_recording'), {
            timestamp: Date.now(),
            audioData: "data:audio/wav;base64," + base64Audio,
            // Add the prediction result to the database for redundancy/history
            prediction: analysisResult, 
            status: "ready"
        })
        .then(() => {
            console.log("Firebase Upload successful.");
            if (browserClient && browserClient.readyState === WebSocket.OPEN) {
                // 5. SEND RESULTS BACK TO BROWSER
                browserClient.send(JSON.stringify(analysisResult));
            }
        })
        .catch((error) => {
            console.error("Firebase upload error:", error);
        })
        .finally(() => {
            processingFlag = false;
        });
}


// --- 7. WEBSOCKET CONNECTION AND MESSAGE HANDLERS ---

let esp32InitialMessageReceived = false;

wss.on('connection', (ws, req) => {
    const clientType = req.url.includes("ESP32") ? "ESP32" : "Browser";
    console.log(`\n### NEW CONNECTION ESTABLISHED: ${clientType} ###`);

    if (clientType === "ESP32") {
        esp32Client = ws;
        esp32InitialMessageReceived = false;
    } else {
        browserClient = ws;
    }

    ws.on('message', (message) => {

        // A. Handle Binary Data (Audio from ESP32)
        if (clientType === "ESP32" && Buffer.isBuffer(message)) {

            const messageAsString = message.toString('utf8').trim();
            if (messageAsString === "ESP32_CONNECTED" && !esp32InitialMessageReceived) {
                 console.log(`[ESP32 Filter] Ignored initial identification message: "${messageAsString}"`);
                 esp32InitialMessageReceived = true;
                 return;
            }
            
            audioChunks.push(message);

            // Trigger processing immediately after the expected chunk count
            if (audioChunks.length >= EXPECTED_CHUNK_COUNT && !processingFlag) {
                console.log(`\n!!! CRITICAL HIT (CHUNK COUNT): Reached ${EXPECTED_CHUNK_COUNT} chunks. Starting Analysis...`);
                processAndAnalyzeAudio();
                return;
            }
            return;
        }

        // B. Handle Text Data
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Fallback trigger)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! FALLBACK HIT (TEXT SIGNAL): END_RECORDING received. Starting Analysis...");
            processAndAnalyzeAudio();
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
        
        // IMPORTANT: The browser client should no longer send PREDICT_REQUEST because 
        // the server now analyzes immediately after receiving the audio chunks.
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

// --- 8. START SERVER ---
server.listen(port, async () => {
    console.log(`Server listening on port ${port} (PRODUCTION MODE)`);
    // CRITICAL: Load the AI model on server startup
    await loadModel();
});
