import { useState, useRef, useEffect } from 'react';
import { Mic, Settings, History, Volume2, Ear, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface TranslationResult {
  originalLang: string;
  originalTranscript: string;
  myanmarTranslation: string;
  englishTranslation: string;
  speakInstruction: string;
}

const pcmWorkletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const channelData = input[0];
      const int16Array = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        let s = Math.max(-1, Math.min(1, channelData[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16Array.buffer, [int16Array.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'main'|'history'|'settings'>('main');
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Simple playback queue
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const connectLive = async () => {
    setIsConnecting(true);
    setErrorMessage(null);
    
    // 1. Setup Contexts Synchronously
    audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    playCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    nextPlayTimeRef.current = playCtxRef.current.currentTime;

    // 2. Get Mic
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      streamRef.current = stream;
    } catch (err) {
      console.error(err);
      alert("Microphone required");
      setIsConnecting(false);
      return;
    }

    // 3. Open WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
       console.log("WS Open");
    };

    ws.onclose = () => {
       console.log("WS Close");
       stopLive();
    };

    ws.onerror = (e) => {
       console.error("WS Error", e);
    };

    ws.onmessage = async (e) => {
       try {
         const data = JSON.parse(e.data);
         if (data.type === 'ready') {
            setIsLiveActive(true);
            setIsConnecting(false);
            
            // 3. Setup Audio Capture once ready
            const audioCtx = audioCtxRef.current;
            if (!audioCtx) return;
            
            const blob = new Blob([pcmWorkletCode], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);
            await audioCtx.audioWorklet.addModule(workletUrl);
            
            const source = audioCtx.createMediaStreamSource(streamRef.current!);
            const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
            workletRef.current = worklet;
            
            worklet.port.onmessage = (event) => {
               if (wsRef.current?.readyState === WebSocket.OPEN) {
                 const base64 = arrayBufferToBase64(event.data);
                 wsRef.current.send(JSON.stringify({ type: 'audio', data: base64 }));
               }
            };
            
            source.connect(worklet);
            const silentGain = audioCtx.createGain();
            silentGain.gain.value = 0;
            worklet.connect(silentGain);
            silentGain.connect(audioCtx.destination);

            // Contexts already setup
         } else if (data.type === 'audio') {
            // Play received audio
            playAudio(data.data);
         } else if (data.type === 'interrupted') {
             // stop currently queued audio
             nextPlayTimeRef.current = playCtxRef.current?.currentTime || 0;
             activeSourcesRef.current.forEach(source => {
                try { source.stop(); } catch(e) {}
             });
             activeSourcesRef.current.clear();
         } else if (data.type === 'error') {
             setErrorMessage(data.message);
             stopLive();
         }
       } catch (err) {
         console.error("Message parse error", err);
       }
    };
  };

  const playAudio = (base64: string) => {
      const ctx = playCtxRef.current;
      if (!ctx) return;
      
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for(let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
      
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for(let i=0; i<int16Array.length; ++i){
          float32Array[i] = int16Array[i] / 32768.0;
      }
      
      const buffer = ctx.createBuffer(1, float32Array.length, 24000);
      buffer.copyToChannel(float32Array, 0);
      
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
         activeSourcesRef.current.delete(source);
      };
      
      const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      activeSourcesRef.current.add(source);
      nextPlayTimeRef.current = startTime + buffer.duration;
  };

  const stopLive = () => {
     if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
     }
     if (workletRef.current) {
        try { workletRef.current.disconnect(); } catch(e) {}
     }
     if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        try { audioCtxRef.current.close(); } catch(e) {}
     }
     if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
     }
     activeSourcesRef.current.forEach(source => {
        try { source.stop(); } catch(e) {}
     });
     activeSourcesRef.current.clear();
     setIsLiveActive(false);
     setIsConnecting(false);
  };

  // Mic Test
  const toggleMicTest = async () => {
    if (micTestActive) {
      setMicTestActive(false);
      setMicLevel(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    } else {
      let stream;
      try {
         stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
         return;
      }
      setMicTestActive(true);
      
      const audioCtx = new window.AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const analyzer = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyzer);
      analyzer.fftSize = 256;
      
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      const updateLevel = () => {
        if (!micTestActive) return;
        analyzer.getByteFrequencyData(dataArray);
        let sum = 0;
        for(let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        setMicLevel(Math.min(100, Math.round((sum / dataArray.length) * 1.5)));
        rafRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
    }
  };

  return (
    <div className="min-h-[100dvh] bg-black text-white font-sans flex flex-col selection:bg-white selection:text-black">
      {/* Top Navbar */}
      <header className="flex items-center justify-between p-5 border-b border-white/10 z-10">
        <h1 className="text-xl font-bold tracking-tight uppercase">Taurus Live</h1>
        <div className="flex space-x-4">
          <button onClick={() => setActiveTab('settings')} className={`p-2 rounded-full transition-colors ${activeTab === 'settings' ? 'bg-white text-black' : 'hover:bg-white/10 text-white/70'}`}>
            <Settings size={20} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 relative overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
          
          {/* Main Translation Tab */}
          {activeTab === 'main' && (
            <motion.div 
              key="main"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex-1 flex flex-col p-5 overflow-y-auto"
            >
              
               <div className="flex flex-col items-center justify-center flex-1 space-y-8 opacity-90 mt-10">
                  
                  <div className="relative">
                     <Ear size={64} className={`transition-opacity duration-1000 ${isLiveActive ? 'opacity-100 text-white' : 'opacity-20 text-white'}`} />
                     {isLiveActive && (
                        <motion.div
                           animate={{ scale: [1, 1.5, 2], opacity: [0.8, 0, 0] }}
                           transition={{ repeat: Infinity, duration: 2 }}
                           className="absolute inset-0 rounded-full border-2 border-white pointer-events-none"
                        ></motion.div>
                     )}
                     {isConnecting && (
                        <motion.div
                           animate={{ rotate: 360 }}
                           transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                           className="absolute inset-0 rounded-full border-t-2 border-white pointer-events-none w-16 h-16"
                        ></motion.div>
                     )}
                  </div>

                  <div className="text-center space-y-2">
                     <h2 className="text-xl font-bold uppercase tracking-widest text-[#63f3ff]">
                         {errorMessage ? 'Connection Failed' : isLiveActive ? 'Connected & Listening' : isConnecting ? 'Connecting...' : 'Real-time Translator'}
                     </h2>
                     <p className="text-sm opacity-60 max-w-xs mx-auto">
                        {!isLiveActive && !errorMessage && "Put on your earbuds. Translates any spoken language in the world into Myanmar (Burmese) directly into your ear. No buttons needed."}
                        {isLiveActive && !errorMessage && "Speak naturally into your device. Translating all languages to Myanmar."}
                     </p>
                     
                     {errorMessage && (
                       <div className="mt-6 bg-red-500/20 border border-red-500/50 p-4 rounded-xl max-w-sm mx-auto text-red-100 text-sm">
                         {errorMessage}
                       </div>
                     )}
                  </div>
               </div>

              {/* Controls */}
              <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center px-5 gap-4 bg-black/90 pt-8 pb-12 backdrop-blur-xl border-t border-white/10 rounded-t-[40px]">
                 <button 
                  onClick={isLiveActive ? stopLive : connectLive}
                  disabled={isConnecting}
                  className={`w-full max-w-sm mx-auto py-5 rounded-3xl font-bold uppercase tracking-widest text-sm transition-all duration-300 flex items-center justify-center space-x-3 border ${
                    isLiveActive 
                      ? 'bg-red-600 text-white border-red-500 shadow-[0_0_40px_rgba(220,38,38,0.4)]' 
                      : isConnecting
                      ? 'bg-zinc-800 border-white/10 text-white/50 cursor-not-allowed'
                      : 'bg-white text-black border-white shadow-[0_0_40px_rgba(255,255,255,0.4)] hover:bg-zinc-100'
                  }`}
                 >
                    <Activity size={20} className={isLiveActive || isConnecting ? "animate-pulse" : ""} />
                    <span>{isLiveActive ? 'Stop Translator' : isConnecting ? 'Connecting to Gemini...' : 'Start Translator'}</span>
                 </button>
              </div>
            </motion.div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && (
             <motion.div 
               key="settings"
               initial={{ opacity: 0, x: 20 }}
               animate={{ opacity: 1, x: 0 }}
               exit={{ opacity: 0, x: -20 }}
               className="flex-1 p-5 overflow-y-auto space-y-10 pb-8"
             >
               <div className="flex items-center justify-between pb-4 border-b border-white/10">
                  <h2 className="text-xl font-bold uppercase tracking-tight">Preferences</h2>
                  <button onClick={() => setActiveTab('main')} className="text-xs uppercase hover:underline opacity-70">Close</button>
               </div>
 
               <div className="space-y-4">
                  <h3 className="text-xs uppercase tracking-widest opacity-50">Bluetooth / Mic Test</h3>
                  <div className="p-6 bg-white/5 rounded-3xl border border-white/10 space-y-6">
                     <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Test Audio Input Level</span>
                        <button 
                           onClick={toggleMicTest}
                           className={`px-5 py-3 rounded-xl text-xs font-bold uppercase ${micTestActive ? 'bg-red-500 text-white' : 'bg-white text-black'}`}
                        >
                          {micTestActive ? 'Stop Test' : 'Start Test'}
                        </button>
                     </div>
 
                     {micTestActive && (
                        <div className="flex flex-col space-y-3 pt-4 border-t border-white/10">
                           <div className="w-full h-8 bg-black/60 rounded-full overflow-hidden border border-white/20 p-1">
                              <div 
                                 className="h-full bg-white rounded-full transition-all duration-75 relative"
                                 style={{ width: `${micLevel}%` }}
                              />
                           </div>
                           <p className="text-[10px] text-center uppercase tracking-widest opacity-50">Speak into your earbuds or phone...</p>
                        </div>
                     )}
                  </div>
                  <p className="text-[10px] uppercase opacity-40 px-2 leading-relaxed">
                     * Ensure Bluetooth Earbuds are connected to your device's Bluetooth settings before testing.
                  </p>
               </div>
             </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}

