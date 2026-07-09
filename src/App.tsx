import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Smartphone, 
  KeyRound, 
  Play, 
  Square, 
  Activity, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Terminal, 
  ArrowRight, 
  LockOpen, 
  Info,
  ShieldCheck,
  UserCheck,
  MessageSquare,
  Flame,
  TrendingUp,
  Clock,
  LogOut,
  Sparkles,
  Eye,
  Download,
  Music,
  Smile,
  Image,
  Power,
  Copy,
  Check
} from "lucide-react";

interface BotSession {
  phoneNumber: string;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "PAIRING_CODE_READY";
  pairingCode: string;
  logCount: number;
}

interface BotStatusResponse {
  sessions: BotSession[];
  rvoCount: number;
  rvoSuccess: number;
  startTime: number;
  globalLogCount: number;
  featureStats?: Record<string, number>;
}

interface LogEntry {
  timestamp: string;
  message: string;
}

interface Feature {
  id: string;
  name: string;
  trigger: string;
  description: string;
  usage: string;
  enabled: boolean;
}

// Gunakan local fetch wrapper agar tidak memodifikasi window.fetch secara global (yang dilarang/diblokir di beberapa browser/iframe)
const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const password = localStorage.getItem("admin_password") || "";
  const headers = new Headers(init?.headers);
  if (password) {
    headers.set("X-Admin-Password", password);
  }
  return window.fetch(input, {
    ...init,
    headers,
  });
};

export default function App() {
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [inputPassword, setInputPassword] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isDefaultPassword, setIsDefaultPassword] = useState<boolean>(false);
  const [selectedPhone, setSelectedPhone] = useState<string>("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [rvoCount, setRvoCount] = useState(0);
  const [rvoSuccess, setRvoSuccess] = useState(0);
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [uptimeStr, setUptimeStr] = useState("0s");
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [features, setFeatures] = useState<Feature[]>([]);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [featureStats, setFeatureStats] = useState<Record<string, number>>({});

  // Active navigation tab
  const [activeTab, setActiveTab] = useState<"whatsapp" | "ssh">("whatsapp");

  // SSH & VPN configuration states
  const [sshHost, setSshHost] = useState("192.168.12.3");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("bxsea");
  const [ovpnFilename, setOvpnFilename] = useState("");
  const [sshLogs, setSshLogs] = useState<any[]>([]);
  const [sshSaving, setSshSaving] = useState(false);
  const [sshSaveStatus, setSshSaveStatus] = useState<string | null>(null);
  const [vpnUploading, setVpnUploading] = useState(false);
  const [vpnUploadStatus, setVpnUploadStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const res = await apiFetch(input, init);
      if (res.status === 401) {
        const urlStr = typeof input === "string" ? input : "";
        if (!urlStr.includes("/api/auth/status") && !urlStr.includes("/api/auth/login")) {
          localStorage.removeItem("admin_password");
          setIsAuthenticated(false);
        }
      }
      return res;
    } catch (err) {
      console.warn(`Network request failed for ${input}:`, err);
      throw err;
    }
  };

  const checkAuthStatus = async () => {
    try {
      const res = await fetch("/api/auth/status");
      if (res.ok) {
        const data = await res.json();
        setIsDefaultPassword(data.isDefaultPassword);
        
        const savedPass = localStorage.getItem("admin_password");
        if (savedPass) {
          const loginRes = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: savedPass })
          });
          if (loginRes.ok) {
            setIsAuthenticated(true);
          } else {
            localStorage.removeItem("admin_password");
          }
        }
      }
    } catch (e) {
      console.warn("Gagal memeriksa status otentikasi:", e);
    } finally {
      setCheckingAuth(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: inputPassword })
      });
      if (res.ok) {
        localStorage.setItem("admin_password", inputPassword);
        setIsAuthenticated(true);
      } else {
        const data = await res.json();
        setAuthError(data.error || "Password salah!");
      }
    } catch (err) {
      setAuthError("Gagal menghubungkan ke server untuk otentikasi.");
    }
  };

  const handleLogout = () => {
    if (confirm("Beneran mau logout dari Dashboard?")) {
      localStorage.removeItem("admin_password");
      setIsAuthenticated(false);
      setInputPassword("");
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const fetchSshConfig = async () => {
    try {
      const res = await fetch("/api/ssh/config");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setSshHost(data.config.host || "192.168.12.3");
          setSshPort(data.config.port || 22);
          setSshUsername(data.config.username || "bxsea");
          setOvpnFilename(data.config.ovpnFilename || "");
        }
        if (data.logs) {
          setSshLogs(data.logs || []);
        }
      }
    } catch (e) {
      console.warn("Gagal mengambil konfigurasi SSH", e);
    }
  };

  const handleSaveSshConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSshSaving(true);
    setSshSaveStatus(null);
    try {
      const res = await fetch("/api/ssh/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: sshHost, port: sshPort, username: sshUsername })
      });
      if (res.ok) {
        setSshSaveStatus("success");
        setTimeout(() => setSshSaveStatus(null), 3000);
      } else {
        setSshSaveStatus("error");
      }
    } catch (e) {
      setSshSaveStatus("error");
    } finally {
      setSshSaving(false);
    }
  };

  const handleUploadOvpn = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVpnUploading(true);
    setVpnUploadStatus(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/ssh/ovpn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content: text })
      });
      if (res.ok) {
        const data = await res.json();
        setOvpnFilename(data.config?.ovpnFilename || file.name);
        setVpnUploadStatus("success");
        setTimeout(() => setVpnUploadStatus(null), 3000);
      } else {
        setVpnUploadStatus("error");
      }
    } catch (e) {
      setVpnUploadStatus("error");
    } finally {
      setVpnUploading(false);
    }
  };

  const getFeatureIcon = (id: string) => {
    switch (id) {
      case "rvo":
        return <Eye className="w-4 h-4 text-emerald-400" />;
      case "brat":
        return <Sparkles className="w-4 h-4 text-lime-400" />;
      case "bratvid":
        return <Flame className="w-4 h-4 text-amber-500 animate-pulse" />;
      case "downloader":
        return <Download className="w-4 h-4 text-blue-400" />;
      case "spotify":
        return <Music className="w-4 h-4 text-green-400" />;
      case "curl":
        return <Terminal className="w-4 h-4 text-pink-400" />;
      case "sticker":
        return <Smile className="w-4 h-4 text-purple-400" />;
      case "phot":
        return <Image className="w-4 h-4 text-yellow-400" />;
      default:
        return <Info className="w-4 h-4 text-gray-400" />;
    }
  };

  const fetchFeatures = async () => {
    try {
      const res = await fetch("/api/features");
      if (res.ok) {
        const data = await res.json();
        setFeatures(data.features || []);
      }
    } catch (e) {
      console.warn("Gagal mengambil daftar fitur", e);
    }
  };

  const handleToggleFeature = async (id: string, currentStatus: boolean) => {
    setTogglingId(id);
    try {
      const res = await fetch("/api/features/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: !currentStatus })
      });
      if (res.ok) {
        setFeatures(prev => prev.map(f => f.id === id ? { ...f, enabled: !currentStatus } : f));
      } else {
        const errData = await res.json();
        alert(errData.error || "Gagal mengubah status fitur.");
      }
    } catch (e) {
      console.warn("Gagal mengubah status fitur", e);
    } finally {
      setTogglingId(null);
    }
  };

  // Poll status & logs
  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/bot/status");
      if (res.ok) {
        const data: BotStatusResponse = await res.json();
        const sessionList = data.sessions || [];
        setSessions(sessionList);
        
        if (typeof data.rvoCount === "number") setRvoCount(data.rvoCount);
        if (typeof data.rvoSuccess === "number") setRvoSuccess(data.rvoSuccess);
        if (data.startTime) setStartTime(data.startTime);
        if (data.featureStats) setFeatureStats(data.featureStats);

        // Auto select first session if nothing is selected yet
        if (sessionList.length > 0) {
          setSelectedPhone(prev => {
            if (!prev || !sessionList.some(s => s.phoneNumber === prev)) {
              return sessionList[0].phoneNumber;
            }
            return prev;
          });
        } else {
          setSelectedPhone("");
        }
      }
    } catch (e) {
      console.warn("Gagal mengambil status bot", e);
    }
  };

  const fetchLogs = async () => {
    try {
      const url = selectedPhone ? `/api/bot/logs?phone=${selectedPhone}` : "/api/bot/logs";
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (e) {
      console.warn("Gagal mengambil logs", e);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchStatus();
    fetchLogs();
    fetchSshConfig();

    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
      fetchSshConfig();
    }, 3000);

    return () => clearInterval(interval);
  }, [selectedPhone, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchFeatures();
    fetchSshConfig();
  }, [isAuthenticated]);

  // Format Uptime Client Side
  useEffect(() => {
    const updateUptime = () => {
      const diff = Date.now() - startTime;
      const secs = Math.floor(diff / 1000);
      const mins = Math.floor(secs / 60);
      const hours = Math.floor(mins / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) {
        setUptimeStr(`${days}d ${hours % 24}h`);
      } else if (hours > 0) {
        setUptimeStr(`${hours}h ${mins % 60}m`);
      } else if (mins > 0) {
        setUptimeStr(`${mins}m ${secs % 60}s`);
      } else {
        setUptimeStr(`${secs}s`);
      }
    };

    updateUptime();
    const interval = setInterval(updateUptime, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const handleConnect = async (e: any) => {
    e.preventDefault();
    if (!phoneNumber) {
      setError("Nomor HP gak boleh kosong ya bos!");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/bot/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Gagal menghubungkan ke WhatsApp.");
      }

      const cleanPhone = data.phoneNumber || phoneNumber.replace(/\D/g, "");
      setSelectedPhone(cleanPhone);
      setPhoneNumber("");
      setShowAddForm(false);
      fetchStatus();
    } catch (err: any) {
      setError(err.message || "Waduh, terjadi error pas mau konekin bot.");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (phone: string) => {
    if (!confirm(`Beneran mau mutusin koneksi bot untuk nomor +${phone}?`)) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/bot/disconnect", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Gagal memutuskan koneksi.");
      }
      
      if (selectedPhone === phone) {
        setSelectedPhone("");
      }
      fetchStatus();
    } catch (err: any) {
      setError(err.message || "Gagal mutusin koneksi.");
    } finally {
      setLoading(false);
    }
  };

  // Find the selected session or default
  const activeSession = sessions.find(s => s.phoneNumber === selectedPhone);
  const currentStatus = activeSession ? activeSession.status : "DISCONNECTED";
  const currentPairingCode = activeSession ? activeSession.pairingCode : "";

  const handleCopyCode = () => {
    if (currentPairingCode) {
      navigator.clipboard.writeText(currentPairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Astro the space/robot companion commentary generator based on bot status
  const getAstroCommentary = () => {
    switch (currentStatus) {
      case "CONNECTED":
        return {
          action: "*muka sombong sambil ngunyah apel*",
          text: `BEIDIIH! Mantap, nomor +${selectedPhone} udah konek! Sekarang kirim media View Once terus reply ketik 'rvo' biar langsung gue bongkar! Oh ya, cobain juga ketik '.brat <teks>' buat bikin STIKER ala album BRAT, atau '.bratvid <teks>' buat versi stiker animasi! 🔥🚀`
        };
      case "CONNECTING":
        return {
          action: "*garuk-garuk kepala pusing*",
          text: `Sabar bos, server lagi ngehubungin nomor +${selectedPhone} ke WhatsApp... Semoga internet lo gak lemot kayak siput! Pasang mata baek-baek ya!`
        };
      case "PAIRING_CODE_READY":
        return {
          action: "*teriak heboh sambil nunjuk layar*",
          text: `Tuh kode tautan buat +${selectedPhone} udah nongol! Buruan buka WA -> Perangkat Tertaut -> Tautkan dengan Nomor HP, terus masukin kodenya cepetan sebelum basi! 💀🤣`
        };
      case "DISCONNECTED":
      default:
        if (loading) {
          return {
            action: "*guling-guling heboh*",
            text: "Waduh waduh! Mesin Baileys lagi dipanasin! Duduk manis dulu, kode tautan 8-digit lo lagi diproses!"
          };
        }
        return {
          action: "*guling-guling kelaperan*",
          text: "Hubungkan nomor WhatsApp baru atau pilih nomor aktif di daftar biar gue bangun dari mager dan bantuin lo buka media View Once! 😭🚀"
        };
    }
  };

  const astro = getAstroCommentary();

  // Helper to render individual characters for pairing code
  const renderPairingCodeChars = () => {
    const paddedCode = (currentPairingCode || "--------").replace(/[^A-Za-z0-9]/g, "").padEnd(8, "-");
    const chars = paddedCode.split("");
    
    return (
      <div className="grid grid-cols-8 gap-1.5 justify-center py-2">
        {chars.map((char, index) => (
          <div key={index} className="linking-code-char text-center select-all">
            {char === "-" ? "" : char}
          </div>
        ))}
      </div>
    );
  };

  // Success rate formula
  const successRate = rvoCount === 0 ? "100%" : `${((rvoSuccess / rvoCount) * 100).toFixed(1)}%`;

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-wa-bg-main text-wa-text-light flex flex-col items-center justify-center font-sans">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 rounded-full border-4 border-emerald-500/20 border-t-emerald-500 animate-spin" />
          <p className="text-sm font-semibold text-gray-400">Menghubungkan ke Astro Shield Guard...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-wa-bg-main text-wa-text-light flex items-center justify-center font-sans p-4 relative overflow-hidden">
        {/* Background Decorative Circles */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-500/5 rounded-full filter blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-rose-500/5 rounded-full filter blur-3xl pointer-events-none" />

        <div className="w-full max-w-md bg-wa-bg-dark/85 backdrop-blur-xl border border-white/5 p-8 rounded-3xl shadow-2xl relative z-10 space-y-6">
          <div className="text-center space-y-3">
            <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 items-center justify-center shadow-lg shadow-emerald-500/10 mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Astro Shield Guard 🔒</h1>
            <p className="text-xs text-gray-400 leading-relaxed">
              Dashboard ini dilindungi secara ketat demi mencegah akses ilegal atau penyalahgunaan penautan WhatsApp.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider block">Admin Access Token / Password</label>
              <div className="relative">
                <input
                  type="password"
                  required
                  placeholder="Masukkan Password Admin..."
                  value={inputPassword}
                  onChange={(e) => setInputPassword(e.target.value)}
                  className="w-full bg-white/5 px-4 py-3 rounded-xl text-sm text-white outline-none border border-white/5 focus:border-emerald-500/50 transition-colors font-mono tracking-widest text-center"
                />
              </div>
            </div>

            {authError && (
              <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{authError}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-emerald-950/30 flex items-center justify-center gap-2 cursor-pointer"
            >
              <LockOpen className="w-4 h-4" />
              BUKA AKSES DASHBOARD
            </button>
          </form>

          {isDefaultPassword && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl space-y-1.5">
              <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider block flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                SANGAT PENTING: Password Default Aktif!
              </span>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Kamu masih menggunakan password bawaan sistem (<code className="bg-amber-500/10 text-amber-400 font-mono px-1 py-0.5 rounded font-bold">admin123</code>). 
                Segera set variabel <code className="text-white font-mono">ADMIN_PASSWORD</code> di Dashboard Railway atau VPS kamu untuk keamanan maksimal!
              </p>
            </div>
          )}

          <div className="text-center pt-2">
            <span className="text-[9px] text-gray-500 uppercase tracking-widest font-mono">ASTRO SECURITY SYSTEM V3.0</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-wa-bg-main text-wa-text-light flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      
      {/* Header */}
      <header className="border-b border-white/5 bg-wa-bg-dark/80 backdrop-blur-md sticky top-0 z-40 px-6 py-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-3.5">
            <div className="w-10 h-10 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">ASTRO <span className="text-emerald-400">RVO BOT</span></h1>
              <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">V3.0 ASTRO EDITION</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
              <div className={`w-2 h-2 rounded-full ${sessions.some(s => s.status === "CONNECTED") ? "bg-emerald-500 animate-pulse" : "bg-amber-400"}`}></div>
              <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider">
                {sessions.some(s => s.status === "CONNECTED") ? "SYSTEM ACTIVE" : "STANDBY MODE"}
              </span>
            </div>
            <div className="text-xs text-gray-500 font-mono">
              {new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-xl border border-rose-500/20 text-xs font-bold transition-all cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Navigation Tabs */}
        <div className="lg:col-span-12 flex border-b border-white/5 pb-2">
          <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5">
            <button
              onClick={() => setActiveTab("whatsapp")}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
                activeTab === "whatsapp"
                  ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/10"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              <Smartphone className="w-4 h-4" />
              WhatsApp Bot
            </button>
            <button
              onClick={() => setActiveTab("ssh")}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
                activeTab === "ssh"
                  ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/10"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              <Terminal className="w-4 h-4" />
              SSH Docker Logger
            </button>
          </div>
        </div>

        {isDefaultPassword && (
          <div className="lg:col-span-12 p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-bounce" />
              <div className="space-y-0.5">
                <h4 className="font-bold text-amber-400 text-xs uppercase tracking-wide">Peringatan Keamanan: Menggunakan Password Bawaan</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Dashboard kamu masih menggunakan password default <code className="bg-amber-500/15 text-amber-400 font-mono px-1 py-0.5 rounded font-bold">admin123</code>. 
                  Siapa pun bisa mengakses jika mereka menebak password ini. Segera tambahkan variable <code className="text-white font-mono bg-white/5 px-1 py-0.5 rounded font-semibold">ADMIN_PASSWORD</code> di tab Variables Railway atau VPS kamu untuk mengamankannya!
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === "whatsapp" ? (
          <>
            {/* Left Column: Device Pairing & Configuration */}
            <section className="lg:col-span-5 flex flex-col space-y-6">
          
          {/* Astro Companion Box (Interactive dialogue box) */}
          <div className="glass rounded-3xl p-5 relative overflow-hidden transition-all duration-300 hover:shadow-emerald-950/20 hover:shadow-lg border-l-4 border-l-emerald-500">
            <div className="absolute right-2 bottom-0 text-6xl select-none opacity-5 pointer-events-none">
              🚀
            </div>
            <div className="flex gap-4 items-start relative z-10">
              <div className="text-3xl filter drop-shadow">🤖</div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-bold text-emerald-400 text-xs tracking-wider uppercase">ASTRO COMPANION</h4>
                  <span className="text-[10px] text-gray-400 italic font-mono">{astro.action}</span>
                </div>
                <p className="text-gray-200 text-sm leading-relaxed font-medium">
                  "{astro.text}"
                </p>
              </div>
            </div>
          </div>

          {/* Active Bot Sessions List */}
          <div className="glass rounded-3xl p-6 flex flex-col space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-emerald-400" />
                Active Bots
              </h2>
              <button
                onClick={() => {
                  setShowAddForm(!showAddForm);
                  if (!showAddForm) {
                    setSelectedPhone("");
                  }
                }}
                className="bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold px-3 py-1.5 rounded-xl transition-all active:scale-95 flex items-center gap-1 cursor-pointer"
              >
                {showAddForm ? "Daftar Bot" : "➕ Tambah Bot"}
              </button>
            </div>

            {sessions.length === 0 && !showAddForm && (
              <div className="text-center py-6 text-gray-500 text-xs">
                Belum ada bot yang terhubung. Klik "Tambah Bot" di atas untuk memulai!
              </div>
            )}

            {sessions.length > 0 && !showAddForm && (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {sessions.map((s) => (
                  <div
                    key={s.phoneNumber}
                    onClick={() => {
                      setSelectedPhone(s.phoneNumber);
                      setShowAddForm(false);
                    }}
                    className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                      selectedPhone === s.phoneNumber
                        ? "bg-emerald-500/10 border-emerald-500/30"
                        : "bg-white/5 border-transparent hover:bg-white/10"
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <div className={`w-2.5 h-2.5 rounded-full ${
                        s.status === "CONNECTED"
                          ? "bg-emerald-500 animate-pulse"
                          : s.status === "CONNECTING" || s.status === "PAIRING_CODE_READY"
                          ? "bg-amber-400 animate-pulse"
                          : "bg-rose-500"
                      }`} />
                      <div>
                        <p className="text-xs font-bold font-mono">+{s.phoneNumber}</p>
                        <p className="text-[10px] text-gray-400 font-medium">
                          {s.status === "CONNECTED"
                            ? "Connected & Active"
                            : s.status === "PAIRING_CODE_READY"
                            ? "Pairing Code Ready"
                            : s.status === "CONNECTING"
                            ? "Connecting..."
                            : "Disconnected"}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDisconnect(s.phoneNumber);
                      }}
                      className="p-1.5 hover:bg-rose-500/10 hover:text-rose-400 text-gray-500 rounded-lg transition-colors cursor-pointer"
                      title="Putus Koneksi"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Device Pairing / Session Controller Card */}
          <div className="glass rounded-3xl p-6 flex flex-col space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-emerald-400" />
                {showAddForm || sessions.length === 0 ? "Hubungkan Bot Baru" : "Bot Controller"}
              </h2>
              <p className="text-xs text-gray-400">
                {showAddForm || sessions.length === 0
                  ? "Masukkan nomor WhatsApp baru untuk mengambil kode tautan (pairing code)."
                  : `Status penautan dan kontrol khusus untuk bot nomor +${selectedPhone}.`}
              </p>
            </div>

            {error && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            <div className="wa-bg-dark rounded-2xl p-5 border border-white/5 space-y-4">
              
              {/* Form Input for Phone */}
              {(showAddForm || sessions.length === 0) && (
                <form onSubmit={handleConnect} className="space-y-4">
                  <div className="flex flex-col">
                    <label className="text-[10px] text-gray-500 font-bold uppercase mb-2">Phone Number</label>
                    <div className="flex space-x-2">
                      <span className="bg-white/5 px-3 py-2.5 rounded-lg text-sm text-gray-300 font-mono flex items-center">
                        🇮🇩 +62
                      </span>
                      <input
                        type="text"
                        required
                        disabled={loading}
                        placeholder="8123456789"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        className="flex-1 bg-white/5 px-3 py-2.5 rounded-lg text-sm text-white outline-none border border-transparent focus:border-emerald-500/50 transition-colors font-mono"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-emerald-950/30 flex items-center justify-center gap-2 active:scale-95 cursor-pointer"
                  >
                    {loading ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin text-white" />
                        GETTING LINKING CODE...
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 fill-current text-white" />
                        HUBUNGKAN & AMBIL KODE
                      </>
                    )}
                  </button>
                </form>
              )}

              {/* State: Connecting */}
              {!(showAddForm || sessions.length === 0) && currentStatus === "CONNECTING" && (
                <div className="py-6 flex flex-col items-center justify-center text-center gap-4">
                  <div className="w-12 h-12 rounded-full border-2 border-emerald-500/20 border-t-emerald-500 animate-spin" />
                  <div className="space-y-1">
                    <p className="font-semibold text-emerald-400 text-sm">Sedang Menghubungkan...</p>
                    <p className="text-[11px] text-gray-400 font-mono">
                      Mengontak server WhatsApp untuk: <span className="text-white font-bold">+{selectedPhone}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => handleDisconnect(selectedPhone)}
                    className="mt-2 bg-white/5 hover:bg-rose-500/10 hover:text-rose-400 border border-white/5 text-[10px] uppercase font-bold tracking-wider py-2 px-4 rounded-xl transition-all cursor-pointer"
                  >
                    BATALKAN KONEKSI
                  </button>
                </div>
              )}

              {/* State: Pairing Code Ready */}
              {!(showAddForm || sessions.length === 0) && currentStatus === "PAIRING_CODE_READY" && (
                <div className="space-y-4">
                  <div className="flex flex-col">
                    <label className="text-[10px] text-gray-500 font-bold uppercase mb-3">8-Digit Linking Code</label>
                    
                    {/* Render Character Grid */}
                    {renderPairingCodeChars()}

                    {/* Copy Button */}
                    <div className="flex justify-center mt-2 mb-3">
                      <button
                        onClick={handleCopyCode}
                        className="flex items-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/25 px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 cursor-pointer"
                      >
                        {copied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            Berhasil Disalin!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            Salin Kode ({currentPairingCode})
                          </>
                        )}
                      </button>
                    </div>

                    <p className="text-[10px] text-center mt-2 text-gray-500 italic leading-relaxed">
                      Masukkan kode di atas pada ponsel Anda melalui menu WhatsApp Web &rarr; Tautkan Perangkat &rarr; Tautkan dengan Nomor Telepon.
                    </p>
                  </div>

                  <div className="pt-2 flex flex-col gap-2">
                    <button
                      onClick={fetchStatus}
                      className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-2.5 rounded-xl transition-all shadow-lg shadow-emerald-950/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <RefreshCw className="w-4 h-4" />
                      CEK STATUS KONEKSI
                    </button>
                    <button
                      onClick={() => handleDisconnect(selectedPhone)}
                      className="w-full bg-white/5 hover:bg-white/10 text-white font-medium py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Square className="w-4 h-4" />
                      BATALKAN PENAUTAN
                    </button>
                  </div>
                </div>
              )}

              {/* State: Connected */}
              {!(showAddForm || sessions.length === 0) && currentStatus === "CONNECTED" && (
                <div className="space-y-4 text-center py-2">
                  <div className="inline-flex w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 items-center justify-center text-emerald-400 mb-2">
                    <UserCheck className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="font-bold text-emerald-400 text-sm">Bot Berhasil Terhubung!</h4>
                    <p className="text-xs text-gray-400">
                      Tersambung ke nomor: <span className="font-mono text-white font-bold">+{selectedPhone}</span>
                    </p>
                  </div>

                  <div className="bg-white/5 p-4 rounded-xl border border-white/5 text-left space-y-2">
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest block flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      PROTEKSI RVO AKTIF
                    </span>
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Kirim pesan foto/video <span className="text-white font-semibold">View Once</span> lalu reply dengan ketik <code className="bg-emerald-500/10 text-emerald-400 font-mono px-1 py-0.5 rounded font-bold">rvo</code> atau <code className="bg-emerald-500/10 text-emerald-400 font-mono px-1 py-0.5 rounded font-bold">.rvo</code> di WhatsApp untuk membuka otomatis.
                    </p>
                  </div>

                  <button
                    onClick={() => handleDisconnect(selectedPhone)}
                    className="w-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    PUTUSKAN HUBUNGAN BOT
                  </button>
                </div>
              )}

            </div>
          </div>

          {/* Feature Toggles & Usage Guide Panel */}
          <div className="glass rounded-3xl p-6 flex flex-col space-y-5">
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Daftar Fitur & Kontrol
              </h2>
              <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                Aktifkan atau nonaktifkan fitur bot secara instan. Fitur yang dinonaktifkan tidak akan merespon perintah chat.
              </p>
            </div>

            <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1 select-none scrollbar-thin">
              {features.map((feat) => (
                <div 
                  key={feat.id} 
                  className={`p-3.5 rounded-2xl border transition-all duration-300 ${
                    feat.enabled 
                      ? "bg-white/[0.02] border-white/5 hover:border-emerald-500/20" 
                      : "bg-black/25 border-white/5 opacity-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center space-x-2.5">
                      <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center shrink-0 border border-white/5">
                        {getFeatureIcon(feat.id)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-white leading-tight">{feat.name}</h4>
                          <span className={`text-[8px] px-1.5 py-0.5 rounded font-mono font-bold uppercase tracking-wider ${
                            feat.enabled 
                              ? "bg-emerald-500/10 text-emerald-400" 
                              : "bg-rose-500/10 text-rose-400"
                          }`}>
                            {feat.enabled ? "AKTIF" : "NONAKTIF"}
                          </span>
                        </div>
                        <p className="text-[10px] text-emerald-400/80 font-mono mt-1">
                          Trigger: <code className="bg-white/5 px-1 py-0.5 rounded text-[9px] text-emerald-400 border border-white/5">{feat.trigger}</code>
                        </p>
                      </div>
                    </div>

                    {/* Custom Toggle Switch */}
                    <button
                      onClick={() => handleToggleFeature(feat.id, feat.enabled)}
                      disabled={togglingId === feat.id}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        feat.enabled ? "bg-emerald-500" : "bg-zinc-800"
                      } ${togglingId === feat.id ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition duration-200 ease-in-out ${
                          feat.enabled ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-2.5 border-t border-white/5 pt-2 space-y-1.5">
                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      {feat.description}
                    </p>
                    <div className="bg-black/30 rounded-lg p-2 text-[10px] text-gray-300 font-medium border border-white/5 flex items-start gap-1">
                      <span className="text-emerald-400 font-bold shrink-0">Cara:</span>
                      <span className="leading-relaxed">{feat.usage}</span>
                    </div>
                  </div>
                </div>
              ))}
              {features.length === 0 && (
                <p className="text-xs text-gray-500 text-center py-4">Memuat daftar fitur...</p>
              )}
            </div>
          </div>

        </section>

        {/* Right Column: Metrics & Live Console Logs */}
        <section className="lg:col-span-7 flex flex-col space-y-6">
          
          {/* Metrics Row */}
          <div className="grid grid-cols-3 gap-4">
            
            <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
              <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Flame className="w-3.5 h-3.5 text-amber-500" />
                RVO Intercepted
              </div>
              <div className="text-3xl font-bold font-mono text-white mt-1">
                {rvoCount}
              </div>
            </div>

            <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
              <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                Success Rate
              </div>
              <div className="text-3xl font-bold font-mono text-emerald-400 mt-1">
                {successRate}
              </div>
            </div>

            <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
              <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-blue-400" />
                Session Uptime
              </div>
              <div className="text-3xl font-bold font-mono text-white mt-1">
                {uptimeStr}
              </div>
            </div>

          </div>

          {/* Feature Usage Stats Card */}
          <div className="wa-bg-panel p-6 rounded-3xl border border-white/5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  Statistik Penggunaan Fitur Teraktif 📊
                </h3>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Frekuensi pemakaian perintah chatbot oleh pengguna WhatsApp.
                </p>
              </div>
              <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-full font-mono font-bold uppercase tracking-wider">
                LIVE METRICS
              </span>
            </div>

            <div className="space-y-3.5 pt-2">
              {(() => {
                // Combine defaultFeatures with the real-time featureStats count
                const statsData = features.map(feat => {
                  const count = featureStats[feat.id] || 0;
                  return {
                    ...feat,
                    count
                  };
                }).sort((a, b) => b.count - a.count);

                const maxCount = Math.max(...statsData.map(d => d.count), 1);
                const totalUsage = statsData.reduce((acc, curr) => acc + curr.count, 0);

                if (totalUsage === 0) {
                  return (
                    <div className="text-center py-8 bg-black/15 rounded-2xl border border-white/5 space-y-2">
                      <div className="text-2xl">🐼</div>
                      <p className="text-xs text-gray-400">Belum ada perintah yang dieksekusi.</p>
                      <p className="text-[10px] text-gray-500">Cobalah kirim perintah seperti <code className="bg-white/5 px-1 py-0.5 rounded text-emerald-400 font-mono text-[9px]">.menuas</code> atau <code className="bg-white/5 px-1 py-0.5 rounded text-emerald-400 font-mono text-[9px]">.brat</code> di WhatsApp!</p>
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Left Column: Top Features list with visual progress bar */}
                    <div className="space-y-3 bg-black/15 p-4 rounded-2xl border border-white/5">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Daftar Peringkat Fitur</span>
                      <div className="space-y-3.5 max-h-[220px] overflow-y-auto pr-1">
                        {statsData.map((item, index) => {
                          const percentage = Math.round((item.count / maxCount) * 100);
                          const isTop = index === 0;
                          return (
                            <div key={item.id} className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center space-x-2">
                                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                                    index === 0 ? "bg-amber-400/20 text-amber-400" :
                                    index === 1 ? "bg-slate-400/20 text-slate-400" :
                                    index === 2 ? "bg-amber-600/20 text-amber-600" :
                                    "bg-white/5 text-gray-400"
                                  }`}>
                                    {index + 1}
                                  </span>
                                  <div className="flex items-center gap-1.5 font-medium text-white">
                                    {getFeatureIcon(item.id)}
                                    <span className="truncate max-w-[120px]">{item.name}</span>
                                  </div>
                                </div>
                                <span className="font-mono text-[11px] font-bold text-emerald-400 flex items-center gap-1">
                                  {item.count} <span className="text-gray-500 text-[9px] font-normal">kali</span>
                                </span>
                              </div>
                              <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full rounded-full transition-all duration-500 ${
                                    isTop 
                                      ? "bg-gradient-to-r from-emerald-500 to-teal-400" 
                                      : "bg-gradient-to-r from-emerald-600/70 to-teal-500/70"
                                  }`}
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Right Column: Visual Bento Grid with stats breakdown */}
                    <div className="flex flex-col justify-between space-y-4">
                      {/* Total Stats card */}
                      <div className="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 p-4 rounded-2xl border border-emerald-500/20 flex flex-col justify-between flex-1">
                        <div>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest block mb-1">TOTAL EKSEKUSI</span>
                          <div className="text-4xl font-black font-mono text-white tracking-tight mt-1">
                            {totalUsage} <span className="text-xs font-normal text-gray-400">Penggunaan</span>
                          </div>
                        </div>
                        <p className="text-[11px] text-gray-400 leading-relaxed mt-4">
                          *RVO, Brat, Downloader, dan Spotify* adalah rentetan fitur yang paling diminati oleh pengguna aktif bot ini.
                        </p>
                      </div>

                      {/* Top Feature Spotlight Card */}
                      <div className="bg-white/[0.02] p-4 rounded-2xl border border-white/5 flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-400/20 to-amber-500/20 border border-amber-400/30 flex items-center justify-center shrink-0">
                          <Flame className="w-6 h-6 text-amber-400 animate-pulse" />
                        </div>
                        <div className="space-y-0.5 min-w-0">
                          <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider block">FITUR TERPOPULER 🔥</span>
                          <h4 className="font-bold text-white text-sm truncate">{statsData[0].name}</h4>
                          <p className="text-[10px] text-gray-400 font-mono truncate">Trigger: {statsData[0].trigger}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Live Console Logs Panel */}
          <div className="flex-1 wa-bg-panel rounded-3xl border border-white/5 overflow-hidden flex flex-col min-h-[400px]">
            <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-wa-bg-dark/40 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <h3 className="font-semibold text-sm">Console Logs</h3>
                <select
                  value={selectedPhone}
                  onChange={(e) => setSelectedPhone(e.target.value)}
                  className="bg-white/5 border border-white/10 text-xs text-white rounded-lg px-2 py-1 outline-none focus:border-emerald-500 font-mono"
                >
                  <option value="" className="bg-slate-900 text-white">Global (Combined)</option>
                  {sessions.map(s => (
                    <option key={s.phoneNumber} value={s.phoneNumber} className="bg-slate-900 text-white">
                      Bot +{s.phoneNumber}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded font-mono font-bold tracking-widest uppercase animate-pulse">
                  REALTIME_SYNC
                </span>
                <button 
                  onClick={fetchLogs}
                  title="Refresh Log secara manual"
                  className="text-gray-400 hover:text-emerald-400 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Logs Area */}
            <div className="flex-1 p-6 font-mono text-xs space-y-2.5 overflow-y-auto max-h-[450px] custom-scrollbar bg-slate-950/20">
              {logs.length === 0 ? (
                <div className="text-gray-600 italic text-center py-20 font-sans">
                  Belum ada aktivitas terekam. Silakan tautkan bot ke WhatsApp!
                </div>
              ) : (
                logs.map((log, index) => {
                  let isSuccess = log.message.includes("BERHASIL") || log.message.includes("Sukses") || log.message.includes("berhasil");
                  let isError = log.message.includes("Error") || log.message.includes("Gagal") || log.message.includes("terputus");
                  let isCommand = log.message.includes("Perintah") || log.message.includes("Command");

                  return (
                    <div 
                      key={index} 
                      className={`py-1 border-b border-white/5 last:border-0 flex items-start gap-2.5 transition-colors hover:bg-white/5 px-2 rounded-lg ${
                        isSuccess ? "text-emerald-400 bg-emerald-950/10" : isError ? "text-rose-400 bg-rose-950/10" : isCommand ? "text-blue-400" : "text-gray-300"
                      }`}
                    >
                      <span className="text-gray-600 shrink-0 select-none">[{log.timestamp}]</span>
                      <span className="leading-relaxed break-all">
                        {log.message.startsWith("RVO ") ? (
                          <>
                            <span className="text-emerald-400 font-bold">RVO: </span>
                            {log.message.substring(4)}
                          </>
                        ) : log.message}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom info log panel */}
            <div className="px-6 py-3 border-t border-white/5 bg-wa-bg-dark/20 text-[10px] text-gray-500 flex items-center justify-between font-mono">
              <span>Auto-refresh aktif (3 detik)</span>
              <span>Total: {logs.length} baris logs</span>
            </div>
          </div>

        </section>
          </>
        ) : (
          <>
            {/* Left Column: SSH & VPN Settings */}
            <section className="lg:col-span-5 flex flex-col space-y-6">
              
              {/* Security Guard Advisory */}
              <div className="glass rounded-3xl p-5 relative overflow-hidden transition-all duration-300 border-l-4 border-l-amber-500 bg-amber-500/5">
                <div className="absolute right-2 bottom-0 text-6xl select-none opacity-5 pointer-events-none">
                  🛡️
                </div>
                <div className="flex gap-4 items-start relative z-10">
                  <div className="text-3xl filter drop-shadow">🛡️</div>
                  <div className="space-y-1">
                    <h4 className="font-bold text-amber-400 text-xs tracking-wider uppercase">Sistem Keamanan Berlapis</h4>
                    <p className="text-gray-300 text-xs leading-relaxed">
                      Bot dikonfigurasi secara <span className="text-amber-400 font-bold">Read-Only</span>. Semua instruksi modifikasi berkas (<code className="bg-black/30 px-1 py-0.5 rounded text-rose-400 font-bold">rm, edit, touch, mkdir</code>) diblokir secara mutlak pada level program sebelum dikirim ke server <code className="text-white font-mono">{sshUsername}@{sshHost}</code>.
                    </p>
                  </div>
                </div>
              </div>

              {/* SSH Config Form */}
              <div className="glass rounded-3xl p-6 flex flex-col space-y-4">
                <div>
                  <h2 className="text-md font-bold text-white flex items-center gap-2">
                    <KeyRound className="w-5 h-5 text-emerald-400" />
                    Konfigurasi SSH Server
                  </h2>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    Tentukan rincian server bxsea target untuk penarikan log aman.
                  </p>
                </div>

                <form onSubmit={handleSaveSshConfig} className="space-y-4">
                  <div className="space-y-3 bg-black/20 p-4 rounded-2xl border border-white/5">
                    <div>
                      <label className="text-[9px] text-gray-400 font-bold uppercase block mb-1">Host Server / IP</label>
                      <input
                        type="text"
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-emerald-500"
                        placeholder="192.168.12.3"
                        required
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="text-[9px] text-gray-400 font-bold uppercase block mb-1">Username</label>
                        <input
                          type="text"
                          value={sshUsername}
                          onChange={(e) => setSshUsername(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-emerald-500"
                          placeholder="bxsea"
                          required
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-gray-400 font-bold uppercase block mb-1">Port</label>
                        <input
                          type="number"
                          value={sshPort}
                          onChange={(e) => setSshPort(Number(e.target.value))}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-emerald-500"
                          placeholder="22"
                          required
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={sshSaving}
                    className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 text-xs cursor-pointer"
                  >
                    {sshSaving ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin animate-infinite duration-1000" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    SIMPAN KONFIGURASI SSH
                  </button>

                  {sshSaveStatus === "success" && (
                    <p className="text-[10px] text-emerald-400 font-bold text-center mt-1">✓ Konfigurasi berhasil disimpan!</p>
                  )}
                  {sshSaveStatus === "error" && (
                    <p className="text-[10px] text-rose-400 font-bold text-center mt-1">✗ Gagal menyimpan konfigurasi.</p>
                  )}
                </form>
              </div>

              {/* VPN Configuration Card */}
              <div className="glass rounded-3xl p-6 flex flex-col space-y-4">
                <div>
                  <h2 className="text-md font-bold text-white flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-blue-400" />
                    OpenVPN (.ovpn) Profil
                  </h2>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    Unggah file konfigurasi VPN Anda untuk merutekan lalu lintas bot WhatsApp secara aman.
                  </p>
                </div>

                <div className="space-y-4">
                  {/* File Upload Area */}
                  <div className="border-2 border-dashed border-white/10 hover:border-blue-500/40 rounded-2xl p-5 text-center bg-black/10 transition-colors relative">
                    <input
                      type="file"
                      accept=".ovpn"
                      onChange={handleUploadOvpn}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="space-y-2">
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mx-auto">
                        <Download className="w-5 h-5 rotate-180" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-bold text-gray-200">Klik atau seret berkas .ovpn ke sini</p>
                        <p className="text-[10px] text-gray-400">Hanya menerima format file .ovpn</p>
                      </div>
                    </div>
                  </div>

                  {/* VPN Status Box */}
                  <div className="bg-white/5 p-4 rounded-2xl border border-white/5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider">Berkas VPN Terpasang:</span>
                      <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${ovpnFilename ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-gray-400"}`}>
                        {ovpnFilename ? "TERUNGGAH" : "BELUM ADA"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs bg-slate-950/40 p-2.5 rounded-xl border border-white/5">
                      <Terminal className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="font-mono text-gray-300 text-[11px] truncate flex-1">
                        {ovpnFilename || "Silakan unggah profil .ovpn..."}
                      </span>
                    </div>

                    {ovpnFilename && (
                      <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-semibold bg-emerald-950/20 p-2 rounded-xl border border-emerald-500/10">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                        VPN Terowongan Terpadu Siap (Status: AKTIF)
                      </div>
                    )}
                  </div>

                  {vpnUploadStatus === "success" && (
                    <p className="text-[10px] text-emerald-400 font-bold text-center mt-1">✓ File VPN berhasil diunggah!</p>
                  )}
                  {vpnUploadStatus === "error" && (
                    <p className="text-[10px] text-rose-400 font-bold text-center mt-1">✗ Gagal mengunggah file VPN.</p>
                  )}
                </div>
              </div>

            </section>

            {/* Right Column: SSH Logs & Live Metrics */}
            <section className="lg:col-span-7 flex flex-col space-y-6">
              
              {/* Live Metrics Row */}
              <div className="grid grid-cols-3 gap-4">
                <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
                  <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                    <Terminal className="w-3.5 h-3.5 text-rose-500" />
                    Query Log Terkirim
                  </div>
                  <div className="text-3xl font-bold font-mono text-white mt-1">
                    {(sshLogs || []).filter(l => l && (l.action === "SUCCESS" || l.type === "SUCCESS")).length}
                  </div>
                </div>

                <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
                  <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                    VPN Router Status
                  </div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    AKTIF
                  </div>
                </div>

                <div className="wa-bg-panel p-4 rounded-2xl border border-white/5 hover:border-emerald-500/20 transition-all duration-300">
                  <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                    <LockOpen className="w-3.5 h-3.5 text-amber-500" />
                    Keamanan Guard
                  </div>
                  <div className="text-2xl font-bold text-amber-400 mt-1 uppercase">
                    READONLY
                  </div>
                </div>
              </div>

              {/* SSH Activities Log Panel */}
              <div className="flex-1 wa-bg-panel rounded-3xl border border-white/5 overflow-hidden flex flex-col min-h-[400px]">
                <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-wa-bg-dark/40 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <h3 className="font-semibold text-sm">Log Aktivitas Bot di Server</h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded font-mono font-bold tracking-widest uppercase animate-pulse">
                      SECURE_LOGGER
                    </span>
                    <button 
                      onClick={fetchSshConfig}
                      title="Refresh Log secara manual"
                      className="text-gray-400 hover:text-emerald-400 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Logs Area */}
                <div className="flex-1 p-6 font-mono text-xs space-y-2.5 overflow-y-auto max-h-[450px] custom-scrollbar bg-slate-950/20">
                  {(!sshLogs || sshLogs.length === 0) ? (
                    <div className="text-gray-600 italic text-center py-20 font-sans">
                      Belum ada aktivitas terekam pada server bxsea. Jalankan perintah .loger di WhatsApp untuk memulai!
                    </div>
                  ) : (
                    (sshLogs || []).map((log, index) => {
                      if (!log) return null;
                      const logAction = log.action || log.type || "INFO";
                      const logDetails = log.details || log.message || "";
                      const isSuccess = logAction === "SUCCESS";
                      const isError = logAction === "ERROR";
                      const isWarning = logAction === "WARNING";
                      const isInfo = logAction === "INFO";

                      let colorClass = "text-gray-300";
                      if (isSuccess) colorClass = "text-emerald-400 bg-emerald-950/10 border-l-2 border-emerald-500 pl-2";
                      if (isError) colorClass = "text-rose-400 bg-rose-950/10 border-l-2 border-rose-500 pl-2";
                      if (isWarning) colorClass = "text-amber-400 bg-amber-950/10 border-l-2 border-amber-500 pl-2";
                      if (isInfo) colorClass = "text-blue-400 bg-blue-950/10 border-l-2 border-blue-500 pl-2";

                      return (
                        <div 
                          key={index} 
                          className={`py-1 border-b border-white/5 last:border-0 flex items-start gap-2.5 transition-colors hover:bg-white/5 px-2 rounded-lg ${colorClass}`}
                        >
                          <span className="text-gray-600 shrink-0 select-none">[{log.timestamp || ""}]</span>
                          <span className="leading-relaxed break-all font-semibold uppercase text-[10px] shrink-0 font-bold">
                            {logAction}
                          </span>
                          <span className="leading-relaxed break-all flex-1">
                            {logDetails}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Bottom info log panel */}
                <div className="px-6 py-3 border-t border-white/5 bg-wa-bg-dark/20 text-[10px] text-gray-500 flex items-center justify-between font-mono">
                  <span>Auto-refresh aktif (3 detik)</span>
                  <span>Total: {(sshLogs || []).length} baris aktivitas</span>
                </div>
              </div>

            </section>
          </>
        )}

      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 bg-wa-bg-dark/80 py-4 px-6 mt-auto">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
          <div className="flex space-x-6">
            <span>Power: Baileys ^6.5.0</span>
            <span>Engine: Node.js 20 LTS</span>
            <span>Companion: ASTRO 🚀🛸</span>
          </div>
          <div className="text-gray-500 font-medium">
            &copy; 2026 ASTRO DEVELOPER SYSTEM • ALL RIGHTS RESERVED
          </div>
        </div>
      </footer>

    </div>
  );
}
