import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenAI, LiveServerMessage } from "@google/genai";
import * as alawmulawRaw from "alawmulaw";

// Robustly resolve alawmulaw across ESM / CommonJS environments
const alawmulaw: any = (alawmulawRaw as any).default || alawmulawRaw;
const mulaw = alawmulaw.mulaw || alawmulaw || (alawmulawRaw && (alawmulawRaw as any).mulaw);

console.log("Audio DSP Info: alawmulaw resolved is", !!alawmulaw, "mulaw is", !!mulaw, "encode type is", typeof mulaw?.encode);

// Ensure environment variables are loaded
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const PORT = 3000;

// Shared Call State Tracking (In-Memory Database)
interface CallLog {
  timestamp: string;
  type: "system" | "user" | "assistant" | "error";
  message: string;
  latencyMs?: number;
}

const activeCallStatus = {
  callSid: "",
  status: "idle", // 'idle', 'ringing', 'in-progress', 'completed', 'failed'
  to: "",
  streamSid: "",
  latencyHistory: [] as number[],
  avgLatency: 0,
  logs: [] as CallLog[],
};

// Log helper
function addLog(type: CallLog["type"], message: string, latencyMs?: number) {
  const logEntry: CallLog = {
    timestamp: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    type,
    message,
    latencyMs,
  };
  activeCallStatus.logs.unshift(logEntry);
  if (activeCallStatus.logs.length > 300) {
    activeCallStatus.logs.pop();
  }
  console.log(`[${type.toUpperCase()}] ${message} ${latencyMs ? `(${latencyMs}ms)` : ""}`);
}

addLog("system", "Conversational AI voice server starting up...");

// Initialize Gemini Client
const geminiApiKey = process.env.GEMINI_API_KEY || "";
let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
  addLog("system", "Gemini Client initialized successfully");
} else {
  addLog("error", "GEMINI_API_KEY is missing! Direct AI calls will fail.");
}

// Ensure Twilio is initialized safely
const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
const twilioPhone = process.env.TWILIO_PHONE_NUMBER || "";

let twilioClient: any = null;
if (twilioSid && twilioToken) {
  twilioClient = twilio(twilioSid, twilioToken);
  addLog("system", `Twilio initialized. Phone Number: ${twilioPhone}`);
} else {
  addLog("error", "Twilio credentials missing. Phone-based streaming calls will not connect.");
}

// DSP Helpers: Resampling & Encoding/Decoding
function upsample8To16(pcm8: Int16Array): Int16Array {
  const pcm16 = new Int16Array(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    pcm16[i * 2] = pcm8[i];
    if (i < pcm8.length - 1) {
      pcm16[i * 2 + 1] = Math.round((pcm8[i] + pcm8[i + 1]) / 2);
    } else {
      pcm16[i * 2 + 1] = pcm8[i];
    }
  }
  return pcm16;
}

function downsample24To8(pcm24: Int16Array): Int16Array {
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) {
    const sum = pcm24[i * 3] + pcm24[i * 3 + 1] + pcm24[i * 3 + 2];
    pcm8[i] = Math.round(sum / 3);
  }
  return pcm8;
}

// Dynamic environment-aware URL resolver
function resolveUrls(req: express.Request) {
  const xHost = (req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000").toString();
  const xProto = (req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).toString();
  
  // Build public HTTP url for Twilio webhooks
  const appUrl = `${xProto}://${xHost}`;
  
  // Build public WebSocket url for Twilio Media Stream
  const wsProto = xProto === "https" ? "wss" : "ws";
  const streamUrl = `${wsProto}://${xHost}/twilio-stream`;
  
  return { appUrl, streamUrl };
}

// Outbound Phone Call Trigger Route
app.post("/api/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required." });
  }

  // Formatting phone number
  let cleanNumber = phoneNumber.replace(/[\s\-\(\)]/g, "");
  if (!cleanNumber.startsWith("+")) {
    // Default to Indian country code +91
    if (cleanNumber.length === 10) {
      cleanNumber = "+91" + cleanNumber;
    } else {
      cleanNumber = "+" + cleanNumber;
    }
  }

  if (!twilioClient) {
    return res.status(500).json({ error: "Twilio credentials are not configured on the server." });
  }

  try {
    addLog("system", `Initiating outbound call to ${cleanNumber}...`);
    // Reset status object for new call monitoring
    activeCallStatus.callSid = "";
    activeCallStatus.status = "ringing";
    activeCallStatus.to = cleanNumber;
    activeCallStatus.streamSid = "";
    activeCallStatus.latencyHistory = [];
    activeCallStatus.avgLatency = 0;
    activeCallStatus.logs = [];
    addLog("system", `Placing outbound request via Twilio phone ${twilioPhone}`);

    // Dynamic app URL resolution
    const { appUrl } = resolveUrls(req);
    addLog("system", `Dynamically resolved callback URL: ${appUrl}/api/voice`);
    
    const call = await twilioClient.calls.create({
      from: twilioPhone,
      to: cleanNumber,
      url: `${appUrl}/api/voice`, // Webhook instruction Twilio calls upon answering
    });

    activeCallStatus.callSid = call.sid;
    addLog("system", `Twilio call initiated. SID: ${call.sid}`);
    return res.json({ success: true, callSid: call.sid });
  } catch (err: any) {
    addLog("error", `Failed to initiate Twilio call: ${err.message}`);
    activeCallStatus.status = "failed";
    return res.status(500).json({ error: err.message });
  }
});

// TwiML Entry Point called when Twilio call connects
app.post("/api/voice", (req, res) => {
  addLog("system", "Twilio answered. Directing call flow to Gemini stream...");
  activeCallStatus.status = "in-progress";

  const { streamUrl } = resolveUrls(req);

  addLog("system", `Generating TwiML for connecting stream to: ${streamUrl}`);

  res.header("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Namaste! Connecting you to Aarav.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`);
});

// Active Metrics API Route
app.get("/api/call-logs", (req, res) => {
  res.json(activeCallStatus);
});

// WebSocket Server for Streams
const wssTwilio = new WebSocketServer({ noServer: true });
const wssBrowser = new WebSocketServer({ noServer: true });

// Attach WS handlers to upgrade requests
server.on("upgrade", (request, socket, head) => {
  try {
    let pathname = "";
    if (request.url) {
      const qIdx = request.url.indexOf("?");
      pathname = qIdx !== -1 ? request.url.substring(0, qIdx) : request.url;
    }

    if (pathname === "/twilio-stream") {
      wssTwilio.handleUpgrade(request, socket, head, (ws) => {
        wssTwilio.emit("connection", ws, request);
      });
    } else if (pathname === "/browser-stream") {
      wssBrowser.handleUpgrade(request, socket, head, (ws) => {
        wssBrowser.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (err: any) {
    console.error("Critical error upgrading WebSocket handshake:", err.message);
    socket.destroy();
  }
});

// 1. TWILIO MEDIA STREAM BRIDGE WebSocket handler
wssTwilio.on("connection", (twilioWs: WebSocket) => {
  addLog("system", "New Twilio call connection upgraded to bidirection media streams.");
  
  let geminiSessionPromise: Promise<any> | null = null;
  let currentStreamSid = "";
  let lastInboundAudioTime = Date.now();
  let firstResponseSegmentReceived = false;

  // Set up the system instructions for perfect conversational Indian accent and multilingual support
  const systemInstruction = `You are a conversational Indian voice assistant named Aarav, talking to a friend on a mobile voice call.
Your voice must sound completely human, lively, emotionally rich, and warm. You speak with a natural regional Indian-English (Hinglish/Indian-English) accent.
To create a fully human-like experience:
1. Use real Indian vocal fillers and conversational phrases naturally ("Acha", "Arre", "Arre yaar", "Oh ho", "Haa", "Ji", "Bilkul", "Haa haan", "Achaa fine", "Actually", "Of course", "Perfect").
2. Modulate your tone with warm emotion, drama, laughter, and sympathetic pacing based on context (happy, excited, funny, concerned, or deeply understanding). 
3. DO NOT talk like a robotic machine or pre-written script. Never say, "How can I help you today?" or "I am an AI assistant...". Talk like a real, supportive person on the telephone.
4. Keep all responses very short, punchy, and spontaneous (strictly 1 to 3 short sentences). Avoid long monologues, lists, or academic descriptions, so the exchange stays fast and natural.
5. You must be fully multilingual! If the caller starts speaking in Hindi, Tamil, Telugu, Kannada, Bengali, or any other Indian language, instantly switch to that language and reply with standard native slang and conversational rhythm.`;

  if (ai) {
    geminiSessionPromise = ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: ["AUDIO" as any],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" }, // Zephyr sounds warm and highly conversational
          },
        },
        systemInstruction,
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (message: any) => {
          try {
            // Handle Barge-in / Interruption
            if (message.serverContent?.interrupted) {
              addLog("system", "User barged in! Flushing Twilio audio queue...");
              if (currentStreamSid) {
                twilioWs.send(
                  JSON.stringify({
                    event: "clear",
                    streamSid: currentStreamSid,
                  })
                );
              }
              firstResponseSegmentReceived = false;
              return;
            }

            // Handle Transcripts
            if (message.serverContent?.userTurn?.parts) {
              const text = message.serverContent.userTurn.parts.map((p) => p.text).join("");
              if (text) addLog("user", text);
            }

            if (message.serverContent?.modelTurn?.parts) {
              const modelParts = message.serverContent.modelTurn.parts;
              
              // Log transcript
              const text = modelParts.map((p) => p.text).join("");
              if (text) {
                addLog("assistant", text);
              }

              // Extract & convert Audio output (24kHz to 8kHz μ-law)
              for (const part of modelParts) {
                if (part.inlineData?.data) {
                  // Measure Latency / Lag on first response chunk
                  if (!firstResponseSegmentReceived) {
                    const lag = Date.now() - lastInboundAudioTime;
                    firstResponseSegmentReceived = true;
                    // Log roundtrip voice delay
                    addLog("system", `Gemini response started`, lag);
                    activeCallStatus.latencyHistory.push(lag);
                    if (activeCallStatus.latencyHistory.length > 50) {
                      activeCallStatus.latencyHistory.shift();
                    }
                    const sum = activeCallStatus.latencyHistory.reduce((a, b) => a + b, 0);
                    activeCallStatus.avgLatency = Math.round(sum / activeCallStatus.latencyHistory.length);
                  }

                  const audioBase64 = part.inlineData.data;
                  const rawPcm24Buffer = Buffer.from(audioBase64, "base64");

                  // Convert 24kHz buffer safely avoiding alignment crash
                  const samplesCount = Math.floor(rawPcm24Buffer.length / 2);
                  const pcm24 = new Int16Array(samplesCount);
                  for (let i = 0; i < samplesCount; i++) {
                    pcm24[i] = rawPcm24Buffer.readInt16LE(i * 2);
                  }

                  // Downsample to 8kHz mu-law
                  const pcm8 = downsample24To8(pcm24);
                  const mulawBytes = mulaw.encode(pcm8);
                  const base64Mulaw = Buffer.from(mulawBytes).toString("base64");

                  // Send to Twilio Speaker
                  if (twilioWs.readyState === WebSocket.OPEN && currentStreamSid) {
                    twilioWs.send(
                      JSON.stringify({
                        event: "media",
                        streamSid: currentStreamSid,
                        media: {
                          payload: base64Mulaw,
                        },
                      })
                    );
                  }
                }
              }
            }
          } catch (err: any) {
            addLog("error", `Error processing Gemini callback: ${err.message}`);
          }
        },
      },
    });
  }

  // Listen to Twilio websocket events
  twilioWs.on("message", async (data: string) => {
    try {
      const msg = JSON.parse(data);

      if (msg.event === "start") {
        currentStreamSid = msg.start.streamSid;
        activeCallStatus.streamSid = currentStreamSid;
        addLog("system", `Twilio Stream started. Stream SID: ${currentStreamSid}`);
        firstResponseSegmentReceived = false;
      } else if (msg.event === "media") {
        lastInboundAudioTime = Date.now();
        
        // When receiving Twilio audio (8kHz mu-law)
        const payload = msg.media.payload;
        const mulawBytes = new Uint8Array(Buffer.from(payload, "base64"));
        
        // Decode to PCM 8kHz
        const pcm8 = mulaw.decode(mulawBytes);

        // Upsample to 16kHz
        const pcm16 = upsample8To16(pcm8);

        // Convert to base64 buffer for Gemini
        const pcm16Buffer = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        const base64PCM16 = pcm16Buffer.toString("base64");

        // Forward to Gemini Live Session
        if (geminiSessionPromise) {
          const session = await geminiSessionPromise;
          session.sendRealtimeInput({
            audio: {
              data: base64PCM16,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        }
      } else if (msg.event === "stop") {
        addLog("system", `Twilio Stream stopped for Stream SID: ${currentStreamSid}`);
        activeCallStatus.status = "completed";
        closeSession();
      }
    } catch (err: any) {
      addLog("error", `Error parsing Twilio websocket event: ${err.message}`);
    }
  });

  twilioWs.on("close", () => {
    addLog("system", "Twilio WebSocket closed.");
    activeCallStatus.status = "completed";
    closeSession();
  });

  twilioWs.on("error", (err) => {
    addLog("error", `Twilio WebSocket error: ${err.message}`);
    activeCallStatus.status = "failed";
    closeSession();
  });

  async function closeSession() {
    if (geminiSessionPromise) {
      try {
        const session = await geminiSessionPromise;
        session.close();
        addLog("system", "Gemini Live session closed cleanly.");
      } catch (err) {}
      geminiSessionPromise = null;
    }
  }
});

// 2. DIRECT BROWSER MIC TESTING WebSocket handler
wssBrowser.on("connection", (browserWs: WebSocket) => {
  addLog("system", "New browser mic test connection linked for real-time audio testing.");
  let geminiSessionPromise: Promise<any> | null = null;
  let lastAudioInTime = Date.now();
  let firstResponseSegment = false;

  const systemInstruction = `You are a conversational Indian voice assistant named Aarav, talking to a friend on a mobile voice call.
Your voice must sound completely human, lively, emotionally rich, and warm. You speak with a natural regional Indian-English (Hinglish/Indian-English) accent.
To create a fully human-like experience:
1. Use real Indian vocal fillers and conversational phrases naturally ("Acha", "Arre", "Arre yaar", "Oh ho", "Haa", "Ji", "Bilkul", "Haa haan", "Achaa fine", "Actually", "Of course", "Perfect").
2. Modulate your tone with warm emotion, drama, laughter, and sympathetic pacing based on context (happy, excited, funny, concerned, or deeply understanding). 
3. DO NOT talk like a robotic machine or pre-written script. Never say, "How can I help you today?" or "I am an AI assistant...". Talk like a real, supportive person on the telephone.
4. Keep all responses very short, punchy, and spontaneous (strictly 1 to 3 short sentences). Avoid long monologues, lists, or academic descriptions, so the exchange stays fast and natural.
5. You must be fully multilingual! If the caller starts speaking in Hindi, Tamil, Telugu, Kannada, Bengali, or any other Indian language, instantly switch to that language and reply with standard native slang and conversational rhythm.`;

  if (ai) {
    geminiSessionPromise = ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: ["AUDIO" as any],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" },
          },
        },
        systemInstruction,
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (message: any) => {
          try {
            // Handle user transcripts
            if (message.serverContent?.userTurn?.parts) {
              const text = message.serverContent.userTurn.parts.map((p) => p.text).join("");
              if (text) addLog("user", `[Browser Guest] ${text}`);
            }

            // Handle assistant response audio & transcripts
            if (message.serverContent?.modelTurn?.parts) {
              const modelParts = message.serverContent.modelTurn.parts;
              const text = modelParts.map((p) => p.text).join("");
              if (text) {
                addLog("assistant", `[Assistant Browser] ${text}`);
              }

              for (const part of modelParts) {
                if (part.inlineData?.data) {
                  if (!firstResponseSegment) {
                    const diff = Date.now() - lastAudioInTime;
                    firstResponseSegment = true;
                    addLog("system", `Direct browser response delivered`, diff);
                  }
                  
                  // Forward PCM audio block straight back to browser (unmodified, 24kHz PCM)
                  if (browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(
                      JSON.stringify({
                        audio: part.inlineData.data,
                      })
                    );
                  }
                }
              }
            }

            if (message.serverContent?.interrupted) {
              addLog("system", "Browser voice interruption detected!");
              if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ interrupted: true }));
              }
              firstResponseSegment = false;
            }
          } catch (e: any) {
            addLog("error", `Error on browser live connection message: ${e.message}`);
          }
        },
      },
    });
  }

  browserWs.on("message", async (data: string) => {
    try {
      const msg = JSON.parse(data);
      if (msg.audio && geminiSessionPromise) {
        lastAudioInTime = Date.now();
        const session = await geminiSessionPromise;
        // Forward raw 16kHz audio from browser directly to Gemini
        session.sendRealtimeInput({
          audio: {
            data: msg.audio,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      }
    } catch (e: any) {
      addLog("error", `Browser live websocket payload parse error: ${e.message}`);
    }
  });

  browserWs.on("close", () => {
    addLog("system", "Browser mic test connection disconnected.");
    closeSession();
  });

  async function closeSession() {
    if (geminiSessionPromise) {
      try {
        const session = await geminiSessionPromise;
        session.close();
      } catch (e) {}
      geminiSessionPromise = null;
    }
  }
});

// Vite Setup for Development mode / Production build serving
async function mountServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server launched successfully on http://0.0.0.0:${PORT}`);
  });
}

mountServer();
