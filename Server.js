const WebSocket = require('ws');
const admin = require('firebase-admin');

// --- 1. FIREBASE SETUP ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "carsense-abb24",
  "private_key_id": "c0d3b7375a64a2fb70199f6ec43da4695bc2ea04",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDhY9d5zoQpAiup\nZHhAySazHK3WPbaKdHaIJidjzO5b3aWFg4LmhR2iYDSQDHtHWrqoaolKtASzCBdD\n8THe6xHfDYGVwbRB/2wT/fTDbBka8SvYwIZNVtVB3Iqb8rr2GdYqNfBYE41QqJ3D\narWK4AFB2VA93Qzua7XDqakLGqRffbWDWOBbEDMuDMKob3wSNk7iS/ioMfnpvgcB\nWVh5VwA4TYdKTUWSpkxrY9ZD1QqG77Rs6/F3Csa4dX1Jxj6E0k/izKAVwm61outD\ndi6559lWMyqXZUQRZTg6X3C/wWBhdGwu6YCPtkFWaa7N2y4oL6uD6QhHd8l7dMYy\nHaymqv4zAgMBAAECggEAW/VzbdQvoder3sIKOkyXyI5T8sxdFOJtliETAyoSulKV\nfQLqPoljTOO5rmgZSEShUaOd/meyXyVW8LaQ5WW9dec5ztMoa6D+BK4h1jXdjFuH\nyzjJ0vYxrlyABR6k31ItSi2VsSnRB260Z427Ij1A5g/3KDZvVzuE/p7TRJ+LHxYT\nvC9NjS0rnAlVvw4pyZKU7eIUBDVanO2OSL2P+8NAbjKjQ50xfMwC9dDZC6SdSspA\ndExng5+TO0tR+QFxIf4CG22pBePk7SZ6nTwFKg84Mrqqfu8tixMlYvzPxlGxCFxp\ngZBOKbjzndPmcCQV4ynoR3CaWiWIg7lfevuwAXtgaQKBgQD/lKpAeKLL+yniyDe+\nbuu3c11NbvFI607ZBm3Tyzr5PLvjau+8nyHKFKIWk/ytgtOQscnF9uDgVYgucLHS\n21KiTQUNGeNXXr2md7qVIezY6/B9Glfxmu6BzwRdtGp7A7/uHwHWAnWGnuhGScM3\nNHJygJ5OwCC1bJGz9wJ/hVGFpwKBgQDhwn9jiOc8Fb5QOS404BeufiLDGTlZjTNb\n6dxMV+mIMIM8gkXPPm372DWJ1n09BAmmWB7F3z4VWSpvhWEvDejqNCLjDkh5alYo\ni60te6M+XAtY4viA7FA9XTGhdO1M9N/uWy2C6j6LEajBRsRV0ZwVLvq0+8B7artT\n1CeuGbSslQKBgBthZN/lTKOHs9QM2RP4tB4CKPO7t/O06cyMSMXQ1u+Olx5k/Wv6\nrFcG4NqEXiSEiH/O3CvuJ+dAooc/IX3Sa0bh83GU3WslxjGIUB/b85DFrgzo/pTu\noTCc6f3T7zhgjXZIMh0oREj4yy+EhXprjvs/VjZflOF60R0zkDvzH2mvAoGBAKE2\nMZ+TMISAhmFlI7DQYTjSi+JDzec75HP7ILxHftUox15bLJycWQ+hSkH+r3n1uypU\n/MyR6RR3ks0GMurWBP/RcSQwm+JP4+yaKXU0N9MdCWFU2t29YmMffIRuKdJtfscH\nxw0YVscaOiaicStTPiEGZjL9H2tCQTjQY/F4G8OtAoGBAICtbF1j1TLvnWC3aWiG\na4dnS/gv/tZcuW6ruGOYwEscNigMwj0O7dVsiQMhhiKE8dBwDYIpZh7OVQzRAywh\nlA803DnpvHfq7Grw+0UhBB1NyVCrZ0pZge7MjrJLhqPPoAvuDf3PmfEn5NEomNU/\nXt9qIw+SXVH57T2PKYbZlyJF\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@carsense-abb24.iam.gserviceaccount.com",
  "client_id": "111566575451857240436",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40carsense-abb24.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

// THE REPAIR LOGIC:
// This looks for the literal string "\n" and replaces it with an actual newline character.
if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "carsense-abb24.firebasestorage.app"
});

const bucket = admin.storage().bucket();
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

let audioChunks = [];
let browser = null;
let esp32 = null;

console.log(`🚀 CarSense Server active on port ${PORT}`);

// --- 2. WAV HEADER HELPER ---
function addWavHeader(rawBuffer, sampleRate) {
    const blockAlign = 2;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); // 16-bit
    header.write('data', 36);
    header.writeUInt32LE(rawBuffer.length, 40);
    return Buffer.concat([header, rawBuffer]);
}

// --- 3. WEBSOCKET HANDLER ---
wss.on('connection', (ws, req) => {
    const type = req.url.includes("type=ESP32") ? "ESP32" : "Browser";
    console.log(`✨ New Connection: ${type}`);

    if (type === "ESP32") esp32 = ws;
    if (type === "Browser") browser = ws;

    ws.on('message', (data, isBinary) => {
        if (!isBinary && data.length < 20) {
            const msgStr = data.toString().trim();
            console.log(`📩 COMMAND: ${msgStr}`);

            if (msgStr === "START") {
                audioChunks = [];
                if (esp32 && esp32.readyState === 1) esp32.send("START");
            } else if (msgStr === "STOP") {
                if (esp32 && esp32.readyState === 1) esp32.send("STOP");
                saveFile();
            }
        } 
        else if (isBinary || Buffer.isBuffer(data)) {
            audioChunks.push(data);
        }
    });

    ws.on('close', () => {
        console.log(`❌ ${type} disconnected`);
        if (type === "ESP32") esp32 = null;
        if (type === "Browser") browser = null;
    });
});

// --- 4. FIREBASE UPLOAD ---
async function saveFile() {
    try {
        if (audioChunks.length === 0) {
            console.log("❌ No audio received.");
            return;
        }

        console.log(`📦 Processing ${audioChunks.length} chunks...`);
        const rawBuffer = Buffer.concat(audioChunks);
        const wavBuffer = addWavHeader(rawBuffer, 16000); 

        const fileName = `scans/audio_${Date.now()}.wav`;
        const file = bucket.file(fileName);

        console.log(`📤 Uploading to Firebase: ${fileName}`);
        
        await file.save(wavBuffer, {
            metadata: { contentType: 'audio/wav' },
            resumable: false 
        });

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2030'
        });

        console.log("✅ File Ready! URL sent to Browser.");

        if (browser && browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ audioUrl: url }));
        }

        audioChunks = [];

    } catch (error) {
        console.error("🔥 Firebase Save Error:", error.message);
    }
}
