# Aarav: Real-Time Multilingual Voice AI Companion (Speech-to-Speech)
### Powered by Gemini Live Multimodal API & WebSockets

A full-stack, ultra-low-latency Speech-to-Speech (STS) conversational voice assistant named **Aarav**. Built using an **Express** backend and a **React (Vite + Tailwind CSS)** frontend, Aarav acts as your warm, supportive best friend who automatically detects and mirrors whichever language you speak in real time.

---

## 🌟 Core Features & Capabilities

- **Direct Live Speech-to-Speech (STS)**: Real-time, bidirectional audio streaming between the browser microphone and Gemini Multimodal Live API over WebSockets with zero intermediate text-to-speech transcoding steps.
- **Multilinguistic Mirroring**: Seamlessly switches languages mid-conversation. Speak in English, Kannada (ಕನ್ನಡ), Hindi (हिंदी), Tamil, Telugu, or any regional language—Aarav automatically detects language shifts and replies in the matching language with authentic regional flow and vocabulary.
- **Warm Friend Persona**: Expressive, natural vocal prosody with human-like warmth, laughter, conversational pacing, and friendly vocal fillers (*"Arre yaar"*, *"Acha"*, *"Haa"*, *"Bilkul"*, *"Bro"*, *"Buddy"*).
- **Instant Barge-In (Interruption Handling)**: Speak over the assistant at any time. The system immediately catches user speech, clears incoming audio buffers, and halts playback for natural conversational turn-taking.
- **Real-Time Latency & Metrics**: Built-in monitoring measuring round-trip turn latency (target <600ms), live audio waveform volume, and real-time conversation transcript feeds.

---

## 🏗️ System Architecture & Data Flow

```
[ Browser Microphone ]
        │ (WebAudio API: 16 kHz Linear PCM)
        ▼
[ Client WebSocket Client ]
        │ (wss://.../live-stream)
        ▼
[ Express Server (server.ts) ]
        │ (Bidirectional WebSocket)
        ▼
[ Gemini Multimodal Live API (gemini-3.1-flash-live-preview) ]
        │ (24 kHz Linear PCM Audio + Transcripts)
        ▼
[ Express Server (server.ts) ]
        │ (WebSocket payload forwarding)
        ▼
[ Client WebAudio Output ]
        └─ Gapless 24 kHz Float32 AudioBuffer Playback
```

---

## 🎙️ Audio Processing Pipeline

1. **Hardware-Agnostic Input Resampling**: 
   - Browser microphones operating at native sample rates (44.1 kHz / 48 kHz) are dynamically resampled in real time via linear interpolation to the standard **16 kHz Int16 PCM** required by Gemini Live.
2. **Binary Frame Streaming**:
   - Audio chunks are base64-encoded and sent over WebSocket to the backend, which forwards them directly via `session.sendRealtimeInput()`.
3. **High-Fidelity Output Playback**:
   - Gemini streams 24 kHz PCM audio packets. The frontend decodes the 16-bit signed integer samples directly to Float32 audio buffers, scheduling gapless playback via the Web Audio API.
4. **Interruption Signal**:
   - When `message.serverContent.interrupted` is received from Gemini, the client immediately cancels any active `AudioBufferSourceNode` objects and resets scheduling pointers.

---

## 📋 Environment Variables

Create or configure a `.env` file in the project root:

```env
# Gemini API Key (Required for Gemini Live Multimodal voice stream)
GEMINI_API_KEY=your_gemini_api_key_here
```

---

## 📦 Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Development Server**:
   ```bash
   npm run dev
   ```
   *Starts the Express server with Vite middleware on port 3000.*

3. **Build for Production**:
   ```bash
   npm run build
   ```
   *Builds the React frontend to `dist/` and bundles `server.ts` into a CommonJS server using esbuild.*

4. **Start Production Server**:
   ```bash
   npm run start
   ```

---

## 📁 Project Structure

- **`/server.ts`**: Express backend managing WebSocket connections (`/live-stream`), Gemini Live API session lifecycles, and transcript logging.
- **`/src/App.tsx`**: React frontend with WebAudio API capture, 16kHz resampling, gapless 24kHz playback, animated voice orb, latency meter, and real-time transcript feed.
- **`/metadata.json`**: App metadata and permissions configuration.
- **`/package.json`**: Project dependencies and build scripts.
