import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Timer,
  Globe,
  Sparkles,
  RefreshCw,
  AlertCircle,
  MessageSquare,
  Zap,
  Radio,
  Trash2,
  Smile,
  ShieldCheck,
  Headphones
} from "lucide-react";

interface ConversationLog {
  id: string;
  timestamp: string;
  type: "system" | "user" | "assistant" | "error";
  message: string;
  latencyMs?: number;
}

interface ServerState {
  status: "idle" | "connected" | "listening" | "speaking";
  latencyHistory: number[];
  avgLatency: number;
  logs: ConversationLog[];
}

export default function App() {
  // Voice connection state
  const [isLive, setIsLive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "connecting" | "listening" | "user_speaking" | "aarav_speaking">("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Audio metrics
  const [micVolume, setMicVolume] = useState(0);
  const [currentLatency, setCurrentLatency] = useState<number | null>(null);
  const [latencyList, setLatencyList] = useState<number[]>([]);

  // Server state polled for transcripts & logs
  const [serverLogs, setServerLogs] = useState<ConversationLog[]>([]);

  // WebAudio API Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const lastUserSpeechTimeRef = useRef<number>(0);
  const isFirstChunkForTurnRef = useRef<boolean>(false);
  const isMutedRef = useRef<boolean>(false);

  // Sync mute ref
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Poll server conversation logs
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok) {
          const data = (await res.json()) as ServerState;
          if (data.logs) {
            setServerLogs(data.logs);
          }
          if (data.latencyHistory && data.latencyHistory.length > 0) {
            setLatencyList(data.latencyHistory);
          }
        }
      } catch (err) {
        // silent poll catch
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 1200);
    return () => clearInterval(interval);
  }, []);

  // Helper: Int16 to Base64
  const pcmToBase64 = (pcm16: Int16Array): string => {
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Resample any browser input sample rate down to exact 16kHz PCM
  const resampleTo16kHz = (input: Float32Array, inputRate: number): Int16Array => {
    if (inputRate === 16000) {
      const output = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return output;
    }

    const ratio = inputRate / 16000;
    const newLength = Math.floor(input.length / ratio);
    const output = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * ratio;
      const low = Math.floor(srcIdx);
      const high = Math.min(low + 1, input.length - 1);
      const weight = srcIdx - low;
      const sample = input[low] * (1 - weight) + input[high] * weight;
      const s = Math.max(-1, Math.min(1, sample));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  };

  // Start Real-Time Speech-to-Speech Voice Session
  const startLiveConversation = async () => {
    try {
      setErrorMessage(null);
      setIsLive(true);
      setVoiceStatus("connecting");
      isFirstChunkForTurnRef.current = false;

      // Connect WebSocket to backend live audio stream
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/live-stream`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setVoiceStatus("listening");

        // 1. Audio Context for microphone capture
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = audioCtx;

        // 2. Audio Context for 24kHz speaker playback (Gemini Live Output Standard)
        const playAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        playAudioCtxRef.current = playAudioCtx;
        nextStartTimeRef.current = playAudioCtx.currentTime;

        // Get microphone stream
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        micStreamRef.current = stream;

        const source = audioCtx.createMediaStreamSource(stream);

        // Volume analyser for visualizer
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const checkVolume = () => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const avg = sum / bufferLength;
          setMicVolume(Math.min(100, Math.floor((avg / 128) * 100)));
          requestAnimationFrame(checkVolume);
        };
        requestAnimationFrame(checkVolume);

        // Script Processor for raw PCM chunks
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        source.connect(processor);
        processor.connect(audioCtx.destination);

        const actualSampleRate = audioCtx.sampleRate;

        processor.onaudioprocess = (e) => {
          if (isMutedRef.current) return;

          const inputData = e.inputBuffer.getChannelData(0);

          // User activity threshold
          let peak = 0;
          for (let i = 0; i < inputData.length; i++) {
            const val = Math.abs(inputData[i]);
            if (val > peak) peak = val;
          }

          if (peak > 0.035) {
            setVoiceStatus("user_speaking");
            lastUserSpeechTimeRef.current = Date.now();
            isFirstChunkForTurnRef.current = false;
          } else if (voiceStatus === "user_speaking") {
            setVoiceStatus("listening");
          }

          // Resample input audio to strict 16kHz Int16 PCM
          const pcm16 = resampleTo16kHz(inputData, actualSampleRate);
          const base64 = pcmToBase64(pcm16);

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ audio: base64 }));
          }
        };
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // 1. Interruption / Barge-in
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
            setVoiceStatus("listening");
            isFirstChunkForTurnRef.current = false;
            return;
          }

          // 2. Incoming 24kHz Raw PCM Audio from Aarav
          if (msg.audio) {
            setVoiceStatus("aarav_speaking");

            // Measure first-token round-trip turnaround lag
            if (!isFirstChunkForTurnRef.current) {
              const diff = Date.now() - lastUserSpeechTimeRef.current;
              if (lastUserSpeechTimeRef.current > 0 && diff > 50 && diff < 8000) {
                setCurrentLatency(diff);
                setLatencyList((prev) => {
                  const updated = [...prev, diff];
                  if (updated.length > 40) updated.shift();
                  return updated;
                });
              }
              isFirstChunkForTurnRef.current = true;
            }

            // Direct binary decoding to 24kHz Float32 buffer
            const binary = atob(msg.audio);
            const sampleCount = Math.floor(binary.length / 2);
            const float32Samples = new Float32Array(sampleCount);

            for (let i = 0; i < sampleCount; i++) {
              const byte1 = binary.charCodeAt(i * 2);
              const byte2 = binary.charCodeAt(i * 2 + 1);
              let val = (byte2 << 8) | byte1;
              if (val >= 32768) val -= 65536; // 16-bit signed integer
              float32Samples[i] = val / 32768.0;
            }

            playAudioChunk(float32Samples);
          }
        } catch (err) {
          console.warn("Audio packet decode error:", err);
        }
      };

      ws.onclose = () => {
        stopLiveConversation();
      };

      ws.onerror = (e) => {
        console.warn("WebSocket error:", e);
        stopLiveConversation();
      };
    } catch (err: any) {
      setErrorMessage("Microphone access failed: " + (err?.message || String(err)));
      stopLiveConversation();
    }
  };

  // Play incoming audio chunks gaplessly
  const playAudioChunk = (float32: Float32Array) => {
    const playCtx = playAudioCtxRef.current;
    if (!playCtx || playCtx.state === "closed") return;

    const audioBuffer = playCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = playCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playCtx.destination);

    if (nextStartTimeRef.current < playCtx.currentTime) {
      nextStartTimeRef.current = playCtx.currentTime;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
      if (activeSourcesRef.current.length === 0 && voiceStatus === "aarav_speaking") {
        setVoiceStatus("listening");
      }
    };
  };

  // Stop / Disconnect
  const stopLiveConversation = () => {
    setIsLive(false);
    setVoiceStatus("idle");
    setMicVolume(0);

    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch (_) {}
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

  // Clear server logs
  const handleClearLogs = async () => {
    try {
      await fetch("/api/clear-logs", { method: "POST" });
      setServerLogs([]);
      setLatencyList([]);
      setCurrentLatency(null);
    } catch (e) {}
  };

  // Compute average latency
  const avgLatency =
    latencyList.length > 0
      ? Math.round(latencyList.reduce((a, b) => a + b, 0) / latencyList.length)
      : currentLatency || null;

  return (
    <div id="voice_ai_root" className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col items-center py-6 px-4 sm:px-6">
      
      {/* Top Header */}
      <header className="w-full max-w-6xl flex flex-col sm:flex-row items-center justify-between border-b border-slate-800/80 pb-5 mb-8 gap-4">
        <div className="flex items-center gap-3.5 text-center sm:text-left">
          <div className="p-2.5 bg-gradient-to-br from-emerald-500/20 to-teal-500/10 text-emerald-400 rounded-2xl border border-emerald-500/30 shadow-inner">
            <Radio id="header_icon" className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-white tracking-tight">Aarav</h1>
              <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider bg-emerald-950/70 border border-emerald-800/80 text-emerald-400 rounded-full">
                AI Voice Friend
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Multilingual Speech-to-Speech Conversational Companion (Kannada, Hindi, English, & more)
            </p>
          </div>
        </div>

        {/* Global Badges */}
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full bg-slate-900 border border-slate-800 text-slate-300">
            <span className={`w-2 h-2 rounded-full ${isLive ? "bg-emerald-400 animate-ping" : "bg-slate-600"}`}></span>
            {isLive ? "Live Stream Active" : "Ready to Connect"}
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full bg-slate-900 border border-slate-800 text-slate-300">
            <Globe className="w-3.5 h-3.5 text-emerald-400" />
            Auto Language Mirroring
          </span>
        </div>
      </header>

      {/* Error notification banner */}
      {errorMessage && (
        <div id="error_toast" className="w-full max-w-6xl mb-6 p-4 bg-rose-950/40 border border-rose-800/80 rounded-2xl flex items-center justify-between text-rose-300 text-sm">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span className="font-medium">{errorMessage}</span>
          </div>
          <button
            id="clear_error_btn"
            onClick={() => setErrorMessage(null)}
            className="text-xs bg-rose-900/40 hover:bg-rose-900/60 px-3 py-1.5 rounded-lg border border-rose-700/40 cursor-pointer text-rose-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Interactive Grid */}
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Column: Voice Orb & Interactive Controls (7 Cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          
          {/* Main Voice Calling Stage Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 relative overflow-hidden flex flex-col items-center text-center shadow-xl">
            {/* Background Glow */}
            <div className={`absolute -top-12 -right-12 w-64 h-64 rounded-full blur-3xl pointer-events-none transition-all duration-700 ${
              voiceStatus === "aarav_speaking" ? "bg-emerald-500/15" : 
              voiceStatus === "user_speaking" ? "bg-teal-500/15" : "bg-slate-800/20"
            }`}></div>

            {/* Friend Persona Header */}
            <div className="flex items-center gap-2 mb-6 text-xs text-slate-400 bg-slate-950/60 px-3.5 py-1.5 rounded-full border border-slate-800">
              <Smile className="w-3.5 h-3.5 text-amber-400" />
              <span>Speaking with your warm, supportive companion</span>
            </div>

            {/* Central Animated Voice Orb */}
            <div className="relative my-6 flex items-center justify-center">
              {/* Pulsing visual rings */}
              {isLive && (
                <>
                  <div
                    className={`absolute rounded-full transition-all duration-300 pointer-events-none ${
                      voiceStatus === "aarav_speaking"
                        ? "w-48 h-48 bg-emerald-500/20 animate-ping"
                        : voiceStatus === "user_speaking"
                        ? "w-48 h-48 bg-teal-500/20 animate-pulse"
                        : "w-36 h-36 bg-slate-700/10"
                    }`}
                    style={{ animationDuration: voiceStatus === "aarav_speaking" ? "1.4s" : "2s" }}
                  ></div>
                  <div
                    className={`absolute rounded-full pointer-events-none ${
                      voiceStatus === "aarav_speaking"
                        ? "w-40 h-40 bg-emerald-500/30 blur-md"
                        : voiceStatus === "user_speaking"
                        ? "w-40 h-40 bg-teal-500/30 blur-md"
                        : "w-32 h-32 bg-slate-700/20 blur-sm"
                    }`}
                  ></div>
                </>
              )}

              {/* Main Circular Action Button */}
              <button
                id="main_voice_trigger_btn"
                onClick={isLive ? stopLiveConversation : startLiveConversation}
                className={`relative z-10 w-28 h-28 rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-2xl hover:scale-105 active:scale-95 cursor-pointer ${
                  !isLive
                    ? "bg-gradient-to-tr from-emerald-600 to-teal-500 text-slate-950 hover:from-emerald-500 hover:to-teal-400 shadow-emerald-950/50"
                    : voiceStatus === "aarav_speaking"
                    ? "bg-emerald-500 text-slate-950 ring-4 ring-emerald-500/40 animate-pulse"
                    : isMuted
                    ? "bg-amber-600 text-white ring-4 ring-amber-600/30"
                    : "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/50"
                }`}
              >
                {!isLive ? (
                  <>
                    <Mic className="w-10 h-10 mb-1" />
                    <span className="text-[10px] font-black uppercase tracking-wider">Start</span>
                  </>
                ) : (
                  <>
                    <MicOff className="w-10 h-10 mb-1" />
                    <span className="text-[10px] font-black uppercase tracking-wider">End</span>
                  </>
                )}
              </button>
            </div>

            {/* Status Text Indicator */}
            <div className="space-y-1 my-2">
              <p className="text-base font-bold text-white tracking-wide">
                {!isLive && "Tap to start conversation"}
                {voiceStatus === "connecting" && "Establishing low-latency stream..."}
                {voiceStatus === "listening" && "Aarav is listening (Speak anytime)"}
                {voiceStatus === "user_speaking" && "You are speaking..."}
                {voiceStatus === "aarav_speaking" && "Aarav is talking..."}
              </p>
              <p className="text-xs text-slate-400">
                {!isLive
                  ? "Speak naturally in Kannada, Hindi, English, or any Indian language"
                  : isMuted
                  ? "Microphone is muted"
                  : "Automatic language switching & instant interruption supported"}
              </p>
            </div>

            {/* Live Audio Level Meter */}
            {isLive && !isMuted && (
              <div className="w-48 h-1.5 bg-slate-950 rounded-full mt-4 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-teal-500 to-emerald-400 transition-all duration-75"
                  style={{ width: `${Math.max(5, micVolume)}%` }}
                ></div>
              </div>
            )}

            {/* Secondary Controls Bar */}
            {isLive && (
              <div className="flex items-center gap-3 mt-6 pt-6 border-t border-slate-800/80 w-full justify-center">
                <button
                  id="mute_toggle_btn"
                  onClick={() => setIsMuted(!isMuted)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border ${
                    isMuted
                      ? "bg-amber-950/40 text-amber-300 border-amber-800/60"
                      : "bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800"
                  }`}
                >
                  {isMuted ? <VolumeX className="w-4 h-4 text-amber-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
                  {isMuted ? "Unmute Microphone" : "Mute Microphone"}
                </button>
              </div>
            )}
          </div>

          {/* Multilinguistic Mirroring & Persona Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 uppercase tracking-wider">
                <Globe className="w-4 h-4" />
                Multilingual Mirroring
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Speak in English, Kannada (ಕನ್ನಡ), Hindi (हिंदी), Tamil, or Telugu. Aarav will automatically detect your language and answer back natively in the same language.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-teal-400 uppercase tracking-wider">
                <Zap className="w-4 h-4" />
                Instant Barge-In (Interruption)
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                You never have to wait for Aarav to finish speaking. Simply start talking, and the assistant stops immediately, matching human conversation flow.
              </p>
            </div>
          </div>

          {/* Latency & Performance Meter Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
              <Timer className="w-4 h-4 text-emerald-400" />
              Real-Time Conversational Turnaround Lag Meter
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-slate-950 p-4 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase font-semibold mb-1">Average Response Delay</p>
                  <p className="text-3xl font-mono font-bold text-white mb-0">
                    {avgLatency ? `${avgLatency} ms` : "---"}
                  </p>
                </div>
                <span className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-emerald-400">
                  <Headphones className="w-5 h-5" />
                </span>
              </div>

              <div className="bg-slate-950 p-4 border border-slate-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase font-semibold mb-1">Target Compliance</p>
                  <p
                    className="text-sm font-semibold mb-0"
                    style={{ color: avgLatency && avgLatency < 600 ? "#34d399" : "#fbbf24" }}
                  >
                    {avgLatency ? (avgLatency < 600 ? "Excellent (<600ms)" : "Acceptable") : "Waiting for speech..."}
                  </p>
                  <p className="text-[10px] text-slate-400 mb-0">Streaming directly over WebSocket</p>
                </div>
                <span className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-teal-400">
                  <ShieldCheck className="w-5 h-5" />
                </span>
              </div>
            </div>
          </div>

        </div>

        {/* Right Column: Live Conversation Feed & Transcripts (5 Cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col h-[640px] shadow-xl">
            
            {/* Feed Title & Actions */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 mb-0">
                  Live Conversation Feed
                </h2>
              </div>
              <button
                id="clear_feed_btn"
                onClick={handleClearLogs}
                title="Clear transcript feed"
                className="p-1.5 bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg border border-slate-800 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Scrollable Message Bubbles */}
            <div id="transcript_scroll_feed" className="flex-1 overflow-y-auto space-y-3 pr-1 text-left flex flex-col-reverse">
              {serverLogs.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800/80 my-auto">
                  <Sparkles className="w-8 h-8 text-emerald-500/60 mb-2 animate-bounce" />
                  <p className="text-xs font-semibold text-slate-300">No active conversation yet</p>
                  <p className="text-[11px] text-slate-500 max-w-[220px] leading-relaxed mt-1">
                    Hit <strong>Start</strong> and begin speaking to Aarav. Transcripts and responses will stream here in real time.
                  </p>
                </div>
              )}

              {serverLogs.map((log) => (
                <div
                  key={log.id}
                  className={`p-3.5 rounded-2xl text-xs space-y-1.5 border transition-all ${
                    log.type === "system"
                      ? "bg-slate-950/50 border-slate-800/80 text-sky-400"
                      : log.type === "error"
                      ? "bg-rose-950/20 border-rose-900/40 text-rose-300"
                      : log.type === "user"
                      ? "bg-gradient-to-r from-teal-950/40 to-slate-900 border-teal-500/30 text-teal-100 self-end ml-4 shadow-sm"
                      : "bg-gradient-to-r from-slate-900 to-emerald-950/40 border-emerald-500/30 text-slate-100 self-start mr-4 shadow-sm"
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono uppercase">
                    <span className="font-bold">
                      {log.type === "system" && "⚡ System"}
                      {log.type === "error" && "⚠️ Error"}
                      {log.type === "user" && "👤 You"}
                      {log.type === "assistant" && "🌟 Aarav"}
                    </span>
                    <span>{log.timestamp}</span>
                  </div>

                  <p className="mb-0 text-slate-200 tracking-wide font-normal leading-relaxed text-sm">
                    {log.message}
                  </p>

                  {log.latencyMs ? (
                    <div className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 mt-1">
                      <Timer className="w-3 h-3" />
                      turnaround: {log.latencyMs}ms
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="w-full max-w-6xl mt-12 text-center text-xs text-slate-500 border-t border-slate-900 pt-6 space-y-2">
        <p className="mb-0">
          Direct Real-Time Conversational AI Voice Companion. Powered by Gemini Live Multimodal Speech-to-Speech API.
        </p>
        <div className="flex justify-center items-center gap-3 text-[10px] text-slate-600 font-mono">
          <span>PORT: 3000</span>
          <span>•</span>
          <span>INPUT: 16kHz PCM</span>
          <span>•</span>
          <span>OUTPUT: 24kHz PCM</span>
          <span>•</span>
          <span>TARGET LATENCY: &lt;600ms</span>
        </div>
      </footer>

    </div>
  );
}
