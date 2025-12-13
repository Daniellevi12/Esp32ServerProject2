// server.js (FINAL ROBUST VERSION: Prediction Enabled + Chunk Count Trigger)

// --- REQUIRED PURE JS MODULES ---
const WebSocket = require('ws');
const http = require('http'); 
// CRITICAL FIX FOR FETCH ERROR: Ensure fetch is available globally
const nodeFetch = require('node-fetch'); 
global.fetch = nodeFetch; 
const { AudioContext } = require('web-audio-api'); 
const tf = require('@tensorflow/tfjs'); 
require('@tensorflow/tfjs-backend-cpu'); 
const { Buffer } = require('buffer'); // Ensure Buffer is available

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

// --- 2. AI MODEL CONFIGURATION ---
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/7KA0738CC/model.json";
const CLASS_LABELS = ["_background_noise_", "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7", "Class 8", "Class 9"];
const NUM_FRAMES = 43;
const NUM_FEATURE_BINS = 232;
const EPSILON = 1e-7;

let aiModel = null;
const audioContext = new AudioContext(); 

// --- 3. SERVER SETUP & CLIENT TRACKING ---
const server = http.createServer(); 
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let browserClient = null;
let audioChunks = [];
let processingFlag = false; // Prevents double-processing
const EXPECTED_CHUNK_COUNT = 313; // 10 seconds of 16kHz audio / 1024-byte chunks = ~312.5. We use 313.

// --- 4. AI HELPER FUNCTIONS ---
function normalizeTensor(tensor) {
    const d = EPSILON;
    return tf.tidy(() => {
        const n = tf.mean(tensor);
        const diff = tf.sub(tensor, n);
        const squaredDiff = tf.square(diff);
        const a = tf.mean(squaredDiff);
        return tf.div(diff, tf.add(tf.sqrt(a), d));
    });
}
async function initializeModel() {
    console.log("Loading AI model on server using pure JavaScript backend...");
    tf.setBackend('cpu');
    try {
        aiModel = await tf.loadLayersModel(MODEL_URL);
        console.log("✅ AI Model Loaded successfully on server (Backend: CPU/Pure JS).");
    } catch (e) {
        console.error("❌ Failed to load AI model on server:", e.message);
    }
}


// --- 5. CORE AI PREDICTION LOGIC ---

async function runPrediction(audioDataUrl, ws) {
    if (!aiModel) {
        console.error("Model not loaded. Aborting prediction.");
        return;
    }

    try {
        console.log("Starting server-side prediction (Pure JS backend)...");

        // Uses global.fetch (fixed above)
        const response = await global.fetch(audioDataUrl); 
        const arrayBuffer = await response.arrayBuffer();

        const audioBuffer = await new Promise((resolve, reject) => {
            audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        });

        // --- Prediction logic (unchanged) ---
        const targetSampleRate = 16000;
        const fftSize = 1024;
        const rawAudioData = audioBuffer.getChannelData(0);
        const totalDuration = audioBuffer.duration;
        const totalWindows = Math.floor(totalDuration);
        const allPredictions = [];

        const frameLength = Math.round(targetSampleRate * 0.025);
        const frameStep = Math.round(targetSampleRate * 0.010);

        // C. Prediction Loop
        for (let i = 0; i < totalWindows; i++) {
            tf.tidy(() => {
                const startSample = i * audioBuffer.sampleRate;
                const endSample = startSample + audioBuffer.sampleRate;
                const windowData = rawAudioData.slice(startSample, endSample);

                const audioTensor = tf.tensor1d(windowData);
                const stft = tf.signal.stft(audioTensor, frameLength, frameStep, fftSize, (length) => tf.signal.hannWindow(length));
                const magnitude = tf.abs(stft);
                let logMagnitude = tf.log(magnitude).slice([0, 0], [-1, NUM_FEATURE_BINS]);

                if (logMagnitude.shape[0] > NUM_FRAMES) {
                    logMagnitude = logMagnitude.slice([0, 0], [NUM_FRAMES, -1]);
                } else if (logMagnitude.shape[0] < NUM_FRAMES) {
                    const padding = tf.zeros([NUM_FRAMES - logMagnitude.shape[0], NUM_FEATURE_BINS]);
                    logMagnitude = logMagnitude.concat(padding, 0);
                }

                const normalizedFeatures = normalizeTensor(logMagnitude);
                const spectrogramTensor = normalizedFeatures.expandDims(0).expandDims(-1);

                const predictionTensor = aiModel.predict(spectrogramTensor);
                const scoresArray = predictionTensor.dataSync();

                const maxScoreIndex = scoresArray.indexOf(Math.max(...scoresArray));
                allPredictions.push(CLASS_LABELS[maxScoreIndex]);
            });
        }

        // D. Consolidate Results (VOTING)
        const counts = {};
        allPredictions.forEach(x => { counts[x] = (counts[x] || 0) + 1; });

        let predictedClass = '';
        let maxCount = 0;
        for (const label in counts) {
            if (counts[label] > maxCount) {
                maxCount = counts[label];
                predictedClass = label;
            }
        }

        const totalSuccessfulWindows = allPredictions.length;
        const consensusConfidence = (maxCount / totalSuccessfulWindows) * 100;

        const predictionResult = {
            predictedClass: predictedClass,
            consensusConfidence: consensusConfidence,
            windowsPredicted: allPredictions
        };

        // Send the JSON result back to the browser
        ws.send(JSON.stringify(predictionResult));
        console.log(`Prediction result sent back: ${predictionResult.predictedClass}`);

    } catch (error) {
        console.error("Server Prediction Error:", error);
        ws.send(JSON.stringify({ predictedClass: "Prediction Failed (Server Error)", confidence: 0, windowsPredicted: [] }));
    } finally {
        processingFlag = false; // Reset flag after processing completes
    }
}


// --- 6. AUDIO PROCESSING (RAW PCM -> WAV -> FIREBASE) ---

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

    console.log(`Uploading to Firebase... Raw buffer size: ${rawBuffer.length} bytes. Total chunks processed: ${audioChunks.length}`);
    
    // Clear chunks immediately after processing starts
    audioChunks = []; 

    set(ref(db, 'latest_recording'), {
            timestamp: Date.now(),
            audioData: "data:audio/wav;base64," + base64Audio,
            status: "ready"
        })
        .then(() => {
            console.log("Firebase Upload successful! Signalling browser...");
            if (browserClient && browserClient.readyState === WebSocket.OPEN) {
                // Signals the HTML to fetch the data and start the prediction sequence.
                browserClient.send("UPLOAD_COMPLETE");
            }
        })
        .catch((error) => {
            console.error("Firebase upload error:", error);
        })
        .finally(() => {
            // Reset flag after all async operations complete
            processingFlag = false; 
        });
}


// --- 7. WEBSOCKET CONNECTION AND MESSAGE HANDLERS (CRITICAL FIX APPLIED HERE) ---

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
            
            // CRITICAL FIX: Trigger processing immediately after the expected chunk count to avoid tiny chunk crashes
            if (audioChunks.length >= EXPECTED_CHUNK_COUNT && !processingFlag) { 
                console.log(`!!! CRITICAL HIT (CHUNK COUNT): Reached ${EXPECTED_CHUNK_COUNT} chunks. Starting upload...`);
                processAndUploadAudio();
                return; 
            }
            return;
        }

        // B. Handle Text Data 
        let msgString = message.toString().trim();

        // 1. Check for 'END_RECORDING' (Fallback trigger if chunk count is missed)
        if (msgString === "END_RECORDING" && !processingFlag) {
            console.log("!!! FALLBACK HIT (TEXT SIGNAL): END_RECORDING received. Starting upload..."); 
            processAndUploadAudio();
            return;
        }

        // 2. Check for JSON requests from the browser
        try {
            const data = JSON.parse(msgString);
            if (data.type === 'PREDICT_REQUEST' && data.audioUrl) {
                console.log(`[Browser] Prediction Request received.`);
                runPrediction(data.audioUrl, ws);
                return;
            }
        } catch (e) {
            // Not a JSON object, proceed to check for simple commands
        }

        // 3. Check for simple commands
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

// --- 8. START SERVER AND MODEL ---
server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    initializeModel(); 
});
