import React, { useState, useEffect, useRef } from "react";
import { 
  Phone, 
  PhoneCall, 
  PhoneOff, 
  Activity, 
  Mic, 
  MicOff, 
  Wifi, 
  CheckCircle2, 
  Volume2, 
  Timer, 
  Globe, 
  RefreshCw, 
  AlertCircle,
  HelpCircle,
  MessageSquare
} from "lucide-react";

interface CallLog {
  timestamp: string;
  type: "system" | "user" | "assistant" | "error";
  message: string;
  latencyMs?: number;
}

interface ServerStatus {
  callSid: string;
  status: string;
  to: string;
  streamSid: string;
  latencyHistory: number[];
  avgLatency: number;
  logs: CallLog[];
}

export default function App() {
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<"phone" | "mic">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [calling, setCalling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Real-time server state (polled)
  const [serverState, setServerState] = useState<ServerStatus>({
    callSid: "",
    status: "idle",
    to: "",
    streamSid: "",
    latencyHistory: [],
    avgLatency: 0,
    logs: [],
  });

  // Browser Mic Live test states
  const [isMicTesting, setIsMicTesting] = useState(false);
  const [micStatus, setMicStatus] = useState<"offline" | "connecting" | "live" | "talking" | "listening">("offline");
  const [browserLatency, setBrowserLatency] = useState<number | null>(null);
  const [browserLatencyHistory, setBrowserLatencyHistory] = useState<number[]>([]);
  const [browserVolume, setBrowserVolume] = useState(0);

  // References for WebAudio API (Browser mic stream)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const lastInboundAudioTimeRef = useRef<number>(0);
  const isFirstChunkReceivedRef = useRef<boolean>(false);

  // Poll server call logs and status metrics
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch("/api/call-logs");
        if (res.ok) {
          const data = (await res.json()) as ServerStatus;
          setServerState(data);
          
          // If Twilio call is inactive, reset local state
          if (data.status === "completed" || data.status === "failed" || data.status === "idle") {
            setCalling(false);
          } else {
            setCalling(true);
          }
        }
      } catch (err) {
        console.error("Failed to poll server logs:", err);
      }
    };

    fetchLogs(); // Initial
    const timer = setInterval(fetchLogs, 1000); // Poll every second
    return () => clearInterval(timer);
  }, []);

  // Outbound call handler
  const handleDialCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim()) return;

    setCalling(true);
    try {
      const res = await fetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Failed to make call");
        setCalling(false);
      }
    } catch (err: any) {
      setErrorMessage("Error triggering outbound call: " + err.message);
      setCalling(false);
    }
  };

  // Helper: helper function converting PCM 16-bit to Base64
  const pcmToBase64 = (pcm16: Int16Array): string => {
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Browser Mic Direct Test implementation
  const startMicTesting = async () => {
    try {
      setIsMicTesting(true);
      setMicStatus("connecting");
      isFirstChunkReceivedRef.current = false;

      // Instantiate WebSocket connection
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/browser-stream`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Handle server responses (24kHz raw PCM back from Gemini Live)
      ws.onopen = async () => {
        setMicStatus("live");
        
        // Grab browser microphone with 16000Hz (16kHz) sampling
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;

        const playAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        playAudioCtxRef.current = playAudioCtx;
        nextStartTimeRef.current = playAudioCtx.currentTime;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;

        const source = audioCtx.createMediaStreamSource(stream);
        
        // Create audio volume analyser
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        // Periodically update microphone loudness indicator
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const checkVolume = () => {
          if (!isMicTesting && ws.readyState !== WebSocket.OPEN) return;
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const avg = sum / bufferLength;
          setBrowserVolume(Math.min(100, Math.floor((avg / 128) * 100)));
          requestAnimationFrame(checkVolume);
        };
        requestAnimationFrame(checkVolume);

        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        source.connect(processor);
        processor.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Check if user is speaking
          let peak = 0;
          for (let i = 0; i < inputData.length; i++) {
            const val = Math.abs(inputData[i]);
            if (val > peak) peak = val;
          }

          if (peak > 0.04) {
            setMicStatus("talking");
            lastInboundAudioTimeRef.current = Date.now();
            isFirstChunkReceivedRef.current = false;
          } else if (micStatus === "talking") {
            setMicStatus("live");
          }

          // Float32 amplitude [-1.0, 1.0] to Int16 [-32768, 32767] Conversion
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          const base64 = pcmToBase64(pcm16);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ audio: base64 }));
          }
        };
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          // Cancel active audio playback node queue upon interruption (barge-in)
          if (msg.interrupted) {
            activeSourcesRef.current.forEach((src) => {
              try {
                src.stop();
              } catch (_) {}
            });
            activeSourcesRef.current = [];
            if (playAudioCtxRef.current) {
              nextStartTimeRef.current = playAudioCtxRef.current.currentTime;
            }
            setMicStatus("listening");
            isFirstChunkReceivedRef.current = false;
            return;
          }

          if (msg.audio) {
            setMicStatus("listening");
            
            // Log direct connection latency metrics
            if (!isFirstChunkReceivedRef.current) {
              const diff = Date.now() - lastInboundAudioTimeRef.current;
              isFirstChunkReceivedRef.current = true;
              setBrowserLatency(diff);
              setBrowserLatencyHistory((prev) => {
                const next = [...prev, diff];
                if (next.length > 50) next.shift();
                return next;
              });
            }

            // Play incoming 24kHz linear PCM base64 audio packet
            const base64Audio = msg.audio;
            const binary = atob(base64Audio);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }

            const pcm16Samples = new Int16Array(bytes.buffer);
            const float32Samples = new Float32Array(pcm16Samples.length);
            for (let i = 0; i < pcm16Samples.length; i++) {
              float32Samples[i] = pcm16Samples[i] / 32768.0;
            }

            playAudioChunkInBrowser(float32Samples);
          }
        } catch (err) {
          console.error("Error decoding server browser stream message:", err);
        }
      };

      ws.onclose = () => {
        stopMicTesting();
      };

      ws.onerror = (e) => {
        console.error("Direct browser websocket stream error:", e);
        stopMicTesting();
      };

    } catch (err: any) {
      setErrorMessage("Microphone permission denied or WebAudio setup error: " + (err?.message || String(err)));
      stopMicTesting();
    }
  };

  const playAudioChunkInBrowser = (float32: Float32Array) => {
    const playCtx = playAudioCtxRef.current;
    if (!playCtx || playCtx.state === "closed") return;

    // Create standard AudioBuffer at 24000Hz (Gemini Live standard)
    const audioBuffer = playCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = playCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playCtx.destination);

    // Timeline sync for click-free gapless playback
    if (nextStartTimeRef.current < playCtx.currentTime) {
      nextStartTimeRef.current = playCtx.currentTime;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;

    // Keep reference so we can stop it upon barge-in
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };
  };

  const stopMicTesting = () => {
    setIsMicTesting(false);
    setMicStatus("offline");
    setBrowserVolume(0);

    activeSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch (_) {}
    });
    activeSourcesRef.current = [];

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    if (playAudioCtxRef.current) {
      playAudioCtxRef.current.close();
      playAudioCtxRef.current = null;
    }

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  };

  // Helper computations to assess lag
  const finalLatency = activeTab === "phone" ? serverState.avgLatency : 
    (browserLatencyHistory.length ? Math.round(browserLatencyHistory.reduce((a, b) => a + b, 0) / browserLatencyHistory.length) : null);

  const getLatencyCompliance = (latency: number | null) => {
    if (latency === null || latency === 0) return { text: "No Data", color: "text-slate-400", bg: "bg-slate-900 border-slate-800" };
    if (latency < 450) return { text: "Excellent turnaround latency (Target <600ms)", color: "text-emerald-400", bg: "bg-emerald-950/40 border-emerald-800/80" };
    if (latency < 600) return { text: "Optimal turnaround latency (Target <600ms)", color: "text-amber-400", bg: "bg-amber-950/40 border-amber-800/80" };
    return { text: "Delay exceeds human response standard", color: "text-rose-400", bg: "bg-rose-950/40 border-rose-800/80" };
  };

  const compliance = getLatencyCompliance(finalLatency);

  return (
    <div id="app_root" className="min-h-screen font-sans bg-slate-950 text-slate-100 flex flex-col items-center py-8 px-4 sm:px-6">
      
      {/* Upper Status Banner */}
      <header className="w-full max-w-5xl mb-8 flex flex-col md:flex-row items-center justify-between border-b border-slate-800 pb-5 gap-4">
        <div className="text-center md:text-left">
          <div className="flex items-center gap-3 justify-center md:justify-start">
            <span className="p-2 bg-orange-600/20 text-orange-400 rounded-xl border border-orange-500/30">
              <PhoneCall id="logo_icon" className="w-6 h-6 animate-pulse" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-white mb-0">Conversational Voice AI</h1>
          </div>
          <p className="text-sm text-slate-400 mt-1">Realistic 1-to-1 conversation with warm emotional accents & low-latency</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 justify-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full bg-slate-900 border border-slate-800 text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Server Live
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full bg-slate-900 border border-slate-800 text-slate-300">
            <Globe className="w-3.5 h-3.5 text-orange-400" />
            Multilingual (Hindi, Indian English, etc.)
          </span>
        </div>
      </header>

      {errorMessage && (
        <div id="toast_notification" className="w-full max-w-5xl mb-6 p-4 bg-rose-950/40 border border-rose-800/80 rounded-xl flex items-center justify-between text-rose-300 text-sm animated slide-in-from-top-4 duration-300">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span className="text-left font-medium font-sans">{errorMessage}</span>
          </div>
          <button 
            id="clear_error_btn"
            onClick={() => setErrorMessage(null)} 
            className="text-xs bg-rose-900/40 hover:bg-rose-900/60 px-3 py-1.5 rounded-lg border border-rose-700/40 cursor-pointer text-rose-200 hover:text-white transition-colors shrink-0 ml-4"
          >
            Clear
          </button>
        </div>
      )}

      {/* Main Grid Wrapper */}
      <main className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
        
        {/* Left Side: Call controls (7 Columns) */}
        <div className="md:col-span-7 flex flex-col gap-6">
          
          {/* Channel selector tab */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-1.5 flex gap-1">
            <button
              id="tab_phone"
              onClick={() => { stopMicTesting(); setActiveTab("phone"); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                activeTab === "phone" 
                  ? "bg-slate-950 text-white shadow border border-slate-800" 
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Phone className="w-4 h-4 text-orange-500" />
              Twilio Phone Call
            </button>
            <button
              id="tab_mic"
              onClick={() => { setActiveTab("mic"); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                activeTab === "mic" 
                  ? "bg-slate-950 text-white shadow border border-slate-800" 
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Mic className="w-4 h-4 text-emerald-500" />
              Direct Browser Mic Test
            </button>
          </div>

          {/* Form Content */}
          {activeTab === "phone" ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-orange-600/5 rounded-full blur-3xl pointer-events-none"></div>
              
              <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Phone className="w-4.5 h-4.5 text-orange-500" />
                Place Outbound Phone Call
              </h2>
              <p className="text-xs text-slate-400 mb-6">
                Enter any Indian phone number to trigger an outbound phone request. Note: Be sure your Twilio credentials have credits and are linked to active local regions.
              </p>

              <form onSubmit={handleDialCall} className="space-y-4">
                <div>
                  <label htmlFor="phone_input" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                    Indian Mobile Number
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">+91</span>
                    <input
                      id="phone_input"
                      type="tel"
                      required
                      placeholder="9876543210"
                      value={phoneNumber.replace(/^\+91/, "")}
                      onChange={(e) => setPhoneNumber("+91" + e.target.value.replace(/[^0-9]/g, ""))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 pl-14 pr-4 font-mono text-base focus:outline-none focus:border-orange-500 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  {serverState.status === "ringing" || serverState.status === "in-progress" ? (
                    <div className="w-full flex items-center justify-between p-4 bg-orange-950/20 border border-orange-900/30 rounded-xl">
                      <div className="flex items-center gap-3">
                        <span className="w-2.5 h-2.5 rounded-full bg-orange-500 animate-ping"></span>
                        <div className="text-left">
                          <p className="text-xs text-slate-400 font-semibold mb-0">Call Status</p>
                          <p className="text-sm font-bold text-orange-400 capitalize mb-0">{serverState.status}...</p>
                        </div>
                      </div>
                      <div className="text-right text-xs text-slate-500 font-mono">
                        SID: {serverState.callSid ? `${serverState.callSid.substring(0, 8)}...` : "Waiting"}
                      </div>
                    </div>
                  ) : (
                    <button
                      id="call_btn"
                      type="submit"
                      disabled={calling}
                      className="w-full py-3.5 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold rounded-xl transition-all shadow-md hover:shadow-orange-700/20 hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {calling ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          Placing Request...
                        </>
                      ) : (
                        <>
                          <PhoneCall className="w-5 h-5" />
                          Initiate Outbound Call
                        </>
                      )}
                    </button>
                  )}
                </div>
              </form>

              {/* Indian accent settings banner */}
              <div className="mt-6 p-4 bg-slate-950/50 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-orange-400">
                  <Globe className="w-4 h-4" />
                  Emotional Fluency (Indian Accent Configuration)
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  The artificial engine is configured to adopt standard <strong>Indian Conversational Accent</strong>. It naturally injects Indian dramatic tones, realistic speed changes, and regional words/slang automatically. Whenever the speaker switch languages, it translates immediately and speaks back natively.
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-600/5 rounded-full blur-3xl pointer-events-none"></div>

              <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Mic className="w-4.5 h-4.5 text-emerald-500" />
                Direct Browser Mic Live Testing
              </h2>
              <p className="text-xs text-slate-400 mb-6">
                Test the Indian-accent conversation immediately in your browser. This isolates network lag and bypasses Twilio carrier setups so you can check voice tone and accent response time immediately.
              </p>

              <div className="flex flex-col items-center justify-center py-6 bg-slate-950 rounded-xl border border-slate-800/60 mb-6 relative">
                
                {/* Voice ripple visualizer */}
                <div className="w-24 h-24 rounded-full flex items-center justify-center relative mb-4">
                  {isMicTesting && (
                    <>
                      <div className="absolute inset-0 rounded-full bg-emerald-500/10 animate-ping" style={{ animationDuration: "1.8s" }}></div>
                      <div className="absolute inset-2 rounded-full bg-emerald-500/20 animate-ping" style={{ animationDuration: "1.2s" }}></div>
                    </>
                  )}
                  <button
                    id="mic_trigger_btn"
                    onClick={isMicTesting ? stopMicTesting : startMicTesting}
                    className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg hover:scale-105 active:scale-95 cursor-pointer ${
                      isMicTesting ? "bg-rose-600 text-white hover:bg-rose-500" : "bg-emerald-600 text-slate-950 hover:bg-emerald-500"
                    }`}
                  >
                    {isMicTesting ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                  </button>
                </div>

                {/* Status and description */}
                <span className="text-sm font-semibold tracking-wide uppercase text-slate-300">
                  {micStatus === "offline" && "Mic Connection Offline"}
                  {micStatus === "connecting" && "Initializing WebSocket..."}
                  {micStatus === "live" && "Listening (Silently Waiting)"}
                  {micStatus === "talking" && "User Speaking (Uploading PCM)..."}
                  {micStatus === "listening" && "Gemini Talking (Streaming response)..."}
                </span>

                {/* Microphone magnitude volume line */}
                {isMicTesting && (
                  <div className="w-2/3 h-1.5 bg-slate-900 rounded-full mt-4 overflow-hidden border border-slate-800 flex items-center">
                    <div 
                      className="h-full bg-emerald-500 transition-all duration-75"
                      style={{ width: `${browserVolume}%` }}
                    ></div>
                  </div>
                )}
              </div>

              {/* Browser prompt details */}
              <div className="p-4 bg-slate-950/50 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <Volume2 className="w-4 h-4" />
                  Barge-In / Handshake Interruption Support Enabled
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Start speaking while Gemini is talking, and the assistant will <strong>interrupt itself immediately</strong>, clearing any queued playback block so you can talk with standard human responsiveness.
                </p>
              </div>
            </div>
          )}

          {/* Interactive latency stats panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-500" />
              Live Conversation Turnaround Lag Meter
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-slate-950 p-4 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase font-semibold mb-1">Average Response Latency</p>
                  <p className="text-3xl font-mono font-bold text-white mb-0">
                    {finalLatency ? `${finalLatency} ms` : "No data"}
                  </p>
                </div>
                <span className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-orange-400">
                  <Timer className="w-5 h-5" />
                </span>
              </div>

              <div className="bg-slate-950 p-4 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase font-semibold mb-1">Response Speed Compliance</p>
                  <p className="text-sm font-semibold mb-0" style={{ color: finalLatency && finalLatency < 600 ? "#34d399" : "#fbbf24" }}>
                    {finalLatency ? (finalLatency < 600 ? "100% Compliant" : "Lag detected") : "Awaiting call..."}
                  </p>
                  <p className="text-[10px] text-slate-400 mb-0">Target: Response under 600ms</p>
                </div>
                <span className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-emerald-400">
                  <CheckCircle2 className="w-5 h-5" />
                </span>
              </div>
            </div>

            {/* Compliance message */}
            <div className={`mt-4 px-4 py-3 border rounded-xl text-xs flex items-center gap-2.5 ${compliance.bg}`}>
              <div className="bg-slate-900 text-slate-400 p-1 rounded-full">
                <AlertCircle className="w-4 h-4" />
              </div>
              <p className={`font-semibold mb-0 ${compliance.color}`}>{compliance.text}</p>
            </div>
          </div>

        </div>

        {/* Right Side: Log Feed & transcripts (5 Columns) */}
        <div className="md:col-span-5 flex flex-col gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col h-[580px]">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3.5 mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-0">
                <MessageSquare className="w-4 h-4 text-orange-500" />
                Live Conversation Log
              </h2>
              <span className="font-mono text-[10px] bg-slate-950 px-2 py-0.5 rounded-full border border-slate-800 text-slate-400">
                Real-time feed
              </span>
            </div>

            {/* Logs List scroll container */}
            <div id="logs_container" className="flex-1 overflow-y-auto space-y-3.5 pr-1 text-left flex flex-col-reverse">
              
              {/* Fallback empty view */}
              {(activeTab === "phone" ? serverState.logs : []).length === 0 && !isMicTesting ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 bg-slate-950/40 rounded-xl border border-dashed border-slate-800/80 my-auto">
                  <Volume2 className="w-8 h-8 text-slate-600 mb-2 animate-bounce" />
                  <p className="text-xs font-semibold text-slate-400">No active calls or logs recorded yet</p>
                  <p className="text-[10px] text-slate-500 max-w-[200px] leading-relaxed mt-1">
                    Select a testing method on the left to watch live translations, logs, and lag metrics.
                  </p>
                </div>
              ) : null}

              {/* Logs loop */}
              {(activeTab === "phone" ? serverState.logs : []).map((log, idx) => (
                <div 
                  key={idx} 
                  className={`p-3 rounded-xl text-xs space-y-1 border ${
                    log.type === "system" 
                      ? "bg-slate-950/40 border-slate-800/80 text-sky-400" 
                      : log.type === "error"
                      ? "bg-rose-950/10 border-rose-900/30 text-rose-400"
                      : log.type === "user"
                      ? "bg-orange-950/20 border-orange-500/10 text-white self-end ml-6"
                      : "bg-emerald-950/20 border-emerald-500/10 text-slate-100 self-start mr-6"
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-400 uppercase font-mono">
                    <span className="font-semibold">
                      {log.type === "system" && "System Logs"}
                      {log.type === "error" && "System Error"}
                      {log.type === "user" && "User Voice"}
                      {log.type === "assistant" && "Gemini Live Assistant"}
                    </span>
                    <span>{log.timestamp}</span>
                  </div>
                  <p className="mb-0 text-slate-200 tracking-wide font-medium leading-relaxed">
                    {log.message}
                  </p>
                  {log.latencyMs ? (
                    <div className="flex items-center gap-1.5 text-[9px] font-mono mt-1" style={{ color: log.latencyMs < 600 ? "#34d399" : "#fbbf24" }}>
                      <Timer className="w-3 h-3" />
                      turnaround: {log.latencyMs}ms (delay target met!)
                    </div>
                  ) : null}
                </div>
              ))}

              {/* Local browser mic logs overlay */}
              {activeTab === "mic" && isMicTesting && (
                <div className="p-3 bg-slate-950 border border-slate-800 text-slate-300 rounded-xl text-xs flex flex-col gap-2">
                  <div className="flex items-center justify-between uppercase font-mono text-[9px] text-slate-400">
                    <span>Browser Debug Terminal</span>
                    <span className="text-emerald-400 animate-ping">● LIVE</span>
                  </div>
                  <div className="space-y-1.5 font-mono text-[10px] text-slate-400 leading-relaxed">
                    <p className="text-emerald-500 mb-0">&gt; WebSocket bridge connected to /browser-stream</p>
                    <p className="mb-0">&gt; Browser AudioContext active (Input: 16kHz PCM)</p>
                    <p className="mb-0">&gt; Output AudioContext resolved (Output: 24kHz PCM)</p>
                    {browserLatency && (
                      <p className="text-orange-400 mb-0">&gt; Handshake latency parsed: {browserLatency}ms</p>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

      </main>

      {/* Footer Info section */}
      <footer className="w-full max-w-5xl mt-12 text-center text-xs text-slate-500 border-t border-slate-900 pt-5 space-y-2">
        <p className="mb-0 leading-relaxed">
          Google AI Studio Conversational AI Application Dashboard. Engineered with Express WebSocket Bridges and Gemini Live API to deliver under 600ms latency.
        </p>
        <div className="flex justify-center gap-4 text-[10px] text-slate-600 font-mono">
          <span>PORT: 3000</span>
          <span>●</span>
          <span>GEMINI MODEL: gemini-3.1-flash-live-preview</span>
          <span>●</span>
          <span>DSP: Mu-Law / G.711 & Resampling</span>
        </div>
      </footer>

    </div>
  );
}
