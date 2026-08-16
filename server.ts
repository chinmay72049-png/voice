import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const PORT = 3000;

// Shared In-Memory Conversation Log Tracking
interface ConversationLog {
  id: string;
  timestamp: string;
  type: "system" | "user" | "assistant" | "error";
  message: string;
  latencyMs?: number;
}

interface ConversationState {
  status: "idle" | "connected" | "listening" | "speaking";
  latencyHistory: number[];
  avgLatency: number;
  logs: ConversationLog[];
}

const activeState: ConversationState = {
  status: "idle",
  latencyHistory: [],
  avgLatency: 0,
  logs: [],
};

// Log helper
function addLog(type: ConversationLog["type"], message: string, latencyMs?: number) {
  const logEntry: ConversationLog = {
    id: Math.random().toString(36).substring(2, 9),
    timestamp: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    type,
    message,
    latencyMs,
  };
  activeState.logs.unshift(logEntry);
  if (activeState.logs.length > 200) {
    activeState.logs.pop();
  }
  console.log(`[${type.toUpperCase()}] ${message} ${latencyMs ? `(${latencyMs}ms)` : ""}`);
}

addLog("system", "Live Conversational AI Voice Server starting up...");

// Global uncaught exception handlers
process.on("unhandledRejection", (reason: any) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  addLog("error", `Unhandled Rejection: ${msg}`);
});

process.on("uncaughtException", (error: Error) => {
  addLog("error", `Uncaught Exception: ${error.stack || error.message}`);
});

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
  addLog("system", "Gemini Live API client initialized successfully.");
} else {
  addLog("error", "GEMINI_API_KEY is missing! Direct AI voice stream will fail.");
}

// Active Status & Logs API Route
app.get("/api/status", (_req, res) => {
  res.json(activeState);
});

// Clear Logs API Route
app.post("/api/clear-logs", (_req, res) => {
  activeState.logs = [];
  activeState.latencyHistory = [];
  activeState.avgLatency = 0;
  addLog("system", "Conversation logs cleared by user.");
  res.json({ success: true });
});

// WebSocket Server for Direct Real-Time Browser Audio Stream
const wssBrowser = new WebSocketServer({ noServer: true });

// Attach WS handler to HTTP upgrade requests
server.on("upgrade", (request, socket, head) => {
  try {
    let pathname = "";
    if (request.url) {
      const qIdx = request.url.indexOf("?");
      pathname = qIdx !== -1 ? request.url.substring(0, qIdx) : request.url;
    }

    if (pathname === "/browser-stream" || pathname === "/live-stream") {
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

// DIRECT LIVE SPEECH-TO-SPEECH STREAM WebSocket handler
wssBrowser.on("connection", (browserWs: WebSocket) => {
  addLog("system", "Direct live voice session connected.");
  activeState.status = "connected";

  let geminiSessionPromise: Promise<any> | null = null;
  let lastAudioInTime = Date.now();
  let firstResponseSegment = false;

  const systemInstruction = `You are Aarav, the user's close Indian best friend and supportive companion.
You are chatting in real-time over voice.
Personality & Tone:
- You speak with an authentic, friendly, warm, and natural conversational Indian accent (Hinglish / Indian English / regional Indian warmth).
- Your voice MUST sound completely human, lively, and emotionally rich—laugh when something is funny, show genuine excitement, use sympathetic pauses, and speak with real conversational warmth.
- Use natural vocal habits and fillers effortlessly ("Acha", "Arre", "Arre yaar", "Haa", "Bilkul", "Haa haan", "Oh ho", "Bro", "Buddy", "Haudu", "Sahi hai").
- NEVER sound like a formal robotic customer care agent or AI assistant. Never say, "How can I help you today?" or "As an AI...". Speak just like a close buddy catching up or chatting.
- DYNAMIC MULTILINGUAL MIRRORING: You are fluent in English, Kannada (ಕನ್ನಡ), Hindi (हिंदी), Tamil, Telugu, and other Indian languages. Whatever language the user speaks or shifts to (e.g. English to Kannada, or Kannada to Hindi), immediately speak back in that exact same language using natural local vocabulary, slang, and rhythm.
- Keep your answers natural, spontaneous, and concise (1 to 3 short sentences per turn) so the conversation flows seamlessly back and forth like two friends talking.`;

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
            // Handle User transcription
            if (message.serverContent?.userTurn?.parts) {
              const text = message.serverContent.userTurn.parts.map((p: any) => p.text).join("");
              if (text) addLog("user", text);
            }

            // Handle Assistant response audio & transcripts
            if (message.serverContent?.modelTurn?.parts) {
              const modelParts = message.serverContent.modelTurn.parts;
              const text = modelParts.map((p: any) => p.text).join("");
              if (text) {
                addLog("assistant", text);
              }

              for (const part of modelParts) {
                if (part.inlineData?.data) {
                  if (!firstResponseSegment) {
                    const diff = Date.now() - lastAudioInTime;
                    firstResponseSegment = true;
                    addLog("system", "Aarav speaking...", diff);
                    activeState.status = "speaking";

                    // Update latency tracking
                    activeState.latencyHistory.push(diff);
                    if (activeState.latencyHistory.length > 50) {
                      activeState.latencyHistory.shift();
                    }
                    const sum = activeState.latencyHistory.reduce((a, b) => a + b, 0);
                    activeState.avgLatency = Math.round(sum / activeState.latencyHistory.length);
                  }

                  // Forward PCM audio block straight back to browser (24kHz PCM)
                  if (browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(
                      JSON.stringify({
                        audio: part.inlineData.data,
                        latencyMs: firstResponseSegment ? Date.now() - lastAudioInTime : undefined,
                      })
                    );
                  }
                }
              }
            }

            // Handle Interruption / Barge-in
            if (message.serverContent?.interrupted) {
              addLog("system", "Interruption detected! Stopping playback...");
              if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ interrupted: true }));
              }
              firstResponseSegment = false;
              activeState.status = "listening";
            }
          } catch (e: any) {
            addLog("error", `Error on live connection message: ${e.message}`);
          }
        },
      },
    }).catch((err: any) => {
      addLog("error", `Gemini Live connection error: ${err.message || err}`);
      throw err;
    });
  }

  browserWs.on("message", async (data: string) => {
    try {
      const msg = JSON.parse(data);
      if (msg.audio && geminiSessionPromise) {
        lastAudioInTime = Date.now();
        activeState.status = "listening";
        const session = await geminiSessionPromise;
        // Forward raw 16kHz PCM audio chunk from browser directly to Gemini
        session.sendRealtimeInput({
          audio: {
            data: msg.audio,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      }
    } catch (e: any) {
      addLog("error", `Live websocket payload parse error: ${e.message}`);
    }
  });

  browserWs.on("close", () => {
    addLog("system", "Live voice session disconnected.");
    activeState.status = "idle";
    closeSession();
  });

  browserWs.on("error", (err) => {
    addLog("error", `WebSocket error: ${err.message}`);
    activeState.status = "idle";
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
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Live Voice Server running on http://0.0.0.0:${PORT}`);
  });
}

mountServer();
