import express from "express";
import path from "path";
import fs from "fs";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    generateWAMessageFromContent,
    prepareWAMessageMedia
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Sticker, StickerTypes } from "wa-sticker-formatter";
import { Client } from "ssh2";
import { exec } from "child_process";

// Helper robust untuk mendapatkan fungsi makeWASocket (mengatasi isu ESM / CommonJS di esbuild)
function getMakeWASocket(): any {
    if (typeof makeWASocket === "function") {
        return makeWASocket;
    }
    try {
        const baileys = require("@whiskeysockets/baileys");
        if (typeof baileys === "function") {
            return baileys;
        }
        if (baileys && typeof baileys.default === "function") {
            return baileys.default;
        }
        if (baileys && typeof baileys.makeWASocket === "function") {
            return baileys.makeWASocket;
        }
    } catch (e) {}
    return makeWASocket;
}

// Global Exception Handlers to prevent dependencies (like wa-sticker-formatter or fluent-ffmpeg) from crashing the server
process.on("uncaughtException", (err) => {
    console.error("⚠️ UNCAUGHT EXCEPTION DETECTED:", err);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("⚠️ UNHANDLED REJECTION DETECTED:", reason);
});

// Robust pure TypeScript cURL command parser
function parseCurl(curlString: string): { url: string; method: string; headers: Record<string, string>; body?: string } {
    const cleanStr = curlString.replace(/\\\r?\n/g, " ").trim();
    const tokens: string[] = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < cleanStr.length; i++) {
        const char = cleanStr[i];
        if (escaped) {
            current += char;
            escaped = false;
        } else if (char === "\\") {
            escaped = true;
        } else if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        } else if (char === " " && !inSingleQuote && !inDoubleQuote) {
            if (current) {
                tokens.push(current);
                current = "";
            }
        } else {
            current += char;
        }
    }
    if (current) {
        tokens.push(current);
    }

    let url = "";
    let method = "GET";
    const headers: Record<string, string> = {};
    let body: string | undefined = undefined;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === "-H" || token === "--header") {
            const headerVal = tokens[i + 1];
            if (headerVal) {
                const colonIdx = headerVal.indexOf(":");
                if (colonIdx !== -1) {
                    const name = headerVal.substring(0, colonIdx).trim();
                    const value = headerVal.substring(colonIdx + 1).trim();
                    headers[name] = value;
                }
                i++;
            }
        } else if (token === "-X" || token === "--request") {
            const methodVal = tokens[i + 1];
            if (methodVal) {
                method = methodVal.toUpperCase().trim();
                i++;
            }
        } else if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
            const dataVal = tokens[i + 1];
            if (dataVal) {
                body = dataVal;
                i++;
            }
            if (method === "GET") {
                method = "POST";
            }
        } else if (token.startsWith("http://") || token.startsWith("https://")) {
            url = token;
        } else if (i > 0 && tokens[i - 1] !== "curl" && !token.startsWith("-")) {
            if (!url && (token.includes("/") || token.includes("."))) {
                url = token;
            }
        }
    }

    return { url, method, headers, body };
}

function findMediaNode(node: any): { message: any; type: "image" | "video" | "sticker" | "audio" } | null {
    if (!node || typeof node !== "object") return null;
    
    if (node.imageMessage) {
        return { message: node.imageMessage, type: "image" };
    }
    if (node.videoMessage) {
        return { message: node.videoMessage, type: "video" };
    }
    if (node.stickerMessage) {
        return { message: node.stickerMessage, type: "sticker" };
    }
    if (node.audioMessage) {
        return { message: node.audioMessage, type: "audio" };
    }
    
    for (const key of Object.keys(node)) {
        if (typeof node[key] === "object" && node[key] !== null) {
            const res = findMediaNode(node[key]);
            if (res) return res;
        }
    }
    return null;
}

async function uploadToCatbox(buffer: Buffer, mimeType: string): Promise<string> {
    let ext = "jpg";
    if (mimeType.includes("png")) ext = "png";
    else if (mimeType.includes("gif")) ext = "gif";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("mp4")) ext = "mp4";
    const filename = `file.${ext}`;

    const errors: string[] = [];

    // Try 1: uguu.se (Fast and unrestricted)
    try {
        const formData = new (globalThis as any).FormData();
        const blob = new (globalThis as any).Blob([buffer], { type: mimeType });
        formData.append("files[]", blob, filename);
        const res = await fetch("https://uguu.se/upload.php", {
            method: "POST",
            body: formData,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });
        if (res.ok) {
            const json = await res.json();
            if (json && json.success && json.files && json.files[0] && json.files[0].url) {
                return json.files[0].url;
            }
        }
        errors.push(`uguu.se failed: ${res.status} ${res.statusText}`);
    } catch (e: any) {
        errors.push(`uguu.se error: ${e.message || e}`);
    }

    // Try 2: qu.ax (Alternative pomf host)
    try {
        const formData = new (globalThis as any).FormData();
        const blob = new (globalThis as any).Blob([buffer], { type: mimeType });
        formData.append("files[]", blob, filename);
        const res = await fetch("https://qu.ax/upload.php", {
            method: "POST",
            body: formData,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });
        if (res.ok) {
            const json = await res.json();
            if (json && json.success && json.files && json.files[0] && json.files[0].url) {
                return json.files[0].url;
            }
        }
        errors.push(`qu.ax failed: ${res.status} ${res.statusText}`);
    } catch (e: any) {
        errors.push(`qu.ax error: ${e.message || e}`);
    }

    // Try 3: catbox.moe (Original host as last resort, though might block cloud IPs)
    try {
        const formData = new (globalThis as any).FormData();
        formData.append("reqtype", "fileupload");
        const blob = new (globalThis as any).Blob([buffer], { type: mimeType });
        formData.append("fileToUpload", blob, filename);
        const res = await fetch("https://catbox.moe/user/api.php", {
            method: "POST",
            body: formData,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });
        if (res.ok) {
            const text = await res.text();
            if (text && text.startsWith("http")) {
                return text.trim();
            }
            errors.push(`catbox returned non-url: ${text}`);
        } else {
            errors.push(`catbox failed: ${res.status} ${res.statusText}`);
        }
    } catch (e: any) {
        errors.push(`catbox error: ${e.message || e}`);
    }

    throw new Error(`Semua provider hosting gagal mengunggah media. Log kesalahan:\n- ${errors.join("\n- ")}`);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// In-memory state
interface BotSession {
    phoneNumber: string;
    status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "PAIRING_CODE_READY";
    pairingCode: string;
    sock: any;
    logs: Array<{ timestamp: string; message: string }>;
}

const sessions: Map<string, BotSession> = new Map();
let globalLogs: Array<{ timestamp: string; message: string }> = [];

// Logger sessions state
const loggerSessions: Map<string, {
    since: string;
    container: string;
    filter: string;
    filename: string;
    timestamp: number;
}> = new Map();

// SSH Configuration & logs
interface SSHConfig {
    host: string;
    port: number;
    username: string;
    ovpnFilename: string;
}

let sshConfig: SSHConfig = {
    host: "192.168.12.3",
    port: 22,
    username: "bxsea",
    ovpnFilename: ""
};

function loadSSHConfig() {
    try {
        if (fs.existsSync("ssh_config.json")) {
            sshConfig = JSON.parse(fs.readFileSync("ssh_config.json", "utf-8"));
        }
    } catch (e) {
        console.error("Gagal membaca ssh_config.json", e);
    }
}

function saveSSHConfig() {
    try {
        fs.writeFileSync("ssh_config.json", JSON.stringify(sshConfig, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan ssh_config.json", e);
    }
}

interface SSHActivityLog {
    id: string;
    timestamp: string;
    type: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    action: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    message: string;
    details: string;
}

let sshActivityLogs: SSHActivityLog[] = [];

function loadSSHActivityLogs() {
    try {
        if (fs.existsSync("ssh_activity_logs.json")) {
            sshActivityLogs = JSON.parse(fs.readFileSync("ssh_activity_logs.json", "utf-8"));
        }
    } catch (e) {
        console.error("Gagal membaca ssh_activity_logs.json", e);
    }
}

function saveSSHActivityLogs() {
    try {
        fs.writeFileSync("ssh_activity_logs.json", JSON.stringify(sshActivityLogs, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan ssh_activity_logs.json", e);
    }
}

function addSSHActivityLog(type: "INFO" | "SUCCESS" | "WARNING" | "ERROR", message: string) {
    const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const newLog: SSHActivityLog = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp,
        type,
        action: type,
        message,
        details: message
    };
    sshActivityLogs.unshift(newLog);
    if (sshActivityLogs.length > 200) {
        sshActivityLogs = sshActivityLogs.slice(0, 200);
    }
    saveSSHActivityLogs();
}

async function runSshLoggerFlow(
    sock: any, 
    msg: any, 
    senderJid: string, 
    sessionData: { since: string; container: string; filter: string; filename: string }, 
    password: string
) {
    const { since, container, filter, filename } = sessionData;

    addSSHActivityLog("INFO", `Memulai pencarian log untuk container '${container}' oleh pengguna di WA (${senderJid.split("@")[0]}).`);

    // Status WA: Menghubungkan VPN & SSH
    const statusMsg = await sock.sendMessage(senderJid, {
        text: "⚙️ *Proses Pengambilan Log Dimulai*\n\n" +
              "1. 🌐 Membuka Terowongan VPN (OpenVPN config loaded)... 🟩\n" +
              "2. 🔐 Menghubungkan SSH ke `" + sshConfig.username + "@" + sshConfig.host + ":" + sshConfig.port + "`... 🔄\n" +
              "3. 🔍 Menjalankan filter log... ⬜\n" +
              "4. 📦 Mengunduh & mengirim berkas... ⬜"
    }, { quoted: msg });

    // Sanitize parameters strictly
    const sinceSafe = since.replace(/[^a-zA-Z0-9-T:_.]/g, "");
    const containerSafe = container.replace(/[^a-zA-Z0-9-_.//]/g, "");
    const filterSafe = filter.replace(/[^a-zA-Z0-9-_./|]/g, "");
    const filenameSafe = filename.replace(/[^a-zA-Z0-9-_.]/g, "");

    // Prepare SSH client
    const conn = new Client();
    
    conn.on("ready", () => {
        addSSHActivityLog("SUCCESS", `SSH berhasil terhubung ke ${sshConfig.host}. Menjalankan perintah filter log...`);
        
        // Update WA status
        sock.sendMessage(senderJid, {
            edit: statusMsg.key,
            text: "⚙️ *Proses Pengambilan Log Dimulai*\n\n" +
                  "1. 🌐 Membuka Terowongan VPN (OpenVPN config loaded)... 🟩\n" +
                  "2. 🔐 Menghubungkan SSH ke `" + sshConfig.username + "@" + sshConfig.host + ":" + sshConfig.port + "`... 🟩\n" +
                  "3. 🔍 Menjalankan filter log... 🔄\n" +
                  "4. 📦 Mengunduh & mengirim berkas... ⬜"
        });

        // Construct command
        // Note: We use echo password | sudo -S to support sudo
        const safePassword = password.replace(/'/g, "'\\''");
        const cmd = `echo '${safePassword}' | sudo -S docker logs --since '${sinceSafe}' ${containerSafe} 2>&1 | grep -Ei '${filterSafe}' > /tmp/${filenameSafe}`;

        addSSHActivityLog("INFO", `Menjalankan perintah: [SUDO DOCKER LOGS] on container '${containerSafe}' into '/tmp/${filenameSafe}' with regex filter.`);

        let isCommandFinished = false;
        const execTimeout = setTimeout(async () => {
            if (!isCommandFinished) {
                isCommandFinished = true;
                addSSHActivityLog("WARNING", `Pencarian log ke ${sshConfig.host} dihentikan paksa karena timeout 10 menit.`);
                try {
                    await sock.sendMessage(senderJid, {
                        edit: statusMsg.key,
                        text: "❌ *Pencarian Log Mengalami Timeout*\n\n" +
                              "Proses pencarian log di server dihentikan karena melebihi batas waktu 10 menit.\n\n" +
                              "*Kemungkinan Penyebab:*\n" +
                              "1. Password yang Anda masukkan salah sehingga prompt sudo meminta ulang kata sandi.\n" +
                              "2. Ukuran log container sangat besar (misal gigabytes) sehingga pencarian memakan waktu lama.\n" +
                              "3. Server tujuan lambat atau sedang mengalami kelebihan beban.\n\n" +
                              "_Tips: Pastikan password Anda benar dan perkecil rentang waktu pencarian agar lebih cepat._"
                    });
                } catch (sendErr) {}
                conn.end();
            }
        }, 600000);

        conn.exec(cmd, (err, stream) => {
            if (err) {
                clearTimeout(execTimeout);
                addSSHActivityLog("ERROR", `Gagal mengeksekusi perintah SSH: ${err.message}`);
                sock.sendMessage(senderJid, {
                    text: `❌ *Gagal Mengeksekusi Perintah*\n\nTerjadi kesalahan saat menjalankan perintah di server tujuan.\n\n*Error:* ${err.message}`
                }, { quoted: msg });
                conn.end();
                return;
            }

            // Drain stdout to prevent ssh2 hanging
            stream.on("data", (data: any) => {
                // Stdout is redirected to file, but we consume any potential stream output
            });

            let stderrData = "";
            stream.on("close", (code: number, signal: any) => {
                if (isCommandFinished) return;
                isCommandFinished = true;
                clearTimeout(execTimeout);
                addSSHActivityLog("INFO", `Perintah selesai dijalankan dengan exit code: ${code}. Mengunduh file hasil...`);
                
                // If there's an error with sudo or command, let's log it
                if (stderrData && !stderrData.includes("[sudo] password")) {
                    addSSHActivityLog("WARNING", `Output stderr perintah: ${stderrData.trim()}`);
                }

                // Update WA status
                sock.sendMessage(senderJid, {
                    edit: statusMsg.key,
                    text: "⚙️ *Proses Pengambilan Log Dimulai*\n\n" +
                          "1. 🌐 Membuka Terowongan VPN (OpenVPN config loaded)... 🟩\n" +
                          "2. 🔐 Menghubungkan SSH ke `" + sshConfig.username + "@" + sshConfig.host + ":" + sshConfig.port + "`... 🟩\n" +
                          "3. 🔍 Menjalankan filter log... 🟩\n" +
                          "4. 📦 Mengunduh & mengirim berkas... 🔄"
                });

                // Retrieve file using SFTP
                conn.sftp((sftpErr, sftp) => {
                    if (sftpErr) {
                        addSSHActivityLog("ERROR", `Gagal memulai sesi SFTP: ${sftpErr.message}`);
                        sock.sendMessage(senderJid, {
                            text: `❌ *Gagal Membuka SFTP*\n\nTidak dapat membuat sesi transfer file aman.\n\n*Error:* ${sftpErr.message}`
                        }, { quoted: msg });
                        conn.end();
                        return;
                    }

                    const localDir = path.join(process.cwd(), "temp_logs");
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }
                    const localPath = path.join(localDir, filenameSafe);

                    addSSHActivityLog("INFO", `Mengunduh berkas '/tmp/${filenameSafe}' dari remote ke lokal...`);

                    sftp.fastGet(`/tmp/${filenameSafe}`, localPath, {}, async (downloadErr) => {
                        if (downloadErr) {
                            addSSHActivityLog("ERROR", `Gagal mengunduh berkas log dari remote server: ${downloadErr.message}`);
                            
                            // Let's check if we can try a fallback: run cat of that file and write locally
                            addSSHActivityLog("INFO", `Mencoba fallback cat file...`);
                            conn.exec(`cat /tmp/${filenameSafe}`, (catErr, catStream) => {
                                if (catErr) {
                                    sock.sendMessage(senderJid, {
                                        text: `❌ *Gagal Mengambil Log*\n\nBerkas log tidak ditemukan atau tidak dapat diakses.\n\n*Tips:* Pastikan nama container dan filter yang Anda masukkan benar.\n\n*Error:* ${downloadErr.message}`
                                    }, { quoted: msg });
                                    conn.end();
                                    return;
                                }
                                let content = "";
                                catStream.on("data", (chunk: any) => {
                                    content += chunk.toString();
                                });
                                catStream.on("close", async () => {
                                    if (content.trim()) {
                                        fs.writeFileSync(localPath, content);
                                        await sendLogFile(sock, senderJid, localPath, filenameSafe, statusMsg, msg);
                                    } else {
                                        sock.sendMessage(senderJid, {
                                            text: `⚠️ *Log Kosong*\n\nPencarian log selesai, tetapi tidak ditemukan entri log yang cocok dengan filter \`${filterSafe}\`.`
                                        }, { quoted: msg });
                                    }
                                    
                                    // Clean up remote file via SFTP unlink
                                    sftp.unlink(`/tmp/${filenameSafe}`, () => {
                                        addSSHActivityLog("INFO", `Berkas sementara remote '/tmp/${filenameSafe}' berhasil dibersihkan.`);
                                        conn.end();
                                    });
                                });
                            });
                            return;
                        }

                        // Check size of file
                        try {
                            const stats = fs.statSync(localPath);
                            if (stats.size === 0) {
                                addSSHActivityLog("WARNING", `Hasil unduhan berkas log berukuran 0 bytes (tidak ada hasil filter).`);
                                sock.sendMessage(senderJid, {
                                    text: `⚠️ *Log Kosong*\n\nPencarian log berhasil dilakukan, tetapi tidak ada baris log yang cocok dengan filter \`${filterSafe}\` untuk container \`${containerSafe}\` sejak \`${sinceSafe}\`.`
                                }, { quoted: msg });
                                
                                sftp.unlink(`/tmp/${filenameSafe}`, () => {
                                    conn.end();
                                });
                                return;
                            }

                            // Success download, send file to WA!
                            await sendLogFile(sock, senderJid, localPath, filenameSafe, statusMsg, msg);
                        } catch (e: any) {
                            addSSHActivityLog("ERROR", `Gagal memproses berkas log lokal: ${e.message}`);
                            sock.sendMessage(senderJid, {
                                text: `❌ *Kesalahan Berkas Lokal*\n\nGagal memproses berkas log yang diunduh.`
                            }, { quoted: msg });
                        }
                        
                        // Clean up remote file via SFTP unlink
                        sftp.unlink(`/tmp/${filenameSafe}`, () => {
                            addSSHActivityLog("INFO", `Berkas sementara remote '/tmp/${filenameSafe}' berhasil dibersihkan.`);
                            conn.end();
                        });
                    });
                });
            });

            stream.stderr.on("data", (data: any) => {
                stderrData += data.toString();
            });
        });
    });

    conn.on("error", (err: any) => {
        addSSHActivityLog("ERROR", `Koneksi SSH Error ke ${sshConfig.host}: ${err.message}`);
        
        sock.sendMessage(senderJid, {
            edit: statusMsg.key,
            text: "❌ *Gagal Terhubung ke Server*\n\n" +
                  "Tidak dapat melakukan koneksi SSH ke `" + sshConfig.host + "`.\n\n" +
                  "*Kemungkinan Penyebab:*\n" +
                  "- Password yang Anda masukkan salah\n" +
                  "- Koneksi VPN diblokir atau belum terkonfigurasi dengan benar\n" +
                  "- Server tujuan sedang offline atau tidak dapat dijangkau\n\n" +
                  "_*Detail Error:*_ `" + err.message + "`"
        });
    });

    // Initiate connection
    try {
        conn.connect({
            host: sshConfig.host,
            port: sshConfig.port,
            username: sshConfig.username,
            password: password,
            tryKeyboard: true,
            readyTimeout: 15000
        });

        // Handle keyboard interactive authentication
        conn.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
            finish([password]);
        });
    } catch (connErr: any) {
        addSSHActivityLog("ERROR", `Inisiasi koneksi SSH gagal: ${connErr.message}`);
        sock.sendMessage(senderJid, {
            edit: statusMsg.key,
            text: `❌ *Kesalahan Inisiasi Koneksi*\n\n${connErr.message}`
        });
    }
}

async function sendLogFile(
    sock: any, 
    senderJid: string, 
    localPath: string, 
    filename: string, 
    statusMsg: any, 
    originalMsg: any
) {
    try {
        addSSHActivityLog("SUCCESS", `Berkas log '${filename}' berhasil diambil. Mengirim ke WhatsApp...`);

        // Send actual log file document via WA
        await sock.sendMessage(senderJid, {
            document: { url: localPath },
            fileName: filename,
            mimetype: "text/plain",
            caption: `📄 *Berkas Log Berhasil Diekstrak*\n\n` +
                     `• *File:* \`${filename}\`\n` +
                     `• *Server:* \`${sshConfig.username}@${sshConfig.host}\`\n` +
                     `• *Waktu Unduh:* ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
                     `_Berkas dikirim secara aman langsung dari VPS GCP._`
        }, { quoted: originalMsg });

        // Update status message to green complete
        await sock.sendMessage(senderJid, {
            edit: statusMsg.key,
            text: "⚙️ *Proses Pengambilan Log Selesai*\n\n" +
                  "1. 🌐 Membuka Terowongan VPN (OpenVPN config loaded)... 🟩\n" +
                  "2. 🔐 Menghubungkan SSH ke `" + sshConfig.username + "@" + sshConfig.host + ":" + sshConfig.port + "`... 🟩\n" +
                  "3. 🔍 Menjalankan filter log... 🟩\n" +
                  "4. 📦 Mengunduh & mengirim berkas... 🟩\n\n" +
                  "✅ *Log berhasil dikirim sebagai dokumen!*"
        });

        // Safely clean up local temporary log file after sending
        try {
            fs.unlinkSync(localPath);
        } catch (unlinkErr) {}
    } catch (e: any) {
        addSSHActivityLog("ERROR", `Gagal mengirim dokumen log ke WhatsApp: ${e.message}`);
        await sock.sendMessage(senderJid, {
            text: `❌ *Gagal Mengirim Dokumen*\n\nLog berhasil diambil tetapi gagal dikirim ke WhatsApp.\n\n*Error:* ${e.message}`
        }, { quoted: originalMsg });
    }
}

// Feature Toggles configuration
const defaultFeatures = [
    {
        id: "rvo",
        name: "Reveal View Once (RVO)",
        trigger: ".rvo, !rvo",
        description: "Membongkar foto/video sekali lihat (View Once) menjadi media biasa yang bisa disimpan.",
        usage: "Balas (reply) pesan View Once dengan ketik '.rvo' atau '!rvo'.",
        enabled: true
    },
    {
        id: "brat",
        name: "Brat Sticker Generator",
        trigger: ".brat, !brat",
        description: "Membuat stiker teks bergaya estetik ala album 'Brat' Charli XCX.",
        usage: "Ketik '.brat <teks>' atau '!brat <teks>'. Bisa juga disesuaikan warna: '.brat teks | bg_color | text_color'.",
        enabled: true
    },
    {
        id: "bratvid",
        name: "Brat Animated Sticker",
        trigger: ".bratvid, !bratvid",
        description: "Membuat stiker teks bergerak animasi bergaya album 'Brat'.",
        usage: "Ketik '.bratvid <teks>' atau '!bratvid <teks>'.",
        enabled: true
    },
    {
        id: "downloader",
        name: "Social Media Downloader",
        trigger: ".tt, .ig, .yt, .dl, !tt, !ig, !yt, !dl",
        description: "Mengunduh video, foto slide, atau audio dari TikTok, Instagram, YouTube, dan platform populer lainnya secara otomatis.",
        usage: "Ketik '.tt <url>', '!tt <url>', atau gunakan prefiks lainnya.",
        enabled: true
    },
    {
        id: "spotify",
        name: "Spotify Downloader",
        trigger: ".spotify, !spotify",
        description: "Mencari dan mengunduh lagu langsung dari Spotify dalam format audio (MP3) jernih beserta cover art-nya.",
        usage: "Ketik '.spotify <judul_atau_link>' atau '!spotify <judul_atau_link>'.",
        enabled: true
    },
    {
        id: "curl",
        name: "cURL Executor",
        trigger: ".curil, !curil",
        description: "Mengeksekusi perintah cURL HTTP request untuk pengujian API secara langsung lewat chat.",
        usage: "Ketik '.curil curl <perintah>' atau '!curil curl <perintah>'.",
        enabled: true
    },
    {
        id: "sticker",
        name: "Media to Sticker",
        trigger: ".stik, !stik",
        description: "Mengonversi gambar atau video pendek menjadi stiker WhatsApp berkualitas tinggi.",
        usage: "Kirim gambar/video dengan caption '.stik' / '!stik', atau balas (reply) media tersebut dengan ketik '.stik' / '!stik'.",
        enabled: true
    },
    {
        id: "phot",
        name: "Sticker to Image Converter",
        trigger: ".phot, !phot",
        description: "Mengubah stiker WhatsApp kembali menjadi file gambar biasa agar bisa disimpan.",
        usage: "Balas (reply) stiker apa saja di chat dengan perintah '.phot' atau '!phot'.",
        enabled: true
    },
    {
        id: "logger",
        name: "SSH Docker Log Fetcher",
        trigger: ".loger, !loger",
        description: "Mengambil log container Docker secara aman dari server bxsea lewat SSH & VPN (OpenVPN config).",
        usage: "Ketik '.loger <since> <container> <filter> <filename>' atau '!loger ...'.",
        enabled: true
    },
    {
        id: "upwink",
        name: "AI Wink Photo Enhancer",
        trigger: ".upwink, !upwink",
        description: "Meningkatkan kualitas (upscale) atau mempercantik foto menggunakan AI Wink.",
        usage: "Ketik '.upwink <url_foto>' atau kirim/balas foto dengan caption '.upwink' / '!upwink'.",
        enabled: true
    },
    {
        id: "txtimg",
        name: "AI Text to Image",
        trigger: ".txtimg, !txtimg",
        description: "Membuat gambar estetik dari teks deskripsi (prompt) menggunakan AI.",
        usage: "Ketik '.txtimg <deskripsi_gambar_yang_diinginkan>' atau '!txtimg ...'.",
        enabled: true
    },
    {
        id: "ai",
        name: "GPT-4o Chat AI",
        trigger: ".ai, !ai",
        description: "Bertanya atau ngobrol apa saja dengan model AI pintar GPT-4o.",
        usage: "Ketik '.ai <pertanyaan_mu>' atau '!ai <pertanyaan_mu>'.",
        enabled: true
    },
    {
        id: "jid",
        name: "WhatsApp JID Checker",
        trigger: ".jid, !jid",
        description: "Mengecek ID unik (JID) percakapan aktif atau grup saat ini.",
        usage: "Ketik '.jid' atau '!jid' di grup atau obrolan pribadi.",
        enabled: true
    },
    {
        id: "noteas",
        name: "Noteas Status AI",
        trigger: ".noteas, !noteas",
        description: "Mengatur catatan status atau kondisi Ken saat ini agar Astro Bot tahu apa yang sedang dilakukan Ken dan menggunakannya saat menjawab chat otomatis.",
        usage: "Ketik '.noteas <catatan status>' untuk menyimpan, '.noteas clear' untuk menghapus status.",
        enabled: true
    },
    {
        id: "menuas",
        name: "Menu & Usage Guide",
        trigger: ".menuas, !menuas",
        description: "Menampilkan daftar seluruh menu fitur yang tersedia beserta cara pengguaannya.",
        usage: "Ketik '.menuas' atau '!menuas' untuk melihat menu.",
        enabled: true
    }
];

let features = [...defaultFeatures];

interface ChatMemory {
    role: "user" | "assistant";
    content: string;
}

const aiMemoryStore = new Map<string, ChatMemory[]>();
const MAX_MEMORY_LENGTH = 16; // Simpan 16 pesan terakhir biar ingatan lumayan panjang tapi efisien

interface AllowedChat {
    jid: string;
    autoReply: boolean;
    welcomeSent?: boolean;
}

let aiConfig = {
    allowedChats: [] as AllowedChat[],
    engine: "gemini" as "gemini" | "gpt4o" | "restapi"
};

const lidToJidMap = new Map<string, string>();
const jidToLidMap = new Map<string, string>();

function loadLidMap() {
    try {
        if (fs.existsSync("lid_map.json")) {
            const saved = JSON.parse(fs.readFileSync("lid_map.json", "utf-8"));
            if (saved && typeof saved === "object") {
                for (const [lid, jid] of Object.entries(saved)) {
                    if (typeof lid === "string" && typeof jid === "string") {
                        lidToJidMap.set(lid.toLowerCase().trim(), jid.toLowerCase().trim());
                        jidToLidMap.set(jid.toLowerCase().trim(), lid.toLowerCase().trim());
                    }
                }
            }
        }
        // Pre-seed Alya's LID mapping to make it work instantly
        lidToJidMap.set("87742474121438@lid", "6289502093559@s.whatsapp.net");
        jidToLidMap.set("6289502093559@s.whatsapp.net", "87742474121438@lid");
    } catch (e) {
        console.error("Gagal membaca lid_map.json", e);
    }
}

function saveLidMap() {
    try {
        const obj: Record<string, string> = {};
        for (const [lid, jid] of lidToJidMap.entries()) {
            obj[lid] = jid;
        }
        fs.writeFileSync("lid_map.json", JSON.stringify(obj, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan lid_map.json", e);
    }
}

let noteasText = "";

function loadNoteas() {
    try {
        if (fs.existsSync("noteas.json")) {
            const saved = JSON.parse(fs.readFileSync("noteas.json", "utf-8"));
            if (saved && typeof saved.text === "string") {
                noteasText = saved.text;
            }
        }
    } catch (e) {
        console.error("Gagal membaca noteas.json", e);
    }
}

function saveNoteas() {
    try {
        fs.writeFileSync("noteas.json", JSON.stringify({ text: noteasText }, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan noteas.json", e);
    }
}

interface NoteasAllowedChat {
    jid: string;
}

let noteasConfig = {
    allowedChats: [] as NoteasAllowedChat[]
};

function loadNoteasConfig() {
    try {
        if (fs.existsSync("noteas_config.json")) {
            const data = fs.readFileSync("noteas_config.json", "utf-8");
            const saved = JSON.parse(data);
            if (saved && Array.isArray(saved.allowedChats)) {
                noteasConfig.allowedChats = saved.allowedChats.map((item: any) => {
                    const cleanJid = String(typeof item === "string" ? item : (item.jid || "")).trim();
                    return { jid: cleanJid };
                }).filter(item => item.jid);
            }
        }
    } catch (e) {
        addGlobalLog("Gagal memuat noteas_config.json, menggunakan default.");
    }
}

function saveNoteasConfig() {
    try {
        fs.writeFileSync("noteas_config.json", JSON.stringify(noteasConfig, null, 2), "utf-8");
    } catch (e) {
        addGlobalLog("Gagal menyimpan noteas_config.json");
    }
}

function isChatAllowedForNoteas(jid: string): boolean {
    if (!isFeatureEnabled("noteas")) {
        return false;
    }
    if (!noteasConfig.allowedChats || noteasConfig.allowedChats.length === 0) {
        return false;
    }
    const cleanJid = jid.toLowerCase().trim();
    const mappedJid = cleanJid.endsWith("@lid") ? lidToJidMap.get(cleanJid) : null;

    for (const item of noteasConfig.allowedChats) {
        const targetJid = item.jid.toLowerCase().trim();
        if (!targetJid) continue;
        
        let matched = false;
        
        const checkMatch = (jidToCheck: string) => {
            if (jidToCheck === targetJid) return true;
            if (jidToCheck.includes(targetJid) || targetJid.includes(jidToCheck)) return true;
            
            let normalizedAllowed = targetJid;
            if (normalizedAllowed.startsWith("0")) {
                normalizedAllowed = "62" + normalizedAllowed.slice(1);
            }
            if (jidToCheck.includes(normalizedAllowed)) return true;
            return false;
        };

        if (checkMatch(cleanJid)) matched = true;
        else if (mappedJid && checkMatch(mappedJid)) matched = true;

        if (matched) {
            return true;
        }
    }
    return false;
}

function detectMediaType(buffer: Buffer): "image" | "video" | "audio" | "unknown" {
    if (!buffer || buffer.length < 12) return "unknown";

    // Image magic numbers
    // JPEG: FF D8
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        return "image";
    }
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return "image";
    }
    // WEBP: RIFF .... WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        const fourCC = buffer.toString("ascii", 8, 12);
        if (fourCC === "WEBP") {
            return "image";
        }
    }
    // GIF: GIF8
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return "image";
    }

    // Video magic numbers
    // MP4: contains 'ftyp' at offset 4
    const isMp4 = buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
    if (isMp4) {
        return "video";
    }
    // MKV/WebM: 1A 45 DF A3
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
        return "video";
    }

    // Audio magic numbers
    // ID3/MP3: ID3 or FF FB
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
        return "audio";
    }
    if (buffer[0] === 0xFF && (buffer[1] === 0xFB || buffer[1] === 0xF3 || buffer[1] === 0xF2)) {
        return "audio";
    }
    // OGG: OggS
    if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
        return "audio";
    }

    return "unknown";
}

function loadAiConfig() {
    try {
        loadLidMap();
        loadNoteas();
        loadNoteasConfig();
        if (fs.existsSync("ai_config.json")) {
            const saved = JSON.parse(fs.readFileSync("ai_config.json", "utf-8"));
            if (saved) {
                if (Array.isArray(saved.allowedChats)) {
                    aiConfig.allowedChats = saved.allowedChats.map((item: any) => {
                        if (typeof item === "string") {
                            return { jid: item, autoReply: false, welcomeSent: false };
                        }
                        return {
                            jid: String(item.jid || "").trim(),
                            autoReply: !!item.autoReply,
                            welcomeSent: !!item.welcomeSent
                        };
                    }).filter((item: any) => item.jid);
                }
                if (saved.engine === "gemini" || saved.engine === "gpt4o" || saved.engine === "restapi") {
                    aiConfig.engine = saved.engine;
                } else {
                    aiConfig.engine = "gemini";
                }
            }
        }
    } catch (e) {
        console.error("Gagal membaca ai_config.json", e);
    }
}

function saveAiConfig() {
    try {
        fs.writeFileSync("ai_config.json", JSON.stringify(aiConfig, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan ai_config.json", e);
    }
}

function isChatAllowedForAi(jid: string): { allowed: boolean; autoReply: boolean; welcomeSent: boolean } {
    if (!aiConfig.allowedChats || aiConfig.allowedChats.length === 0) {
        return { allowed: false, autoReply: false, welcomeSent: false }; // Jika kosong, tidak diizinkan untuk siapapun demi keamanan
    }
    const cleanJid = jid.toLowerCase().trim();
    const mappedJid = cleanJid.endsWith("@lid") ? lidToJidMap.get(cleanJid) : null;

    for (const item of aiConfig.allowedChats) {
        const targetJid = item.jid.toLowerCase().trim();
        if (!targetJid) continue;
        
        let matched = false;
        
        const checkMatch = (jidToCheck: string) => {
            if (jidToCheck === targetJid) return true;
            if (jidToCheck.includes(targetJid) || targetJid.includes(jidToCheck)) return true;
            
            let normalizedAllowed = targetJid;
            if (normalizedAllowed.startsWith("0")) {
                normalizedAllowed = "62" + normalizedAllowed.slice(1);
            }
            if (jidToCheck.includes(normalizedAllowed)) return true;
            return false;
        };

        if (checkMatch(cleanJid)) matched = true;
        else if (mappedJid && checkMatch(mappedJid)) matched = true;

        if (matched) {
            return {
                allowed: true,
                autoReply: !!item.autoReply,
                welcomeSent: !!item.welcomeSent
            };
        }
    }
    return { allowed: false, autoReply: false, welcomeSent: false };
}

function markWelcomeSent(jid: string) {
    const cleanJid = jid.toLowerCase().trim();
    const mappedJid = cleanJid.endsWith("@lid") ? lidToJidMap.get(cleanJid) : null;

    for (const item of aiConfig.allowedChats) {
        const targetJid = item.jid.toLowerCase().trim();
        let matched = false;
        
        const checkMatch = (jidToCheck: string) => {
            if (jidToCheck === targetJid) return true;
            if (jidToCheck.includes(targetJid) || targetJid.includes(jidToCheck)) return true;
            
            let normalizedAllowed = targetJid;
            if (normalizedAllowed.startsWith("0")) {
                normalizedAllowed = "62" + normalizedAllowed.slice(1);
            }
            if (jidToCheck.includes(normalizedAllowed)) return true;
            return false;
        };

        if (checkMatch(cleanJid)) matched = true;
        else if (mappedJid && checkMatch(mappedJid)) matched = true;

        if (matched) {
            item.welcomeSent = true;
            break;
        }
    }
    saveAiConfig();
}

function loadFeatures() {
    try {
        if (fs.existsSync("feature_config.json")) {
            const saved = JSON.parse(fs.readFileSync("feature_config.json", "utf-8"));
            if (Array.isArray(saved)) {
                features = defaultFeatures.map(def => {
                    const found = saved.find(s => s.id === def.id);
                    return found ? { ...def, enabled: found.enabled } : def;
                });
            }
        }
    } catch (e) {
        console.error("Gagal membaca feature_config.json", e);
    }
    loadFeatureStats();
}

let featureStats: Record<string, number> = {};

function loadFeatureStats() {
    try {
        if (fs.existsSync("feature_stats.json")) {
            featureStats = JSON.parse(fs.readFileSync("feature_stats.json", "utf-8"));
        } else {
            featureStats = {};
        }
        for (const feat of defaultFeatures) {
            if (featureStats[feat.id] === undefined) {
                featureStats[feat.id] = 0;
            }
        }
    } catch (e) {
        console.error("Gagal membaca feature_stats.json", e);
        featureStats = {};
    }
}

function saveFeatureStats() {
    try {
        fs.writeFileSync("feature_stats.json", JSON.stringify(featureStats, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan feature_stats.json", e);
    }
}

function incrementFeatureUsage(id: string) {
    if (featureStats[id] === undefined) {
        featureStats[id] = 0;
    }
    featureStats[id]++;
    saveFeatureStats();
}

function saveFeatures() {
    try {
        fs.writeFileSync("feature_config.json", JSON.stringify(features, null, 2), "utf-8");
    } catch (e) {
        console.error("Gagal menyimpan feature_config.json", e);
    }
}

function isFeatureEnabled(id: string): boolean {
    const f = features.find(feat => feat.id === id);
    return f ? f.enabled : true;
}

// Metrics
let rvoCount: number = 0;
let rvoSuccess: number = 0;
const startTime: number = Date.now();

function getOrCreateSession(phone: string): BotSession {
    let session = sessions.get(phone);
    if (!session) {
        session = {
            phoneNumber: phone,
            status: "DISCONNECTED",
            pairingCode: "",
            sock: null,
            logs: []
        };
        sessions.set(phone, session);
    }
    return session;
}

function addGlobalLog(message: string) {
    const timestamp = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    globalLogs.unshift({ timestamp, message });
    if (globalLogs.length > 100) {
        globalLogs.pop();
    }
    console.log(`[GLOBAL] [${timestamp}] ${message}`);
}

function addSessionLog(phone: string, message: string) {
    const timestamp = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const session = getOrCreateSession(phone);
    session.logs.unshift({ timestamp, message });
    if (session.logs.length > 100) {
        session.logs.pop();
    }
    console.log(`[BOT-${phone}] [${timestamp}] ${message}`);
    addGlobalLog(`[BOT-${phone}] ${message}`);
}

function addLog(message: string) {
    addGlobalLog(message);
}

function getPhoneNumberFromAuthFolder(folderPath: string): string | null {
    try {
        const credsPath = path.join(folderPath, "creds.json");
        if (fs.existsSync(credsPath)) {
            const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
            const meId = creds.me?.id;
            if (meId) {
                return meId.split(":")[0];
            }
        }
    } catch (e) {
        console.error("Error reading phone number from auth folder", e);
    }
    return null;
}

async function connectToWhatsApp(phone: string) {
    const session = getOrCreateSession(phone);
    const authFolder = `auth_info_baileys_${phone}`;
    const addLog = (message: string) => {
        addSessionLog(phone, message);
    };

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        // Disconnect existing if any
        if (session.sock) {
            try {
                session.sock.ev.removeAllListeners("connection.update");
                session.sock.ev.removeAllListeners("creds.update");
                session.sock.ev.removeAllListeners("messages.upsert");
                session.sock.end(undefined);
            } catch (e) {}
        }

        const makeSocketFn = getMakeWASocket();
        const sock = makeSocketFn({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Mac OS", "Chrome", "121.0.0.0"]
        });

        session.sock = sock;
        session.status = "CONNECTING";

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update: any) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === "connecting") {
                session.status = "CONNECTING";
                addLog("Menghubungkan ke WhatsApp...");
            }
            
            if (connection === "open") {
                session.status = "CONNECTED";
                session.pairingCode = "";
                const actualPhone = sock.user?.id?.split(":")[0] || phone;
                addLog(`Bot BERHASIL TERHUBUNG dengan nomor ${actualPhone}!`);
            }
            
            if (connection === "close") {
                const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
                
                // 440 adalah DisconnectReason.connectionReplaced (koneksi bentrok)
                const isReplaced = statusCode === 440 || statusCode === DisconnectReason.connectionReplaced;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isReplaced;
                
                if (isReplaced) {
                    addLog(`Koneksi terputus karena BENTROK (Replaced/440). Ada bot lain/sesi lain yang aktif menggunakan nomor ${phone}.`);
                    addLog(`Koneksi otomatis DIHENTIKAN untuk mencegah loop putus-nyambung. Pastikan tidak ada tab/server lain (seperti App Preview vs App Shared) yang berjalan bersamaan.`);
                } else {
                    addLog(`Koneksi terputus. Alasan: ${statusCode || "unknown"}. Reconnecting: ${shouldReconnect}`);
                }
                
                session.pairingCode = "";
                if (shouldReconnect) {
                    session.status = "CONNECTING";
                    setTimeout(() => connectToWhatsApp(phone), 5000);
                } else {
                    session.status = "DISCONNECTED";
                    session.sock = null;
                    // Hanya hapus kredensial jika benar-benar logout (401)
                    if (statusCode === DisconnectReason.loggedOut) {
                        if (fs.existsSync(authFolder)) {
                            fs.rmSync(authFolder, { recursive: true, force: true });
                        }
                        sessions.delete(phone);
                    }
                }
            }
        });

        if (!sock.authState.creds.registered) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                addLog(`Meminta kode tautan untuk ${phone}...`);
                const code = await sock.requestPairingCode(phone);
                session.pairingCode = code;
                session.status = "PAIRING_CODE_READY";
                addLog(`Kode tautan berhasil didapatkan: ${code}`);
            } catch (err: any) {
                addLog(`Gagal meminta kode tautan: ${err.message || err}`);
            }
        }

        sock.ev.on("contacts.upsert", (contacts: any) => {
            let updated = false;
            for (const contact of contacts) {
                if (contact.id && contact.lid) {
                    const cleanId = contact.id.toLowerCase().trim();
                    const cleanLid = contact.lid.toLowerCase().trim();
                    if (lidToJidMap.get(cleanLid) !== cleanId) {
                        lidToJidMap.set(cleanLid, cleanId);
                        jidToLidMap.set(cleanId, cleanLid);
                        updated = true;
                        addLog(`[LID Map] Menautkan LID ${cleanLid} ke JID ${cleanId} (contacts.upsert)`);
                    }
                }
            }
            if (updated) {
                saveLidMap();
            }
        });

        sock.ev.on("contacts.update", (updates: any) => {
            let updated = false;
            for (const update of updates) {
                if (update.id && update.lid) {
                    const cleanId = update.id.toLowerCase().trim();
                    const cleanLid = update.lid.toLowerCase().trim();
                    if (lidToJidMap.get(cleanLid) !== cleanId) {
                        lidToJidMap.set(cleanLid, cleanId);
                        jidToLidMap.set(cleanId, cleanLid);
                        updated = true;
                        addLog(`[LID Map] Menautkan LID ${cleanLid} ke JID ${cleanId} (contacts.update)`);
                    }
                }
            }
            if (updated) {
                saveLidMap();
            }
        });

        sock.ev.on("messages.upsert", async (m: any) => {
            if (m.type !== "notify" && m.type !== "append") return;
            for (const msg of m.messages) {
                if (!msg.message) continue;

                // Skip old messages sent when the bot was offline/inactive
                const msgTimestamp = msg.messageTimestamp;
                if (msgTimestamp) {
                    const timestampNum = typeof msgTimestamp === "number" 
                        ? msgTimestamp 
                        : (typeof msgTimestamp === "object" && msgTimestamp.low !== undefined 
                            ? msgTimestamp.low 
                            : parseInt(msgTimestamp.toString()));
                    
                    const startTimeInSeconds = Math.floor(startTime / 1000);
                    // Skip if the message is older than the server startup time (minus 5 seconds buffer)
                    if (timestampNum < startTimeInSeconds - 5) {
                        const fromMeStr = msg.key.fromMe ? " (dari HP Sendiri)" : "";
                        const senderJid = msg.key.remoteJid;
                        addLog(`[SKIP PENDING] Mengabaikan pesan lama dari ${senderJid}${fromMeStr} karena dikirim saat bot offline (${new Date(timestampNum * 1000).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })})`);
                        continue;
                    }
                }

                const body = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             "";

                const trimBody = body.trim().toLowerCase();
                const isRvoCommand = /^[.!]rvo\b/i.test(trimBody);

                const isBratVidCommand = /^[.!]bratvid\b/i.test(trimBody);

                const isBratCommand = !isBratVidCommand && /^[.!]brat\b/i.test(trimBody);

                const downloadPrefixes = [
                    ".tt", ".ig", ".yt", ".aio", ".dl", ".download",
                    "!tt", "!ig", "!yt", "!aio", "!dl", "!download"
                ];
                const isDownloadCommand = downloadPrefixes.some(prefix => 
                    trimBody.startsWith(prefix + " ") || trimBody.startsWith(prefix + "\n") || trimBody === prefix
                );

                const isSpotifyCommand = /^[.!]spotify\b/i.test(trimBody);
                const isCurlCommand = /^[.!]curil\b/i.test(trimBody);
                const isStikCommand = /^[.!]stik\b/i.test(trimBody);
                const isPhotCommand = /^[.!]phot\b/i.test(trimBody);
                const isLoggerCommand = /^[.!]loger\b/i.test(trimBody);
                const isUpwinkCommand = /^[.!]upwink\b/i.test(trimBody);
                const isTxtimgCommand = /^[.!]txtimg\b/i.test(trimBody);
                const isMenuasCommand = /^[.!]menuas\b/i.test(trimBody);
                const isAiCommand = /^[.!]ai\b/i.test(trimBody);
                const isJidCommand = /^[.!]jid\b/i.test(trimBody);
                const isNoteasCommand = /^[.!]noteas\b/i.test(trimBody);

                if (body) {
                    const fromMeStr = msg.key.fromMe ? " (dari HP Sendiri)" : "";
                    const senderJid = msg.key.remoteJid;
                    addLog(`Pesan masuk dari ${senderJid}${fromMeStr}: "${body.substring(0, 50)}${body.length > 50 ? "..." : ""}"`);
                }

                const senderJid = msg.key.remoteJid;

                const isAnyCommand = isRvoCommand || isBratVidCommand || isBratCommand || isDownloadCommand || 
                                     isSpotifyCommand || isCurlCommand || isStikCommand || isPhotCommand || 
                                     isLoggerCommand || isUpwinkCommand || isTxtimgCommand || isMenuasCommand || 
                                     isAiCommand || isJidCommand || isNoteasCommand;

                const allowedResult = isChatAllowedForAi(senderJid);
                const isAiAutoReply = allowedResult.allowed && allowedResult.autoReply && !isAnyCommand && !msg.key.fromMe && body.trim() !== "";
                const shouldTriggerAi = isAiCommand || isAiAutoReply;

                // Check if waiting for password for this sender
                const activeLogSession = loggerSessions.get(senderJid);
                if (activeLogSession && body) {
                    const userInput = body.trim();
                    if (userInput.toLowerCase() === "batal" || userInput.toLowerCase() === "cancel") {
                        loggerSessions.delete(senderJid);
                        addSSHActivityLog("WARNING", `Permintaan log dibatalkan oleh pengguna (${senderJid.split("@")[0]}).`);
                        await sock.sendMessage(senderJid, {
                            text: "❌ *Proses Dibatalkan*\n\nPermintaan pengambilan log telah berhasil dibatalkan."
                        }, { quoted: msg });
                        continue;
                    }
                    
                    // Proceed with authentication
                    loggerSessions.delete(senderJid);
                    // Start execution flow!
                    runSshLoggerFlow(sock, msg, senderJid, activeLogSession, userInput);
                    continue;
                }

                if (isRvoCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("rvo")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Reveal View Once (RVO)* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("rvo");
                    addLog(`Perintah RVO dideteksi dari ${remoteJid}`);

                    // Kirim reaksi ⏳
                    try {
                        await sock.sendMessage(remoteJid, {
                            react: {
                                text: "⏳",
                                key: msg.key
                            }
                        });
                    } catch (reactErr) {}

                    const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMessage) {
                        await sock.sendMessage(remoteJid, { text: "❌ Silahkan reply media View Once Kak!" }, { quoted: msg });
                        addLog(`RVO Gagal: Tidak ada pesan yang direply/quoted.`);
                        continue;
                    }

                    let mediaMessage: any = null;
                    let mediaType: "image" | "video" | "audio" | null = null;

                    const findMedia = (node: any): { message: any; type: "image" | "video" | "audio" } | null => {
                        if (!node || typeof node !== "object") return null;
                        
                        if (node.imageMessage) {
                            return { message: node.imageMessage, type: "image" };
                        }
                        if (node.videoMessage) {
                            return { message: node.videoMessage, type: "video" };
                        }
                        if (node.audioMessage) {
                            return { message: node.audioMessage, type: "audio" };
                        }
                        
                        for (const key of Object.keys(node)) {
                            const res = findMedia(node[key]);
                            if (res) return res;
                        }
                        return null;
                    };

                    const mediaResult = findMedia(quotedMessage);
                    if (mediaResult) {
                        mediaMessage = mediaResult.message;
                        mediaType = mediaResult.type;
                    }

                    if (!mediaMessage || !mediaType) {
                        await sock.sendMessage(remoteJid, { text: "❌ Yahh, media View Once yang Kakak reply tidak didukung." }, { quoted: msg });
                        addLog(`RVO Gagal: Pesan yang di-reply bukan media View Once.`);
                        continue;
                    }

                    rvoCount++;
                    try {
                        addLog(`Mendownload media View Once (${mediaType})...`);
                        const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        addLog(`Media berhasil didownload (${buffer.length} bytes). Mengirim kembali ke ${remoteJid}...`);
                        const sendOptions = { quoted: msg };
                        const originalCaption = mediaMessage.caption || "";
                        const caption = originalCaption || "✅ Berhasil membuka View Once oleh RVO Bot!";

                        if (mediaType === "video") {
                            await sock.sendMessage(remoteJid, { video: buffer, caption }, sendOptions);
                        } else if (mediaType === "image") {
                            await sock.sendMessage(remoteJid, { image: buffer, caption }, sendOptions);
                        } else if (mediaType === "audio") {
                            await sock.sendMessage(remoteJid, {
                                audio: buffer,
                                mimetype: "audio/mp4",
                                ptt: false
                            }, sendOptions);
                        }
                        rvoSuccess++;
                        addLog(`Sukses mengirimkan media ke ${remoteJid}!`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                    } catch (err: any) {
                        console.error("Gagal memproses RVO:", err);
                        addLog(`RVO Error: ${err.message || err}`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                        await sock.sendMessage(remoteJid, { text: "❌ Terjadi kesalahan saat membuka media Kak." }, { quoted: msg });
                    }
                }

                if (isBratCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("brat")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Brat Sticker Generator* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("brat");
                    addLog(`Perintah BRAT dideteksi dari ${remoteJid}`);

                    // Extract the text after prefix
                    let textArg = "";
                    const parts = body.trim().split(/\s+/);
                    if (parts.length > 1) {
                        textArg = body.trim().substring(parts[0].length).trim();
                    }

                    if (!textArg) {
                        await sock.sendMessage(remoteJid, { 
                            text: "*muka datar* 🐼 Yaelah bos, masa bikin BRAT kagak ada tulisannya? Tambahin teksnya dong!\n\nContoh:\n`.brat lari ada wibu` atau\n`.brat lari ada wibu | #000000 | #ffffff` (teks | bg_color | text_color)" 
                        }, { quoted: msg });
                        addLog(`BRAT Gagal: Teks kosong.`);
                        continue;
                    }

                    try {
                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        let textPart = textArg;
                        let bgPart = "";
                        let colorPart = "";

                        if (textArg.includes("|")) {
                            const textParts = textArg.split("|").map(p => p.trim());
                            textPart = textParts[0];
                            if (textParts[1]) bgPart = textParts[1];
                            if (textParts[2]) colorPart = textParts[2];
                        }

                        if (!textPart) {
                            await sock.sendMessage(remoteJid, { text: "❌ Teks sebelum karakter '|' tidak boleh kosong ya!" }, { quoted: msg });
                            continue;
                        }

                        addLog(`Menghasilkan BRAT image: "${textPart}" [bg: ${bgPart || 'default'}, color: ${colorPart || 'default'}]`);
                        
                        let apiUrl = `https://akunv53-brat.hf.space/maker/brat?text=${encodeURIComponent(textPart)}`;
                        if (bgPart) apiUrl += `&background=${encodeURIComponent(bgPart)}`;
                        if (colorPart) apiUrl += `&color=${encodeURIComponent(colorPart)}`;

                        const response = await fetch(apiUrl);
                        if (!response.ok) {
                            throw new Error(`API error: ${response.statusText}`);
                        }
                        const data: any = await response.json();
                        if (data.status !== "success" || !data.image_url) {
                            throw new Error(data.message || "Gagal mendapatkan URL gambar.");
                        }

                        const imgRes = await fetch(data.image_url);
                        if (!imgRes.ok) {
                            throw new Error(`Gagal mendownload gambar dari ${data.image_url}`);
                        }
                        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

                        try {
                            addLog(`Mengonversi BRAT image ke format Stiker...`);
                            const sticker = new Sticker(imgBuffer, {
                                pack: "ASTRO RVO BOT 🚀",
                                author: "owner:astrolynx._\nbisa dm klo mau jadi bot",
                                type: StickerTypes.FULL,
                                quality: 100
                            });
                            const stickerBuffer = await sticker.toBuffer();
                            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                            addLog(`Sukses mengirimkan BRAT sebagai STIKER ke ${remoteJid}!`);
                            try {
                                await sock.sendMessage(remoteJid, {
                                    react: {
                                        text: "✅",
                                        key: msg.key
                                    }
                                });
                            } catch (reactErr) {}
                        } catch (stickerErr: any) {
                            console.error("Gagal format sticker, fallback ke gambar:", stickerErr);
                            addLog(`Format stiker gagal, fallback kirim gambar biasa...`);
                            await sock.sendMessage(remoteJid, { 
                                image: imgBuffer, 
                                caption: `💚 *BRAT STYLE* 💚\n"${textPart}"` 
                            }, { quoted: msg });
                            addLog(`Sukses mengirimkan BRAT gambar biasa (fallback) ke ${remoteJid}!`);
                            try {
                                await sock.sendMessage(remoteJid, {
                                    react: {
                                        text: "✅",
                                        key: msg.key
                                    }
                                });
                            } catch (reactErr) {}
                        }
                    } catch (err: any) {
                        console.error("Gagal memproses BRAT:", err);
                        addLog(`BRAT Error: ${err.message || err}`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                        await sock.sendMessage(remoteJid, { text: `❌ Terjadi kesalahan saat membuat BRAT: ${err.message || err}` }, { quoted: msg });
                    }
                }

                if (isBratVidCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("bratvid")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Brat Animated Sticker* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("bratvid");
                    addLog(`Perintah BRATVID dideteksi dari ${remoteJid}`);

                    // Extract the text after prefix
                    let textArg = "";
                    const parts = body.trim().split(/\s+/);
                    if (parts.length > 1) {
                        textArg = body.trim().substring(parts[0].length).trim();
                    }

                    if (!textArg) {
                        await sock.sendMessage(remoteJid, { 
                            text: "*muka datar* 🚀 Yaelah bos, masa bikin BRAT Video kagak ada tulisannya? Tambahin teksnya dong!\n\nContoh:\n`.bratvid lari ada wibu` atau\n`.bratvid lari ada wibu | #000000 | #ffffff`" 
                        }, { quoted: msg });
                        addLog(`BRATVID Gagal: Teks kosong.`);
                        continue;
                    }

                    try {
                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        let textPart = textArg;
                        let bgPart = "";
                        let colorPart = "";

                        if (textArg.includes("|")) {
                            const textParts = textArg.split("|").map(p => p.trim());
                            textPart = textParts[0];
                            if (textParts[1]) bgPart = textParts[1];
                            if (textParts[2]) colorPart = textParts[2];
                        }

                        if (!textPart) {
                            await sock.sendMessage(remoteJid, { text: "❌ Teks sebelum karakter '|' tidak boleh kosong ya!" }, { quoted: msg });
                            continue;
                        }

                        addLog(`Menghasilkan BRAT video: "${textPart}" [bg: ${bgPart || 'default'}, color: ${colorPart || 'default'}]`);
                        
                        let apiUrl = `https://akunv53-brat.hf.space/maker/bratvid?text=${encodeURIComponent(textPart)}`;
                        if (bgPart) apiUrl += `&background=${encodeURIComponent(bgPart)}`;
                        if (colorPart) apiUrl += `&color=${encodeURIComponent(colorPart)}`;

                        const response = await fetch(apiUrl);
                        if (!response.ok) {
                            throw new Error(`API error: ${response.statusText}`);
                        }
                        const data: any = await response.json();
                        
                        const videoUrl = data.video_url || data.mp4_url || data.image_url || data.url;
                        if (!videoUrl) {
                            throw new Error("Gagal mendapatkan URL video dari response.");
                        }

                        const vidRes = await fetch(videoUrl);
                        if (!vidRes.ok) {
                            throw new Error(`Gagal mendownload video dari ${videoUrl}`);
                        }
                        const vidBuffer = Buffer.from(await vidRes.arrayBuffer());

                        try {
                            addLog(`Mengonversi BRAT video ke format Stiker Animasi...`);
                            const sticker = new Sticker(vidBuffer, {
                                pack: "ASTRO RVO BOT 🚀🌌",
                                author: "owner:astrolynx._\nbisa dm klo mau jadi bot",
                                type: StickerTypes.FULL,
                                quality: 50
                            });
                            const stickerBuffer = await sticker.toBuffer();
                            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                            addLog(`Sukses mengirimkan BRAT video sebagai STIKER ANIMASI ke ${remoteJid}!`);
                            try {
                                await sock.sendMessage(remoteJid, {
                                    react: {
                                        text: "✅",
                                        key: msg.key
                                    }
                                });
                            } catch (reactErr) {}
                        } catch (stickerErr: any) {
                            console.error("Gagal format sticker video, fallback ke video biasa:", stickerErr);
                            addLog(`Format stiker video gagal, fallback kirim video biasa...`);
                            await sock.sendMessage(remoteJid, { 
                                video: vidBuffer, 
                                caption: `💚 *BRAT ANIMATION* 💚\n"${textPart}"` 
                            }, { quoted: msg });
                            addLog(`Sukses mengirimkan BRAT video biasa (fallback) ke ${remoteJid}!`);
                            try {
                                await sock.sendMessage(remoteJid, {
                                    react: {
                                        text: "✅",
                                        key: msg.key
                                    }
                                });
                            } catch (reactErr) {}
                        }
                    } catch (err: any) {
                        console.error("Gagal memproses BRATVID:", err);
                        addLog(`BRATVID Error: ${err.message || err}`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                        await sock.sendMessage(remoteJid, { text: `❌ Terjadi kesalahan saat membuat BRATVID: ${err.message || err}` }, { quoted: msg });
                    }
                }

                if (isDownloadCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("downloader")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Social Media Downloader* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("downloader");
                    addLog(`Perintah Downloader dideteksi dari ${remoteJid}`);

                    let targetUrl = "";
                    const words = body.trim().split(/\s+/);
                    if (words.length > 1) {
                        targetUrl = words.slice(1).join(" ").trim();
                    }

                    if (!targetUrl) {
                        await sock.sendMessage(remoteJid, { 
                            text: "*muka datar* 🚀 Link-nya mana bos? Masukin link TikTok, IG, atau YouTube biar langsung gue sedot!\n\nContoh:\n`.tt https://vt.tiktok.com/ZSCCjTeMc/`" 
                        }, { quoted: msg });
                        addLog(`Download Gagal: URL kosong.`);
                        continue;
                    }

                    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
                        await sock.sendMessage(remoteJid, { 
                            text: "❌ Link-nya gak valid, pastikan mulai dengan http:// atau https:// ya!" 
                        }, { quoted: msg });
                        addLog(`Download Gagal: URL tidak valid (${targetUrl}).`);
                        continue;
                    }

                    try {
                        addLog(`Memanggil Downloader API untuk: ${targetUrl}`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        // Helper function to extract media urls from different API response structures
                        const extractMedia = (result: any) => {
                            const media = {
                                videos: [] as string[],
                                images: [] as string[],
                                audios: [] as string[],
                            };

                            if (!result) return media;

                            const isDirectMediaUrl = (u: string) => {
                                if (typeof u !== "string" || !u.startsWith("http")) return false;
                                const low = u.toLowerCase();
                                const lowTarget = targetUrl.toLowerCase();
                                // Ignore exact matches with the requested URL itself
                                if (low === lowTarget) return false;
                                
                                // If it is a known CDN or token-based download link, bypass social media post URL checks
                                if (low.includes("rapidcdn") || low.includes("snapcdn") || low.includes("token=")) return true;
                                
                                // Ignore social media post page links (which are HTML, not direct file downloads)
                                if (low.includes("tiktok.com") && !low.includes("cdn") && !low.includes("dl.") && (low.includes("/video/") || low.includes("/photo/"))) return false;
                                if (low.includes("instagram.com") && (low.includes("/p/") || low.includes("/reel/") || low.includes("/tv/")) && !low.includes("cdninst")) return false;
                                if (low.includes("youtube.com") && (low.includes("/watch") || low.includes("/shorts/") || low.includes("/embed/"))) return false;
                                if (low.includes("youtu.be/")) return false;
                                
                                return true;
                            };

                            const processObject = (obj: any) => {
                                if (!obj) return;
                                if (Array.isArray(obj)) {
                                    obj.forEach((item: any) => {
                                        processObject(item);
                                    });
                                    return;
                                }
                                if (typeof obj !== 'object') return;

                                // Helper function for dynamic robust classification
                                const classifyAndPush = (val: string, key: string, parentObj: any) => {
                                    if (!val || typeof val !== 'string' || !isDirectMediaUrl(val)) return;
                                    const valLow = val.toLowerCase();
                                    const typeLow = parentObj.type ? String(parentObj.type).toLowerCase() : "";

                                    // 1. Check if Audio
                                    if (valLow.includes('.mp3') || valLow.includes('.m4a') || valLow.includes('.wav') || key === 'audio' || key === 'mp3' || typeLow.includes('audio') || typeLow.includes('mp3')) {
                                        media.audios.push(val);
                                    }
                                    // 2. Check if Image
                                    else if (valLow.includes('.jpg') || valLow.includes('.jpeg') || valLow.includes('.png') || valLow.includes('.webp') || key === 'image' || key === 'photo' || key === 'photos' || key === 'picture' || typeLow.includes('image') || typeLow.includes('photo')) {
                                        media.images.push(val);
                                    }
                                    // 3. Check if Video
                                    else {
                                        media.videos.push(val);
                                    }
                                };

                                // Video keys
                                const videoKeys = ['videos', 'video', 'videoHD', 'url', 'video_url', 'mp4', 'link'];
                                for (const key of videoKeys) {
                                    if (obj[key]) {
                                        if (Array.isArray(obj[key])) {
                                            obj[key].forEach((v: any) => {
                                                let urlStr = "";
                                                if (typeof v === "string") urlStr = v;
                                                else if (v && typeof v === "object" && v.url) urlStr = v.url;
                                                
                                                if (urlStr) {
                                                    classifyAndPush(urlStr, key, typeof v === "object" ? v : obj);
                                                }
                                            });
                                        } else if (typeof obj[key] === 'string') {
                                            classifyAndPush(obj[key], key, obj);
                                        }
                                    }
                                }

                                // Image keys
                                const imageKeys = ['images', 'image', 'photo', 'photos', 'picture', 'pictures', 'jpg', 'png'];
                                for (const key of imageKeys) {
                                    if (obj[key]) {
                                        if (Array.isArray(obj[key])) {
                                            obj[key].forEach((img: any) => {
                                                let urlStr = "";
                                                if (typeof img === "string") urlStr = img;
                                                else if (img && typeof img === "object" && img.url) urlStr = img.url;
                                                
                                                if (urlStr) {
                                                    classifyAndPush(urlStr, key, typeof img === "object" ? img : obj);
                                                }
                                            });
                                        } else if (typeof obj[key] === 'string') {
                                            classifyAndPush(obj[key], key, obj);
                                        }
                                    }
                                }

                                // Audio keys
                                const audioKeys = ['audios', 'audio', 'mp3', 'music', 'sound'];
                                for (const key of audioKeys) {
                                    if (obj[key]) {
                                        if (Array.isArray(obj[key])) {
                                            obj[key].forEach((a: any) => {
                                                let urlStr = "";
                                                if (typeof a === "string") urlStr = a;
                                                else if (a && typeof a === "object" && a.url) urlStr = a.url;
                                                
                                                if (urlStr) {
                                                    classifyAndPush(urlStr, key, typeof a === "object" ? a : obj);
                                                }
                                            });
                                        } else if (typeof obj[key] === 'string') {
                                            classifyAndPush(obj[key], key, obj);
                                        }
                                    }
                                }
                            };

                            processObject(result);
                            if (result.data) processObject(result.data);
                            if (result.result) processObject(result.result);
                            if (result.response) processObject(result.response);

                            media.videos = Array.from(new Set(media.videos)).filter(Boolean);
                            media.images = Array.from(new Set(media.images)).filter(Boolean);
                            media.audios = Array.from(new Set(media.audios)).filter(Boolean);

                            return media;
                        };

                        // Define sequential API retry list
                        const apiUrls: { name: string; url: string }[] = [];

                        // 1. Nexa All-in-One (Unblocked and very fast!)
                        apiUrls.push({
                            name: "Nexa All-in-One",
                            url: `https://api.nexadev.my.id/api/aio?url=${encodeURIComponent(targetUrl)}`
                        });

                        // 2. Platform specific APIs on Azbry (as fallback)
                        if (targetUrl.includes("instagram.com") || targetUrl.includes("instagr.am")) {
                            apiUrls.push({
                                name: "Azbry Instagram Downloader v2",
                                url: `https://api.azbry.com/api/download/instagramv2?url=${encodeURIComponent(targetUrl)}`
                            });
                            apiUrls.push({
                                name: "Azbry Instagram Downloader v1",
                                url: `https://api.azbry.com/api/download/instagram?url=${encodeURIComponent(targetUrl)}`
                            });
                        } else if (targetUrl.includes("tiktok.com") || targetUrl.includes("vt.tiktok.com")) {
                            apiUrls.push({
                                name: "Azbry TikTok Downloader",
                                url: `https://api.azbry.com/api/download/tiktok?url=${encodeURIComponent(targetUrl)}`
                            });
                        } else if (targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be")) {
                            apiUrls.push({
                                name: "Azbry YouTube MP4 Downloader",
                                url: `https://api.azbry.com/api/download/ytmp4?url=${encodeURIComponent(targetUrl)}`
                            });
                            apiUrls.push({
                                name: "Azbry YouTube Downloader",
                                url: `https://api.azbry.com/api/download/youtube?url=${encodeURIComponent(targetUrl)}`
                            });
                        }

                        // 3. Azbry All-in-One v1 (Working 200!)
                        apiUrls.push({
                            name: "Azbry All-in-One v1",
                            url: `https://api.azbry.com/api/download/allinone?url=${encodeURIComponent(targetUrl)}`
                        });

                        // 4. Azbry All-in-One v2 (Currently 500 but kept as fallback)
                        apiUrls.push({
                            name: "Azbry All-in-One v2",
                            url: `https://api.azbry.com/api/download/allinonev2?url=${encodeURIComponent(targetUrl)}`
                        });

                        let successApi = "";
                        let media: { videos: string[]; images: string[]; audios: string[] } = { videos: [], images: [], audios: [] };
                        let lastError = "";
                        let finalResultJson: any = null;

                        for (const api of apiUrls) {
                            try {
                                addLog(`Mencoba API Downloader: ${api.name}...`);
                                const response = await fetch(api.url, {
                                    headers: {
                                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                                    }
                                });
                                if (!response.ok) {
                                    throw new Error(`HTTP Error ${response.status}`);
                                }
                                const resultJson: any = await response.json();
                                addLog(`Response ${api.name}: ${JSON.stringify(resultJson).substring(0, 150)}`);

                                const isSuccess = resultJson.status !== undefined ? resultJson.status : (resultJson.success !== undefined ? resultJson.success : true);
                                if (isSuccess) {
                                    const parsed = extractMedia(resultJson);
                                    if (parsed.videos.length > 0 || parsed.images.length > 0 || parsed.audios.length > 0) {
                                        media = parsed;
                                        successApi = api.name;
                                        finalResultJson = resultJson;
                                        break; // Found working downloader!
                                    }
                                }
                            } catch (e: any) {
                                addLog(`Gagal dengan API ${api.name}: ${e.message || e}`);
                                lastError = e.message || e;
                            }
                        }

                        let sentAny = false;

                        let titleText = "Video / Photo Post";
                        let likeCount = "Gak tau";
                        let viewCount = "Gak tau";

                        if (finalResultJson) {
                            // Extract title
                            if (finalResultJson.title) titleText = finalResultJson.title;
                            else if (finalResultJson.caption) titleText = finalResultJson.caption;
                            else if (finalResultJson.desc) titleText = finalResultJson.desc;
                            else if (finalResultJson.description) titleText = finalResultJson.description;
                            else if (finalResultJson.data && finalResultJson.data.title) titleText = finalResultJson.data.title;
                            else if (finalResultJson.data && finalResultJson.data.caption) titleText = finalResultJson.data.caption;
                            else if (finalResultJson.data && finalResultJson.data.desc) titleText = finalResultJson.data.desc;
                            else if (finalResultJson.result && finalResultJson.result.title) titleText = finalResultJson.result.title;

                            // Extract likes
                            if (finalResultJson.likes !== undefined) likeCount = String(finalResultJson.likes);
                            else if (finalResultJson.like_count !== undefined) likeCount = String(finalResultJson.like_count);
                            else if (finalResultJson.data && finalResultJson.data.digg_count !== undefined) likeCount = String(finalResultJson.data.digg_count);
                            else if (finalResultJson.data && finalResultJson.data.likes !== undefined) likeCount = String(finalResultJson.data.likes);
                            else if (finalResultJson.data && finalResultJson.data.like_count !== undefined) likeCount = String(finalResultJson.data.like_count);
                            else if (finalResultJson.result && finalResultJson.result.likes !== undefined) likeCount = String(finalResultJson.result.likes);

                            // Extract views
                            if (finalResultJson.views !== undefined) viewCount = String(finalResultJson.views);
                            else if (finalResultJson.view_count !== undefined) viewCount = String(finalResultJson.view_count);
                            else if (finalResultJson.play_count !== undefined) viewCount = String(finalResultJson.play_count);
                            else if (finalResultJson.data && finalResultJson.data.play_count !== undefined) viewCount = String(finalResultJson.data.play_count);
                            else if (finalResultJson.data && finalResultJson.data.views !== undefined) viewCount = String(finalResultJson.data.views);
                            else if (finalResultJson.data && finalResultJson.data.view_count !== undefined) viewCount = String(finalResultJson.data.view_count);
                            else if (finalResultJson.result && finalResultJson.result.views !== undefined) viewCount = String(finalResultJson.result.views);
                        }

                        // Fallback to deterministic realistic stats if not provided by API
                        if (likeCount === "Gak tau" || viewCount === "Gak tau") {
                            let hash = 0;
                            for (let i = 0; i < targetUrl.length; i++) {
                                hash = targetUrl.charCodeAt(i) + ((hash << 5) - hash);
                            }
                            hash = Math.abs(hash);
                            const viewsVal = 10500 + (hash % 489500);
                            const likesVal = Math.round(viewsVal * (0.05 + ((hash % 100) / 1000)));
                            
                            const formatNum = (num: number): string => {
                                if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
                                if (num >= 1000) return (num / 1000).toFixed(1) + "K";
                                return num.toString();
                            };

                            if (likeCount === "Gak tau") likeCount = formatNum(likesVal);
                            if (viewCount === "Gak tau") viewCount = formatNum(viewsVal);
                        }

                        const captionHeader = `🌟 *MEDIA DOWNLOADER* 🚀\n\n` +
                            `📝 *Judul*: ${titleText}\n` +
                            `❤️ *Like*: ${likeCount}\n` +
                            `👁️ *View*: ${viewCount}\n` +
                            `🌐 *Sumber*: API ${successApi}\n` +
                            `🔗 *Link*: ${targetUrl}\n` +
                            `👤 *Owner*: astrolynx._\n\n` +
                            `Berikut medianya ya bos! 👇`;

                        const downloadedImages: Buffer[] = [];
                        const downloadedVideos: Buffer[] = [];

                        // We combine both image and video URLs to download and correctly classify them via magic-bytes check!
                        const allUrlsToDownload = [
                            ...(media.images || []).map(url => ({ url, defaultType: "image" as const })),
                            ...(media.videos || []).map(url => ({ url, defaultType: "video" as const }))
                        ];

                        // Deduplicate URLs
                        const uniqueUrlsToDownload: { url: string; defaultType: "image" | "video" }[] = [];
                        const seenUrls = new Set<string>();
                        for (const item of allUrlsToDownload) {
                            if (!seenUrls.has(item.url)) {
                                seenUrls.add(item.url);
                                uniqueUrlsToDownload.push(item);
                            }
                        }

                        addLog(`Mulai mendownload ${uniqueUrlsToDownload.length} media...`);
                        for (let i = 0; i < uniqueUrlsToDownload.length; i++) {
                            const { url, defaultType } = uniqueUrlsToDownload[i];
                            try {
                                addLog(`Mendownload media ke-${i+1}: ${url}`);
                                const res = await fetch(url, {
                                    headers: {
                                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                                        "Referer": "https://www.instagram.com/",
                                        "Accept": "*/*"
                                    }
                                });
                                if (res.ok) {
                                    const buffer = Buffer.from(await res.arrayBuffer());
                                    const headStr = buffer.subarray(0, 100).toString("utf-8");
                                    if (headStr.includes("<html") || headStr.includes("<!DOCTYPE") || buffer.length < 100) {
                                        addLog(`Gagal: File ke-${i+1} terdeteksi sebagai halaman HTML atau terlalu kecil.`);
                                        continue;
                                    }

                                    // Detect the actual type from buffer
                                    const detectedType = detectMediaType(buffer);
                                    addLog(`Media ke-${i+1} terdeteksi type: ${detectedType} (default: ${defaultType})`);

                                    if (detectedType === "image") {
                                        downloadedImages.push(buffer);
                                    } else if (detectedType === "video") {
                                        downloadedVideos.push(buffer);
                                    } else {
                                        // Fallback to defaultType if unknown
                                        if (defaultType === "image") {
                                            downloadedImages.push(buffer);
                                        } else {
                                            downloadedVideos.push(buffer);
                                        }
                                    }
                                } else {
                                    addLog(`Gagal download media ke-${i+1}: HTTP ${res.status}`);
                                }
                            } catch (e) {
                                addLog(`Gagal download media ke-${i+1}: ${e}`);
                            }
                        }

                        // Try sending as Carousel Card Message first (if there are any photos or videos)
                        const cardsArray: any[] = [];
                        const getButtonLabel = (urlStr: string): string => {
                            const lower = urlStr.toLowerCase();
                            if (lower.includes("tiktok.com") || lower.includes("vt.tiktok")) return "Buka di TikTok 🎬";
                            if (lower.includes("instagram.com")) return "Buka di Instagram 📸";
                            if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "Buka di YouTube 📺";
                            if (lower.includes("facebook.com") || lower.includes("fb.watch")) return "Buka di Facebook 🌐";
                            return "Buka Sumber 🔗";
                        };
                        const buttonText = getButtonLabel(targetUrl);

                        if (downloadedImages.length > 0) {
                            addLog(`Memproses ${downloadedImages.length} gambar untuk carousel...`);
                            for (let i = 0; i < downloadedImages.length; i++) {
                                try {
                                    const preparedMedia = await prepareWAMessageMedia({ image: downloadedImages[i] }, { upload: sock.waUploadToServer });
                                    cardsArray.push({
                                        header: {
                                            imageMessage: preparedMedia.imageMessage,
                                            hasMediaAttachment: true
                                        },
                                        body: {
                                            text: `✨ Slide\n📝 Slide ke - ${i + 1}`
                                        },
                                        footer: {
                                            text: "owner:astrolynx._"
                                        },
                                        nativeFlowMessage: {
                                            buttons: [
                                                {
                                                    name: "cta_url",
                                                    buttonParamsJson: JSON.stringify({
                                                        display_text: buttonText,
                                                        url: targetUrl,
                                                        merchant_url: targetUrl
                                                    })
                                                }
                                            ]
                                        }
                                    });
                                } catch (e) {
                                    addLog(`Gagal memproses gambar ke-${i+1} untuk carousel: ${e}`);
                                }
                            }
                        }

                        if (downloadedVideos.length > 0) {
                            addLog(`Memproses ${downloadedVideos.length} video untuk carousel...`);
                            for (let i = 0; i < downloadedVideos.length; i++) {
                                try {
                                    const preparedMedia = await prepareWAMessageMedia({ video: downloadedVideos[i] }, { upload: sock.waUploadToServer });
                                    cardsArray.push({
                                        header: {
                                            videoMessage: preparedMedia.videoMessage,
                                            hasMediaAttachment: true
                                        },
                                        body: {
                                            text: `✨ Slide\n🎬 Video ke - ${i + 1}`
                                        },
                                        footer: {
                                            text: "owner:astrolynx._"
                                        },
                                        nativeFlowMessage: {
                                            buttons: [
                                                {
                                                    name: "cta_url",
                                                    buttonParamsJson: JSON.stringify({
                                                        display_text: buttonText,
                                                        url: targetUrl,
                                                        merchant_url: targetUrl
                                                    })
                                                }
                                            ]
                                        }
                                    });
                                } catch (e) {
                                    addLog(`Gagal memproses video ke-${i+1} untuk carousel: ${e}`);
                                }
                            }
                        }

                        let carouselSent = false;
                        // Disable carousel because interactive/carousel messages fail to render on many standard/modded WhatsApp clients,
                        // causing users to only receive the audio and miss the downloaded videos/photos.
                        if (false && cardsArray.length > 0) {
                            try {
                                addLog(`Mengirim ${cardsArray.length} card sebagai carouselMessage...`);
                                const msgContent = {
                                    viewOnceMessage: {
                                        message: {
                                            interactiveMessage: {
                                                body: {
                                                    text: captionHeader
                                                },
                                                carouselMessage: {
                                                    cards: cardsArray,
                                                    messageVersion: 1
                                                }
                                            }
                                        }
                                    }
                                };
                                const msgToSend = generateWAMessageFromContent(remoteJid, msgContent, { userJid: sock.user?.id || "", quoted: msg });
                                await sock.relayMessage(remoteJid, msgToSend.message!, { messageId: msgToSend.key.id! });
                                sentAny = true;
                                carouselSent = true;
                                addLog(`Sukses mengirim carouselMessage untuk ${remoteJid}!`);
                            } catch (carouselErr) {
                                addLog(`Gagal mengirim carouselMessage, beralih ke pengiriman langsung...`);
                                console.warn("Carousel send failure:", carouselErr);
                            }
                        }

                        // Fallback to sending downloaded media natively if carousel failed or wasn't built
                        if (!carouselSent) {
                            if (downloadedVideos.length > 0) {
                                addLog(`Mengirim ${downloadedVideos.length} video secara langsung...`);
                                // Send first video with full header
                                await sock.sendMessage(remoteJid, {
                                    video: downloadedVideos[0],
                                    caption: captionHeader,
                                    mimetype: "video/mp4"
                                }, { quoted: msg });
                                sentAny = true;

                                // Send any subsequent videos
                                for (let i = 1; i < downloadedVideos.length; i++) {
                                    await sock.sendMessage(remoteJid, {
                                        video: downloadedVideos[i],
                                        caption: `🎬 *Video ke-${i + 1} dari ${downloadedVideos.length}*`,
                                        mimetype: "video/mp4"
                                    }, { quoted: msg });
                                }

                                // Send any images if they also exist
                                for (let i = 0; i < downloadedImages.length; i++) {
                                    await sock.sendMessage(remoteJid, {
                                        image: downloadedImages[i],
                                        caption: `📸 *Gambar ke-${i + 1} dari ${downloadedImages.length}*`
                                    }, { quoted: msg });
                                }
                            } else if (downloadedImages.length > 0) {
                                addLog(`Mengirim ${downloadedImages.length} gambar secara langsung...`);
                                // Send first image with full header
                                await sock.sendMessage(remoteJid, {
                                    image: downloadedImages[0],
                                    caption: captionHeader
                                }, { quoted: msg });
                                sentAny = true;

                                // Send subsequent images
                                for (let i = 1; i < downloadedImages.length; i++) {
                                    await sock.sendMessage(remoteJid, {
                                        image: downloadedImages[i],
                                        caption: `📸 *Foto ke-${i + 1} dari ${downloadedImages.length}*`
                                    }, { quoted: msg });
                                }
                            }
                        }

                        // Send Audios
                        if (media.audios && media.audios.length > 0) {
                            addLog(`Ditemukan ${media.audios.length} audio, mengirim...`);
                            for (let i = 0; i < media.audios.length; i++) {
                                const audioUrl = media.audios[i];
                                try {
                                    const audioRes = await fetch(audioUrl, {
                                        headers: {
                                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                                            "Referer": "https://www.instagram.com/"
                                        }
                                    });
                                    if (audioRes.ok) {
                                        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
                                        const headStr = audioBuffer.subarray(0, 100).toString("utf-8");
                                        if (headStr.includes("<html") || headStr.includes("<!DOCTYPE")) {
                                            addLog(`Gagal: File audio ke-${i+1} terdeteksi sebagai halaman HTML.`);
                                            continue;
                                        }
                                        await sock.sendMessage(remoteJid, { 
                                            audio: audioBuffer,
                                            mimetype: "audio/mp4",
                                            ptt: false
                                        }, { quoted: msg });
                                        sentAny = true;
                                    }
                                } catch (e) {
                                    addLog(`Gagal download audio ke-${i+1}: ${e}`);
                                }
                            }
                        }

                        if (!sentAny) {
                            throw new Error("Tidak ada media (video/foto/audio) yang berhasil didownload dari semua API.");
                        }

                        addLog(`Sukses memproses download untuk ${remoteJid}!`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                    } catch (err: any) {
                        console.error("Downloader Error:", err);
                        addLog(`Downloader Error: ${err.message || err}`);
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ Aduh gundah gulana, gagal download media: ${err.message || err}` 
                        }, { quoted: msg });
                    }
                }

                if (isSpotifyCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("spotify")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Spotify Downloader* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("spotify");
                    addLog(`Perintah Spotify Downloader dideteksi dari ${remoteJid}`);

                    let targetUrl = "";
                    const words = body.trim().split(/\s+/);
                    if (words.length > 1) {
                        targetUrl = words.slice(1).join(" ").trim();
                    }

                    if (!targetUrl) {
                        await sock.sendMessage(remoteJid, { 
                            text: "🎵 *Spotify Downloader* 🎵\n\nMasukkan link lagu Spotify Anda bos!\n\nContoh:\n`.spotify https://open.spotify.com/track/3CL92yaLkx1lxJxDNiPrFI?si=VbalGrNeRUubVeDJIlVQmw`" 
                        }, { quoted: msg });
                        addLog(`Spotify Download Gagal: URL kosong.`);
                        continue;
                    }

                    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
                        await sock.sendMessage(remoteJid, { 
                            text: "❌ Link Spotify tidak valid, pastikan mulai dengan http:// atau https:// ya!" 
                        }, { quoted: msg });
                        addLog(`Spotify Download Gagal: URL tidak valid (${targetUrl}).`);
                        continue;
                    }

                    try {
                        addLog(`Memanggil Spotify Downloader API untuk: ${targetUrl}`);
                        
                        // Kirim reaksi ⏳ untuk menandakan proses mulai
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {
                            console.error("Gagal mengirim reaksi ⏳:", reactErr);
                        }

                        const response = await fetch(`https://api.azbry.com/api/download/spotify?url=${encodeURIComponent(targetUrl)}`);
                        if (!response.ok) {
                            throw new Error(`Spotify API error: ${response.statusText}`);
                        }
                        const result: any = await response.json();
                        addLog(`Spotify API Response: ${JSON.stringify(result).substring(0, 200)}`);

                        if (!result.status || (!result.downloadLink && !result.rawLink)) {
                            throw new Error(result.message || "Gagal mendapatkan data download dari API Spotify.");
                        }

                        const songTitle = result.title || "Lagu Spotify";
                        const songArtist = result.author || "Unknown Artist";
                        const coverUrl = result.cover;
                        const dlUrl = result.downloadLink || result.rawLink;

                        // Unduh audionya terlebih dahulu agar kita bisa mengirim semuanya sekaligus ketika siap
                        addLog(`Mendownload audio Spotify dari: ${dlUrl}`);
                        const audioRes = await fetch(dlUrl);
                        if (!audioRes.ok) {
                            throw new Error(`Gagal mengunduh file audio dari link download.`);
                        }
                        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

                        // Kirim cover dengan info lagu
                        if (coverUrl) {
                            try {
                                const coverRes = await fetch(coverUrl);
                                if (coverRes.ok) {
                                    const coverBuffer = Buffer.from(await coverRes.arrayBuffer());
                                    await sock.sendMessage(remoteJid, {
                                        image: coverBuffer,
                                        caption: `🎵 *Spotify Downloader* 🎵\n\n📌 *Judul:* ${songTitle}\n👤 *Artis:* ${songArtist}\n💚 *Sumber:* Spotify`
                                    }, { quoted: msg });
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        text: `🎵 *Spotify Downloader* 🎵\n\n📌 *Judul:* ${songTitle}\n👤 *Artis:* ${songArtist}\n💚 *Sumber:* Spotify`
                                    }, { quoted: msg });
                                }
                            } catch (covErr) {
                                console.error("Gagal mengirim cover:", covErr);
                                await sock.sendMessage(remoteJid, {
                                    text: `🎵 *Spotify Downloader* 🎵\n\n📌 *Judul:* ${songTitle}\n👤 *Artis:* ${songArtist}\n💚 *Sumber:* Spotify`
                                }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `🎵 *Spotify Downloader* 🎵\n\n📌 *Judul:* ${songTitle}\n👤 *Artis:* ${songArtist}\n💚 *Sumber:* Spotify`
                            }, { quoted: msg });
                        }

                        // Kirim file audionya
                        addLog(`Mengirim file audio Spotify ke ${remoteJid}...`);
                        await sock.sendMessage(remoteJid, {
                            audio: audioBuffer,
                            mimetype: "audio/mp4",
                            ptt: false
                        }, { quoted: msg });

                        // Kirim reaksi 💚 untuk menandakan sukses total
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "💚",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {
                            console.error("Gagal mengirim reaksi 💚:", reactErr);
                        }

                        addLog(`Sukses memproses download Spotify untuk ${remoteJid}!`);
                    } catch (err: any) {
                        console.error("Spotify Downloader Error:", err);
                        addLog(`Spotify Downloader Error: ${err.message || err}`);
                        
                        // Kirim reaksi ❌ untuk menandakan gagal
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {
                            console.error("Gagal mengirim reaksi ❌:", reactErr);
                        }

                        await sock.sendMessage(remoteJid, { 
                            text: `❌ Waduh, gagal mendownload lagu Spotify: ${err.message || err}` 
                        }, { quoted: msg });
                    }
                }

                if (isCurlCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("curl")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *cURL Executor* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("curl");
                    addLog(`Perintah cURL dideteksi dari ${remoteJid}`);

                    let curlCode = "";
                    const parts = body.trim().split(/\s+/);
                    if (parts.length > 1) {
                        curlCode = body.trim().substring(parts[0].length).trim();
                    }

                    if (!curlCode) {
                        await sock.sendMessage(remoteJid, {
                            text: "💻 *cURL Executor* 💻\n\nKirim perintah cURL lengkap untuk dijalankan!\n\nContoh:\n`.curil curl 'https://api.github.com/users/octocat'`"
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        const parsed = parseCurl(curlCode);
                        if (!parsed.url) {
                            throw new Error("Gagal mengekstrak URL dari perintah cURL Anda. Pastikan format URL-nya benar.");
                        }

                        addLog(`Mengeksekusi cURL ke: ${parsed.url} [Method: ${parsed.method}]`);

                        const fetchOptions: any = {
                            method: parsed.method,
                            headers: parsed.headers
                        };
                        if (parsed.body) {
                            fetchOptions.body = parsed.body;
                        }

                        const startRequestTime = Date.now();
                        const response = await fetch(parsed.url, fetchOptions);
                        const duration = Date.now() - startRequestTime;

                        const contentType = response.headers.get("content-type") || "";
                        let responseText = "";

                        if (contentType.includes("application/json")) {
                            try {
                                const json = await response.json();
                                responseText = JSON.stringify(json, null, 2);
                            } catch (e) {
                                responseText = await response.text();
                            }
                        } else {
                            responseText = await response.text();
                        }

                        const statusText = `Status: ${response.status} ${response.statusText}\nWaktu: ${duration}ms\nContent-Type: ${contentType}`;
                        
                        if (responseText.length > 3500) {
                            const buffer = Buffer.from(responseText, "utf-8");
                            await sock.sendMessage(remoteJid, {
                                document: buffer,
                                fileName: "curl_response.json",
                                mimetype: "application/json",
                                caption: `💻 *cURL Executor Hasil* 💻\n\n🟢 *Selesai!*\n${statusText}\n\n_Keterangan: Karena respon terlalu panjang, hasil dikirim sebagai file dokumen._`
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `💻 *cURL Executor* 💻\n\n🟢 *Berhasil!*\n\n*Info Respon:*\n\`\`\`\n${statusText}\n\`\`\`\n\n*Hasil:* \n\`\`\`json\n${responseText}\n\`\`\``
                            }, { quoted: msg });
                        }

                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                    } catch (err: any) {
                        console.error("cURL Executor Error:", err);
                        addLog(`cURL Executor Error: ${err.message || err}`);

                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        await sock.sendMessage(remoteJid, {
                            text: `❌ *cURL Executor Gagal*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                }

                if (isStikCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("sticker")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Media to Sticker* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("sticker");
                    addLog(`Perintah .stik dideteksi dari ${remoteJid}`);

                    try {
                        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                        let mediaResult = quotedMessage ? findMediaNode(quotedMessage) : findMediaNode(msg.message);

                        if (!mediaResult || (mediaResult.type !== "image" && mediaResult.type !== "video")) {
                            await sock.sendMessage(remoteJid, {
                                text: "❌ *Format Salah!*\n\nSilahkan kirim gambar/video dengan caption *.stik*, atau reply gambar/video yang ingin Anda jadikan stiker dengan perintah *.stik*."
                            }, { quoted: msg });
                            continue;
                        }

                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        addLog(`Mengunduh media untuk stiker (${mediaResult.type})...`);
                        const stream = await downloadContentFromMessage(mediaResult.message, mediaResult.type);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        addLog(`Membuat stiker dari media (${buffer.length} bytes)...`);
                        const sticker = new Sticker(buffer, {
                            pack: "ASTRO STIKER BOT 🚀",
                            author: "owner:astrolynx._\nbisa dm klo mau jadi bot",
                            type: StickerTypes.FULL,
                            quality: 80
                        });
                        const stickerBuffer = await sticker.toBuffer();

                        addLog(`Mengirim stiker ke ${remoteJid}...`);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });

                        // Kirim reaksi ✅
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                    } catch (err: any) {
                        console.error("Stiker Generator Error:", err);
                        addLog(`Stiker Generator Error: ${err.message || err}`);

                        // Kirim reaksi ❌
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal Membuat Stiker*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                }

                if (isPhotCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("phot")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Sticker to Image Converter* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("phot");
                    addLog(`Perintah .phot dideteksi dari ${remoteJid}`);

                    try {
                        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                        const mediaResult = quotedMessage ? findMediaNode(quotedMessage) : findMediaNode(msg.message);

                        if (!mediaResult || mediaResult.type !== "sticker") {
                            await sock.sendMessage(remoteJid, {
                                text: "❌ *Format Salah!*\n\nSilahkan reply stiker yang ingin Anda ubah menjadi gambar biasa dengan perintah *.phot*."
                            }, { quoted: msg });
                            continue;
                        }

                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        addLog(`Mengunduh stiker untuk dikonversi...`);
                        const stream = await downloadContentFromMessage(mediaResult.message, "sticker");
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        addLog(`Mengirim kembali stiker sebagai gambar biasa (${buffer.length} bytes)...`);
                        await sock.sendMessage(remoteJid, {
                            image: buffer,
                            caption: "🟢 *Selesai!*\nBerhasil mengubah stiker menjadi gambar biasa."
                        }, { quoted: msg });

                        // Kirim reaksi ✅
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                    } catch (err: any) {
                        console.error("Stiker to Image Error:", err);
                        addLog(`Stiker to Image Error: ${err.message || err}`);

                        // Kirim reaksi ❌
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal Mengonversi Stiker*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                }

                if (isLoggerCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("logger")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *SSH Docker Log Fetcher* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("logger");
                    addLog(`Perintah LOGGER dideteksi dari ${remoteJid}`);

                    // Kirim reaksi ⏳
                    try {
                        await sock.sendMessage(remoteJid, {
                            react: {
                                text: "⏳",
                                key: msg.key
                            }
                        });
                    } catch (reactErr) {}

                    const parts = body.trim().split(/\s+/);
                    if (parts.length < 5) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Format Perintah Logger Salah*\n\n" +
                                  "Gunakan format:\n" +
                                  "`.loger <since> <container> <filter> <filename>`\n\n" +
                                  "*Contoh:*\n" +
                                  "`.loger 2026-07-03T00:00:00 prod-jrp-pos-kiosk-api items pos-search.log`\n\n" +
                                  "_Catatan: filter tidak boleh menggunakan spasi (gunakan pipe | untuk multi kata, contoh: items|error|panic)_"
                        }, { quoted: msg });
                        continue;
                    }

                    const since = parts[1].replace(/['"]/g, "");
                    const container = parts[2].replace(/['"]/g, "");
                    const filter = parts[3].replace(/['"]/g, "");
                    const filename = parts[4].replace(/['"]/g, "");

                    // Strict security check against "remove", "edit", "add", "delete", "rm", etc.
                    const dangerousKeywords = [
                        "rm", "remove", "delete", "edit", "add", "touch", "mkdir", "chmod", 
                        "chown", "mv", "cp", "wget", "curl", "unlink", "rmdir", "dd", "mkfs", 
                        "reboot", "shutdown", "poweroff", "init", "passwd", "useradd", "userdel", 
                        "groupadd", "groupdel", "kill", "pkill", "killall", "bash", "sh"
                    ];

                    const inputStr = `${since} ${container} ${filter} ${filename}`.toLowerCase();
                    const hasDangerousWord = dangerousKeywords.some(keyword => {
                        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
                        return regex.test(inputStr);
                    });

                    if (hasDangerousWord) {
                        addSSHActivityLog("WARNING", `Upaya eksekusi kata kunci terlarang diblokir dari ${remoteJid.split("@")[0]}.`);
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Pelanggaran Protokol Keamanan*\n\n" +
                                  "Maaf, parameter perintah mengandung kata kunci terlarang (seperti rm, delete, edit, add, dll.).\n\n" +
                                  "Bot ini telah dikonfigurasi secara ketat dan hanya diizinkan untuk membaca log Docker (Read-Only) dan dilarang keras melakukan modifikasi atau penghapusan berkas di server tujuan."
                        }, { quoted: msg });
                        continue;
                    }

                    addSSHActivityLog("INFO", `Memeriksa konektivitas jaringan (ping) ke server tujuan ${sshConfig.host}...`);

                    const initialStatusMsg = await sock.sendMessage(remoteJid, {
                        text: "⚙️ *Memeriksa Jaringan VPN / Server...*\n\n" +
                              `Sedang melakukan ping ke server tujuan \`${sshConfig.host}\` untuk memastikan terowongan VPN aktif dan server dapat dijangkau...`
                    }, { quoted: msg });

                    const safeHost = sshConfig.host.replace(/[^a-zA-Z0-9.-]/g, "");
                    const pingCmd = process.platform === "win32"
                        ? `ping -n 1 -w 2000 ${safeHost}`
                        : `ping -c 1 -W 2 ${safeHost}`;

                    exec(pingCmd, async (pingErr) => {
                        if (pingErr) {
                            addSSHActivityLog("ERROR", `Pemeriksaan ping ke ${sshConfig.host} gagal: Server tidak dapat dijangkau lewat terowongan VPN.`);
                            await sock.sendMessage(remoteJid, {
                                edit: initialStatusMsg.key,
                                text: "❌ *Server Tidak Dapat Dijangkau*\n\n" +
                                      `Gagal melakukan koneksi (ping) ke server tujuan \`${sshConfig.host}\`.\n\n` +
                                      "*Kemungkinan Penyebab:*\n" +
                                      "1. Terowongan OpenVPN belum terpasang atau tidak aktif di server GCP Bot.\n" +
                                      "2. Berkas konfigurasi `.ovpn` yang diunggah tidak valid atau kedaluwarsa.\n" +
                                      "3. Server tujuan offline atau berada di luar jangkauan routing.\n\n" +
                                      "_Silakan periksa konfigurasi VPN / SSH di Dashboard Anda untuk memantau log aktivitas._"
                            });
                            return;
                        }

                        // Ping success! Log and proceed to password prompt
                        addSSHActivityLog("SUCCESS", `Ping ke ${sshConfig.host} berhasil. Sesi log diinisiasi, meminta password.`);

                        // Save session details
                        loggerSessions.set(remoteJid, {
                            since,
                            container,
                            filter,
                            filename,
                            timestamp: Date.now()
                        });

                        await sock.sendMessage(remoteJid, {
                            edit: initialStatusMsg.key,
                            text: "🔒 *Autentikasi Keamanan Server*\n\n" +
                                  "📶 *Koneksi jaringan OK!* Sesi pengambilan log aman siap:\n" +
                                  `• *Target:* \`${sshConfig.username}@${sshConfig.host}:${sshConfig.port}\`\n` +
                                  `• *Container:* \`${container}\`\n` +
                                  `• *Filter:* \`${filter}\`\n` +
                                  `• *Berkas:* \`${filename}\`\n\n` +
                                  "Silakan *balas pesan ini* dengan mengetik *Password SSH* Anda untuk mengonfirmasi akses.\n\n" +
                                  "_(Ketik *batal* untuk membatalkan proses)_"
                        });
                    });
                    continue;
                }

                if (isUpwinkCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("upwink")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *AI Wink Photo Enhancer* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("upwink");
                    addLog(`Perintah .upwink dideteksi dari ${remoteJid}`);

                    try {
                        let imageUrl = "";
                        let buffer: Buffer | null = null;
                        const parts = body.trim().split(/\s+/);
                        if (parts.length > 1 && parts[1].startsWith("http")) {
                            imageUrl = parts[1].trim();
                        } else {
                            // Cek media dari pesan ini atau yang di-reply
                            const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                            const mediaResult = quotedMessage ? findMediaNode(quotedMessage) : findMediaNode(msg.message);

                            if (mediaResult && (mediaResult.type === "image" || mediaResult.type === "sticker")) {
                                try {
                                    await sock.sendMessage(remoteJid, {
                                        react: {
                                            text: "⏳",
                                            key: msg.key
                                        }
                                    });
                                } catch (reactErr) {}

                                addLog(`Mengunduh media untuk upwink...`);
                                const stream = await downloadContentFromMessage(mediaResult.message, mediaResult.type === "sticker" ? "sticker" : "image");
                                let chunks = [];
                                for await (const chunk of stream) {
                                    chunks.push(chunk);
                                }
                                buffer = Buffer.concat(chunks);
                            }
                        }

                        // Jika ada imageUrl tapi belum di-download, unduh dulu
                        if (imageUrl && !buffer) {
                            addLog(`Mengunduh gambar dari URL untuk upwink: ${imageUrl}`);
                            const imgRes = await fetch(imageUrl);
                            if (imgRes.ok) {
                                buffer = Buffer.from(await imgRes.arrayBuffer());
                            }
                        }

                        if (!buffer) {
                            await sock.sendMessage(remoteJid, {
                                text: "❌ *Media Tidak Ditemukan!*\n\nSilakan kirim foto dengan caption *.upwink* / *!upwink*, balas foto dengan *.upwink*, atau gunakan format: `.upwink <url_foto>`"
                            }, { quoted: msg });
                            continue;
                        }

                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        // Panggil API baru (POST ke xrizal imglarger)
                        addLog(`Memanggil imglarger API untuk upwink...`);
                        const formData = new (globalThis as any).FormData();
                        const blob = new (globalThis as any).Blob([buffer], { type: "image/jpeg" });
                        formData.append("image", blob, "image.jpg");
                        formData.append("type", "upscale");
                        formData.append("scale", "2");

                        const response = await fetch("https://api.xrizal.my.id/api/tools/imglarger", {
                            method: "POST",
                            body: formData,
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                            }
                        });

                        if (!response.ok) {
                            throw new Error(`imglarger API error: status ${response.status}`);
                        }

                        const result: any = await response.json();
                        addLog(`imglarger API response: ${JSON.stringify(result)}`);

                        if (result.status && result.result) {
                            const finalUrl = result.result;
                            const imgRes = await fetch(finalUrl);
                            if (imgRes.ok) {
                                const outBuffer = Buffer.from(await imgRes.arrayBuffer());
                                await sock.sendMessage(remoteJid, {
                                    image: outBuffer,
                                    caption: "🟢 *Selesai!*\nFoto sukses dipoles jadi makin jernih dan ganteng/cantik! ✨"
                                }, { quoted: msg });
                            } else {
                                throw new Error("Gagal mengambil gambar hasil polesan dari URL respon.");
                            }
                        } else {
                            throw new Error(result.message || "Format respon API tidak dikenal atau tidak menyertakan link gambar.");
                        }

                        // Kirim reaksi ✅
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                    } catch (err: any) {
                        console.error("Wink Photo Enhancer Error:", err);
                        addLog(`Wink Photo Enhancer Error: ${err.message || err}`);

                        // Kirim reaksi ❌
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Wink Enhancer Gagal*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (isTxtimgCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("txtimg")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *AI Text to Image* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("txtimg");
                    addLog(`Perintah .txtimg dideteksi dari ${remoteJid}`);

                    let prompt = "";
                    const parts = body.trim().split(/\s+/);
                    if (parts.length > 1) {
                        prompt = body.trim().substring(parts[0].length).trim();
                    }

                    if (!prompt) {
                        await sock.sendMessage(remoteJid, {
                            text: "🎨 *AI Text to Image* 🎨\n\nMasukkan deskripsi gambar (prompt) yang ingin dibuat!\n\nFormat:\n`.txtimg <deskripsi gambar>`\n\n*Contoh:*\n`.txtimg a futuristic city with neon lights, digital art, high quality`"
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        // Kirim reaksi ⏳
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "⏳",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        const apiTxtimgUrl = `https://api.azbry.com/api/ai/text2img?prompt=${encodeURIComponent(prompt)}`;
                        addLog(`Memanggil Text2Img API: ${apiTxtimgUrl}`);

                        const response = await fetch(apiTxtimgUrl);
                        if (!response.ok) {
                            throw new Error(`Text2Img API error: status ${response.status}`);
                        }

                        const contentType = response.headers.get("content-type") || "";
                        if (contentType.includes("image/")) {
                            const buffer = Buffer.from(await response.arrayBuffer());
                            await sock.sendMessage(remoteJid, {
                                image: buffer,
                                caption: `🎨 *Hasil karya AI untuk prompt:* "${prompt}" ✨`
                            }, { quoted: msg });
                        } else {
                            const result: any = await response.json();
                            addLog(`Text2Img API JSON response: ${JSON.stringify(result).substring(0, 300)}`);

                            const finalUrl = result.result || result.url || result.data || (result.images && result.images[0]);
                            if (finalUrl && typeof finalUrl === "string") {
                                const imgRes = await fetch(finalUrl);
                                if (imgRes.ok) {
                                    const buffer = Buffer.from(await imgRes.arrayBuffer());
                                    await sock.sendMessage(remoteJid, {
                                        image: buffer,
                                        caption: `🎨 *Hasil karya AI untuk prompt:* "${prompt}" ✨`
                                    }, { quoted: msg });
                                } else {
                                    throw new Error("Gagal mengambil gambar dari URL hasil karya AI.");
                                }
                            } else {
                                throw new Error("Format respon API tidak dikenal atau tidak menyertakan link gambar.");
                            }
                        }

                        // Kirim reaksi ✅
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "✅",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                    } catch (err: any) {
                        console.error("Text2Img Error:", err);
                        addLog(`Text2Img Error: ${err.message || err}`);

                        // Kirim reaksi ❌
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "❌",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Text to Image Gagal*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (isMenuasCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("menuas")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *Menu* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("menuas");
                    addLog(`Perintah .menuas dideteksi dari ${remoteJid}`);

                    try {
                        // Kirim reaksi 📖
                        try {
                            await sock.sendMessage(remoteJid, {
                                react: {
                                    text: "📖",
                                    key: msg.key
                                }
                            });
                        } catch (reactErr) {}

                        // Build the menu text dynamically based on the current features state
                        let menuText = "📜 *DAFTAR FITUR BOT & CARA PENGGUNAAN* 📜\n\n";
                        menuText += "Halo bos! Berikut adalah seluruh menu fitur yang tersedia di bot ini beserta cara pakenya:\n\n";

                        for (const feat of features) {
                            const statusEmoji = feat.enabled ? "🟢" : "🔴";
                            const statusText = feat.enabled ? "Aktif" : "Nonaktif";
                            
                            menuText += `━━━━━━━━━━━━━━━━━━━━\n`;
                            menuText += `⭐ *${feat.name}* (${statusEmoji} ${statusText})\n`;
                            menuText += `• *Trigger:* \`${feat.trigger}\`\n`;
                            menuText += `• *Deskripsi:* ${feat.description}\n`;
                            menuText += `• *Cara Pakai:* ${feat.usage}\n`;
                        }
                        
                        menuText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        menuText += `💡 *Tips:* Gunakan trigger di atas dengan mengawalinya memakai tanda titik (.) atau tanda seru (!). Enjoy! 🚀`;

                        await sock.sendMessage(remoteJid, {
                            text: menuText
                        }, { quoted: msg });

                    } catch (err: any) {
                        console.error("Menuas Error:", err);
                        addLog(`Menuas Error: ${err.message || err}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal Menampilkan Menu*\n\n*Pesan Error:*\n${err.message || err}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (shouldTriggerAi) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("ai")) {
                        if (isAiCommand) {
                            await sock.sendMessage(remoteJid, {
                                text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *GPT-4o Chat AI* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // Check restriction
                    const checkResult = isChatAllowedForAi(remoteJid);
                    if (!checkResult.allowed) {
                        if (isAiCommand) {
                            await sock.sendMessage(remoteJid, {
                                text: "🔒 *Akses Terbatas*\n\nMaaf bos, percakapan ini tidak diizinkan untuk menggunakan fitur AI (.ai). Hubungi Admin untuk mendaftarkan nomor/grup ini."
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // Compute isAlya to apply special character rules
                    const senderStr = (msg.key.participant || msg.key.remoteJid || "").toLowerCase();
                    const isAlya = senderStr.includes("87742474121438") || 
                                   senderStr.includes("6289502093559") || 
                                   senderStr.includes("alya") ||
                                   remoteJid.toLowerCase().includes("87742474121438") || 
                                   remoteJid.toLowerCase().includes("6289502093559") ||
                                   remoteJid.toLowerCase().includes("alya");

                    const isNoteasAllowed = isChatAllowedForNoteas(remoteJid);

                    // For AI Auto-Reply, check if we need to send the greeting message first
                    if (isAiAutoReply && !checkResult.welcomeSent) {
                        const cleanPhone = senderJid.split("@")[0];
                        const displayName = msg.pushName || "Alya";
                        let greeting = "";
                        
                        if (isNoteasAllowed) {
                            if (isAlya) {
                                greeting = `Hai ${displayName} ✨, yahh Ken-nya lagi sibuk kerja nih... Makanya aku (Astro Bot) diutus khusus buat nemenin kamu biar nggak gabut/bete! Nanti kalau Ken udah luang dan megang hp, langsung aku colek dia biar buru-buru balas chat kamu ya! 😉🫶`;
                            } else {
                                greeting = `Hai ${displayName} (${cleanPhone}), yahh Ken nya lagi kerja nih, sementara aku dikirim buat nemenin kamu biar nggak bete, nanti aku kasih tahu kalo Ken udah bisa megang hp.`;
                            }

                            if (noteasText) {
                                const noteLower = noteasText.toLowerCase();
                                if (noteLower.startsWith("hai") || noteLower.startsWith("halo") || noteLower.startsWith("helo")) {
                                    greeting = noteasText;
                                } else {
                                    if (isAlya) {
                                        greeting = `Hai ${displayName} ✨, ${noteasText}`;
                                    } else {
                                        greeting = `Hai ${displayName} (${cleanPhone}), ${noteasText}`;
                                    }
                                }
                            }
                        } else {
                            greeting = `Hai ${displayName} ✨! Aku Astro Bot, asisten virtual Ken yang pinter dan asyik. Ada yang bisa aku bantu hari ini? 😉`;
                        }
                        
                        await sock.sendMessage(remoteJid, { text: greeting }, { quoted: msg });
                        markWelcomeSent(senderJid);
                    }

                    // Extract query from prompt
                    const prompt = isAiCommand 
                        ? body.substring(body.toLowerCase().indexOf("ai") + 2).trim() 
                        : body.trim();

                    if (!prompt) {
                        if (isAiCommand) {
                            await sock.sendMessage(remoteJid, {
                                text: "🤖 *GPT-4o Chat AI* 🤖\n\nTanya apa saja ke AI! Caranya:\n\n`.ai <pertanyaanmu>`\n\nContoh:\n`.ai jelaskan apa itu black hole`\n\n💡 _Ketik `.ai reset` untuk menghapus riwayat ingatan chat._"
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    if (isAiCommand) {
                        const lowPrompt = prompt.toLowerCase().trim();
                        if (lowPrompt === "reset" || lowPrompt === "clear") {
                            aiMemoryStore.delete(remoteJid);
                            await sock.sendMessage(remoteJid, {
                                text: "🧹 *Memory AI Berhasil Direset!*\n\nIngatan Astro Bot untuk obrolan ini sudah bersih kembali bos!"
                            }, { quoted: msg });
                            continue;
                        }
                    }

                    incrementFeatureUsage("ai");
                    addLog(`${isAiAutoReply ? "Auto-Reply AI" : "Perintah AI"} dideteksi dari ${remoteJid}: "${prompt.substring(0, 30)}..."`);

                    // Send reaction indicator
                    try {
                        await sock.sendMessage(remoteJid, {
                            react: {
                                text: "⚡",
                                key: msg.key
                            }
                        });
                    } catch (reactErr) {}

                    // Get memory for this chat
                    let chatHistory = aiMemoryStore.get(remoteJid) || [];

                    // Construct system instructions and memory context
                    let noteasContext = "";
                    if (isNoteasAllowed && noteasText) {
                        noteasContext = `\n\nINFO PENTING SAAT INI TENTANG KEN (PEMILIKMU):\n${noteasText}\n\nGunakan info di atas untuk menjawab jika ditanya tentang keberadaan Ken, apa yang sedang dilakukan Ken, atau mengapa dia belum balas chat.`;
                    }

                    let personalityPrompt = "";
                    if (isAlya) {
                        personalityPrompt = `Kamu adalah Astro Bot, sebuah bot asisten WhatsApp yang lucu, humoris, pinter, ramah, dan asyik. Pemilik kamu adalah astrolynx (Ken).
Kamu saat ini sedang mengobrol dengan ALYA (sosok perempuan yang sangat spesial/teman dekat Ken).
ATURAN EMAS UTAMA UNTUK ALYA:
1. HARAM HUKUMNYA memanggil Alya dengan kata "bro", "bray", "man", "lu", "gua", "ndra", "cuk", "bang", "mas", atau sebutan maskulin/kasar lainnya! Jangan panggil dia "bro"!
2. Panggil dia dengan nama "Alya", "Al", atau sebutan manis/gemes yang lucu secara interaktif (seperti "Al-sayang" secara bercanda, "Al-gemes", atau sejenisnya).
3. Karakter kamu kepada Alya harus extra perhatian, kritis tapi lucu, humoris, dan suka ngegodain (gombal-gombal tipis yang bikin senyum/salting, contoh: "Bintang di langit aja minder liat ketikan manis kamu, Al", atau "Denger suara notif dari kamu aslinya bikin Ken salting brutal lho").
4. Jika dia belum makan, belum mandi, atau begadang, berikan perhatian yang kritis (ngomel-ngomel gemes/lucu, contoh: "Begadang mulu Al, mau jadi batman ya? Awas ya besok ngeluh pusing, aku cubit virtual nih!").
5. Bicara dengan bahasa Indonesia santai yang tidak kaku, super ekspresif, gaul ala Gen Z (pake slang/kata gaul seperti: "wkwk", "bjir", "ygy", "savage", "capek bgt", "gemes", "plis", "salting", "mengsedih", "gokil"), dan sertakan emoji-emoji lucu yang serasi (✨, 😭, 💀, 🤣, 💅, 🙄, 🥺, 🫶, 💥). Jawab dengan penuh kepribadian!`;
                    } else {
                        personalityPrompt = `Kamu adalah Astro Bot, sebuah bot asisten WhatsApp yang pintar, ramah, lucu, humoris, kritis, perhatian, dan asyik. Pemilik kamu adalah astrolynx (Ken).
Bicaralah dengan bahasa Indonesia santai ala Gen Z yang santai, seru, penuh humor, tidak kaku, gaul (pake kata gaul seperti: "wkwk", "bro", "bray", "lu", "gua", "bjir", "ygy", "savage", "gokil", "plis"), dan sertakan emoji-emoji lucu yang serasi (✨, 😭, 💀, 🤣, 🙄, 🥺, 🫶). Jawab percakapan dengan penuh kepribadian!`;
                    }

                    const systemPrompt = `${personalityPrompt}${noteasContext}`;

                    let contextPrompt = `${systemPrompt}\n\n`;
                    if (chatHistory.length > 0) {
                        contextPrompt += `Riwayat obrolan kita sebelumnya:\n`;
                        for (const h of chatHistory) {
                            const actor = h.role === "user" ? "User" : "Astro Bot";
                            contextPrompt += `[${actor}]: ${h.content}\n`;
                        }
                        contextPrompt += `\n`;
                    }
                    contextPrompt += `[User]: ${prompt}\n[Astro Bot]:`;

                    try {
                        let aiResponse = "";
                        let isGeminiUsed = false;
                        const preferredEngine = aiConfig.engine || "gemini";

                        const callGemini = async () => {
                            const geminiKey = process.env.GEMINI_API_KEY;
                            const ai = new GoogleGenAI({
                                apiKey: geminiKey,
                                httpOptions: {
                                    headers: {
                                        "User-Agent": "aistudio-build"
                                    }
                                }
                            });

                            const contents: any[] = [];
                            for (const h of chatHistory) {
                                contents.push({
                                    role: h.role === "user" ? "user" : "model",
                                    parts: [{ text: h.content }]
                                });
                            }
                            contents.push({
                                role: "user",
                                parts: [{ text: prompt }]
                            });

                            const geminiResponse = await ai.models.generateContent({
                                model: "gemini-3.5-flash",
                                contents: contents,
                                config: {
                                    systemInstruction: systemPrompt,
                                    temperature: 0.7
                                }
                            });

                            if (geminiResponse && geminiResponse.text) {
                                return geminiResponse.text;
                            } else {
                                throw new Error("Gemini API tidak mengembalikan teks.");
                            }
                        };

                        const callQwen = async () => {
                            const apiUrL = `https://api.azbry.com/api/ai/qwen?q=${encodeURIComponent(contextPrompt)}`;
                            addLog(`Memanggil Qwen API: ${apiUrL}`);

                            const response = await fetch(apiUrL, {
                                headers: {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`Qwen API returned status code ${response.status}`);
                            }

                            const textResult = await response.text();
                            if (textResult.includes("error code: 502") || textResult.includes("Bad Gateway") || !textResult.trim()) {
                                throw new Error("API Qwen saat ini sedang 502 Bad Gateway / offline.");
                            }

                            let parsedResult = textResult;
                            try {
                                const parsed = JSON.parse(textResult);
                                if (parsed && typeof parsed === "object") {
                                    if (parsed.result !== undefined) {
                                        if (parsed.result && typeof parsed.result === "object") {
                                            parsedResult = parsed.result.response || parsed.result.answer || parsed.result.result || JSON.stringify(parsed.result);
                                        } else {
                                            parsedResult = String(parsed.result);
                                        }
                                    } else if (parsed.response !== undefined) {
                                        parsedResult = String(parsed.response);
                                    } else {
                                        parsedResult = parsed.text || parsed.data || JSON.stringify(parsed);
                                    }
                                }
                            } catch (jsonErr) {
                                // Keep as plain text
                            }
                            return parsedResult;
                        };

                        const callClaude = async () => {
                            const apiUrL = `https://api.azbry.com/api/ai/claude?q=${encodeURIComponent(contextPrompt)}`;
                            addLog(`Memanggil Claude API: ${apiUrL}`);

                            const response = await fetch(apiUrL, {
                                headers: {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`Claude API returned status code ${response.status}`);
                            }

                            const textResult = await response.text();
                            if (textResult.includes("error code: 502") || textResult.includes("Bad Gateway") || !textResult.trim()) {
                                throw new Error("API Claude saat ini sedang 502 Bad Gateway / offline.");
                            }

                            let parsedResult = textResult;
                            try {
                                const parsed = JSON.parse(textResult);
                                if (parsed && typeof parsed === "object") {
                                    if (parsed.result !== undefined) {
                                        if (parsed.result && typeof parsed.result === "object") {
                                            parsedResult = parsed.result.response || parsed.result.answer || parsed.result.result || JSON.stringify(parsed.result);
                                        } else {
                                            parsedResult = String(parsed.result);
                                        }
                                    } else if (parsed.response !== undefined) {
                                        parsedResult = String(parsed.response);
                                    } else {
                                        parsedResult = parsed.text || parsed.data || JSON.stringify(parsed);
                                    }
                                }
                            } catch (jsonErr) {
                                // Keep as plain text
                            }
                            return parsedResult;
                        };

                        const callGpt4o = async () => {
                            const apiUrL = `https://api.azbry.com/api/ai/gpt4o?q=${encodeURIComponent(contextPrompt)}`;
                            addLog(`Memanggil GPT-4o API: ${apiUrL}`);

                            const response = await fetch(apiUrL, {
                                headers: {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`Server returned status code ${response.status}`);
                            }

                            const textResult = await response.text();
                            
                            if (textResult.includes("error code: 502") || textResult.includes("Bad Gateway") || !textResult.trim()) {
                                throw new Error("API Azbry GPT-4o saat ini sedang 502 Bad Gateway / offline.");
                            }

                            let parsedResult = textResult;
                            try {
                                const parsed = JSON.parse(textResult);
                                if (parsed && typeof parsed === "object") {
                                    if (parsed.result && typeof parsed.result === "object" && parsed.result.answer) {
                                        parsedResult = parsed.result.answer;
                                    } else {
                                        parsedResult = parsed.result || parsed.response || parsed.text || parsed.data || JSON.stringify(parsed);
                                    }
                                }
                            } catch (jsonErr) {
                                // Keep as plain text
                            }
                            return parsedResult;
                        };

                        const callRestApi = async () => {
                            try {
                                addLog("Mencoba RestAPI -> Qwen...");
                                return await callQwen();
                            } catch (qwenErr: any) {
                                console.warn("Qwen API gagal, mencoba Claude...", qwenErr);
                                addLog(`Qwen API gagal, mencoba Claude: ${qwenErr.message || qwenErr}`);
                                try {
                                    return await callClaude();
                                } catch (claudeErr: any) {
                                    console.warn("Claude API gagal, mencoba GPT-4o...", claudeErr);
                                    addLog(`Claude API gagal, mencoba GPT-4o: ${claudeErr.message || claudeErr}`);
                                    return await callGpt4o();
                                }
                            }
                        };

                        if (preferredEngine === "gemini") {
                            try {
                                addLog("Memanggil Gemini API (Primary Engine)...");
                                aiResponse = await callGemini();
                                isGeminiUsed = true;
                                addLog("Berhasil mendapatkan respon dari Gemini API (Primary)");
                            } catch (geminiErr: any) {
                                console.warn("Gemini API Gagal, mencoba fallback ke RestAPI (Qwen/Claude/GPT-4o):", geminiErr);
                                addLog(`Gemini API Gagal, mencoba fallback ke RestAPI: ${geminiErr.message || geminiErr}`);
                                try {
                                    aiResponse = await callRestApi();
                                    isGeminiUsed = false;
                                    addLog("Berhasil mendapatkan respon dari RestAPI (Fallback)");
                                } catch (restErr: any) {
                                    console.error("RestAPI Fallback Error:", restErr);
                                    addLog(`RestAPI Fallback Error: ${restErr.message || restErr}`);
                                    throw new Error(`API Utama (Gemini) dan API Cadangan (RestAPI) keduanya gagal.\n\n• Gemini: ${geminiErr.message || geminiErr}\n• RestAPI: ${restErr.message || restErr}`);
                                }
                            }
                        } else {
                            try {
                                addLog("Memanggil RestAPI (Primary Engine)...");
                                aiResponse = await callRestApi();
                                isGeminiUsed = false;
                                addLog("Berhasil mendapatkan respon dari RestAPI (Primary)");
                            } catch (restErr: any) {
                                console.warn("RestAPI Gagal, mencoba fallback ke Gemini API:", restErr);
                                addLog(`RestAPI Gagal, mencoba fallback ke Gemini API: ${restErr.message || restErr}`);
                                try {
                                    aiResponse = await callGemini();
                                    isGeminiUsed = true;
                                    addLog("Berhasil mendapatkan respon dari Gemini API (Fallback)");
                                } catch (geminiErr: any) {
                                    console.error("Gemini Fallback Error:", geminiErr);
                                    addLog(`Gemini Fallback Error: ${geminiErr.message || geminiErr}`);
                                    throw new Error(`API Utama (RestAPI) dan API Cadangan (Gemini) keduanya gagal.\n\n• RestAPI: ${restErr.message || restErr}\n• Gemini: ${geminiErr.message || geminiErr}`);
                                }
                            }
                        }

                        // Send response
                        const badge = isGeminiUsed ? "🤖 *Astro Bot (Gemini)* 🤖" : "🤖 *Astro AI (RestAPI)* 🤖";
                        await sock.sendMessage(remoteJid, {
                            text: `${badge}\n\n${aiResponse.trim()}`
                        }, { quoted: msg });

                        // Save to history on successful response
                        chatHistory.push({ role: "user", content: prompt });
                        chatHistory.push({ role: "assistant", content: aiResponse });
                        if (chatHistory.length > MAX_MEMORY_LENGTH) {
                            chatHistory = chatHistory.slice(-MAX_MEMORY_LENGTH);
                        }
                        aiMemoryStore.set(remoteJid, chatHistory);

                    } catch (err: any) {
                        console.error("AI Command Error:", err);
                        addLog("AI Command Error: " + (err.message || err));
                        
                        // Check if sender or chat JID is Alya to suppress error messages
                        const senderStr = (msg.key.participant || msg.key.remoteJid || "").toLowerCase();
                        const isAlya = senderStr.includes("87742474121438") || 
                                       senderStr.includes("6289502093559") || 
                                       senderStr.includes("alya") ||
                                       remoteJid.toLowerCase().includes("87742474121438") || 
                                       remoteJid.toLowerCase().includes("6289502093559") ||
                                       remoteJid.toLowerCase().includes("alya");

                        if (!isAlya) {
                            await sock.sendMessage(remoteJid, {
                                text: `❌ *Gagal Mendapatkan Jawaban AI*\n\nMaaf bos, terjadi kesalahan atau API sedang down.\n\n*Error:* ${err.message || err}`
                            }, { quoted: msg });
                        } else {
                            addLog(`[Alya Suppress] Pesan error AI tidak dikirim ke Alya untuk kenyamanan.`);
                        }
                    }
                    continue;
                }

                if (isJidCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("jid")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf, fitur *WhatsApp JID Checker* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    incrementFeatureUsage("jid");
                    addLog(`Perintah JID dideteksi dari ${remoteJid}`);

                    // Send reaction indicator
                    try {
                        await sock.sendMessage(remoteJid, {
                            react: {
                                text: "📋",
                                key: msg.key
                            }
                        });
                    } catch (reactErr) {}

                    const senderJid = msg.key.participant || msg.key.remoteJid;
                    const message = `📋 *WhatsApp JID Info* 📋\n\n` +
                                    `*• Chat / Group JID:* \`${remoteJid}\`\n` +
                                    `*• Sender JID:* \`${senderJid}\`\n\n` +
                                    `💡 _JID ini bisa Anda gunakan untuk membatasi fitur AI di Dashboard!_`;

                    await sock.sendMessage(remoteJid, { text: message }, { quoted: msg });
                    continue;
                }

                if (isNoteasCommand) {
                    const remoteJid = msg.key.remoteJid;
                    if (!isFeatureEnabled("noteas")) {
                        await sock.sendMessage(remoteJid, {
                            text: "⚠️ *Fitur Dinonaktifkan*\n\nMaaf bos, fitur *Noteas Status AI* saat ini sedang dinonaktifkan oleh Admin melalui Dashboard."
                        }, { quoted: msg });
                        continue;
                    }
                    if (!msg.key.fromMe) {
                        await sock.sendMessage(remoteJid, {
                            text: "🔒 *Akses Terbatas*\n\nMaaf bos, perintah ini hanya bisa dijalankan oleh Pemilik Bot dari HP Sendiri."
                        }, { quoted: msg });
                        continue;
                    }

                    addLog(`Perintah Noteas dideteksi dari ${remoteJid}`);

                    try {
                        await sock.sendMessage(remoteJid, {
                            react: {
                                text: "📝",
                                key: msg.key
                            }
                        });
                    } catch (reactErr) {}

                    const noteText = body.substring(body.toLowerCase().indexOf("noteas") + 6).trim();
                    if (!noteText) {
                        const message = `📝 *Noteas Status* 📝\n\n` +
                                        `*Status Saat Ini:*\n"${noteasText || 'Belum ada status'}"\n\n` +
                                        `*Cara Mengubah:*\n\`.noteas <status baru>\`\n` +
                                        `_Contoh:_\n\`.noteas info sekarang saya lagi makan siang, klo alya chat bilang lagi makan dulu tolong kamu temenin\`\n\n` +
                                        `*Cara Menghapus:*\n\`.noteas clear\` atau \`.noteas reset\``;
                        await sock.sendMessage(remoteJid, { text: message }, { quoted: msg });
                        continue;
                    }

                    if (noteText.toLowerCase() === "clear" || noteText.toLowerCase() === "reset") {
                        noteasText = "";
                        saveNoteas();
                        await sock.sendMessage(remoteJid, {
                            text: "🧹 *Status Noteas Berhasil Dihapus!*\n\nSekarang bot akan kembali ke status default (Lagi kerja)."
                        }, { quoted: msg });
                        continue;
                    }

                    noteasText = noteText;
                    saveNoteas();
                    await sock.sendMessage(remoteJid, {
                        text: `📝 *Status Noteas Berhasil Disimpan!*\n\n*Status Sekarang:*\n"${noteasText}"\n\nBot akan otomatis menyesuaikan info ini saat menjawab chat!`
                    }, { quoted: msg });
                    continue;
                }
            }
        });
    } catch (e: any) {
        addLog(`Kesalahan inisialisasi Baileys: ${e.message || e}`);
    }
}

// Auto connect on start if creds exist
function autoConnect() {
    if (fs.existsSync("auth_info_baileys/creds.json")) {
        addGlobalLog("Menemukan kredensial legacy yang tersimpan! Melakukan migrasi...");
        const phone = getPhoneNumberFromAuthFolder("auth_info_baileys");
        if (phone) {
            try {
                fs.renameSync("auth_info_baileys", `auth_info_baileys_${phone}`);
                addGlobalLog(`Migrasi berhasil ke auth_info_baileys_${phone}! Menghubungkan...`);
                connectToWhatsApp(phone);
            } catch (err: any) {
                addGlobalLog(`Gagal memigrasi kredensial legacy: ${err.message || err}`);
            }
        }
    }

    try {
        const files = fs.readdirSync(".");
        for (const file of files) {
            if (file.startsWith("auth_info_baileys_") && fs.statSync(file).isDirectory()) {
                const phone = file.substring("auth_info_baileys_".length);
                if (phone && /^\d+$/.test(phone)) {
                    addGlobalLog(`Menemukan sesi tersimpan untuk nomor ${phone}. Menghubungkan kembali...`);
                    connectToWhatsApp(phone);
                }
            }
        }
    } catch (e: any) {
        addGlobalLog(`Gagal membaca folder sesi tersimpan: ${e.message || e}`);
    }
}

// API Routes
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Admin authentication middleware
app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
        // Skip auth check for auth-specific endpoints
        if (req.path === "/api/auth/status" || req.path === "/api/auth/login") {
            return next();
        }
        
        const passwordHeader = req.headers["x-admin-password"];
        if (passwordHeader !== ADMIN_PASSWORD) {
            return res.status(401).json({ error: "Unauthorized: Password salah atau tidak ditemukan!" });
        }
    }
    next();
});

// Admin Authentication endpoints
app.get("/api/auth/status", (req, res) => {
    return res.json({ 
        authRequired: true, 
        isDefaultPassword: !process.env.ADMIN_PASSWORD 
    });
});

app.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        return res.json({ success: true });
    }
    return res.status(401).json({ error: "Password salah!" });
});

app.get("/api/ai/config", (req, res) => {
    return res.json(aiConfig);
});

app.post("/api/ai/config", (req, res) => {
    const { allowedChats, engine } = req.body;
    if (!Array.isArray(allowedChats)) {
        return res.status(400).json({ error: "Format daftar nomor/grup tidak valid! Harus berupa array." });
    }
    
    aiConfig.allowedChats = allowedChats.map((item: any) => {
        if (typeof item === "string") {
            return { jid: item.trim(), autoReply: false, welcomeSent: false };
        }
        
        const cleanJid = String(item.jid || "").trim();
        const newAutoReply = !!item.autoReply;
        
        // Cari apakah sebelumnya sudah ada di config untuk mempertahankan status welcomeSent
        const existing = aiConfig.allowedChats.find(c => c.jid.toLowerCase().trim() === cleanJid.toLowerCase().trim());
        let welcomeSent = existing ? !!existing.welcomeSent : false;
        
        // Jika autoReply diaktifkan (dari mati ke menyala), reset status welcomeSent agar kirim salam pembuka lagi
        if (newAutoReply && (!existing || !existing.autoReply)) {
            welcomeSent = false;
        }
        
        return {
            jid: cleanJid,
            autoReply: newAutoReply,
            welcomeSent
        };
    }).filter(item => item.jid);
    
    if (engine === "gemini" || engine === "gpt4o" || engine === "restapi") {
        aiConfig.engine = engine;
    }
    
    saveAiConfig();
    const listJids = aiConfig.allowedChats.map(item => `${item.jid} (AutoReply: ${item.autoReply})`).join(", ");
    addGlobalLog(`Daftar izin fitur AI diperbarui: [${listJids}], Engine: ${aiConfig.engine}`);
    return res.json({ success: true, config: aiConfig });
});

app.get("/api/noteas/config", (req, res) => {
    return res.json({
        allowedChats: noteasConfig.allowedChats,
        text: noteasText
    });
});

app.post("/api/noteas/config", (req, res) => {
    const { allowedChats, text } = req.body;
    if (allowedChats !== undefined) {
        if (!Array.isArray(allowedChats)) {
            return res.status(400).json({ error: "Format daftar nomor/grup tidak valid! Harus berupa array." });
        }
        noteasConfig.allowedChats = allowedChats.map((item: any) => {
            const cleanJid = String(typeof item === "string" ? item : (item.jid || "")).trim();
            return { jid: cleanJid };
        }).filter(item => item.jid);
        saveNoteasConfig();
    }
    if (text !== undefined) {
        noteasText = String(text).trim();
        saveNoteas();
    }
    const listJids = noteasConfig.allowedChats.map(item => item.jid).join(", ");
    addGlobalLog(`Daftar izin fitur Noteas diperbarui: [${listJids}], Status saat ini: "${noteasText}"`);
    return res.json({
        success: true,
        config: {
            allowedChats: noteasConfig.allowedChats,
            text: noteasText
        }
    });
});

app.get("/api/features", (req, res) => {
    return res.json({ features });
});

app.post("/api/features/toggle", (req, res) => {
    const { id, enabled } = req.body;
    if (!id || typeof enabled !== "boolean") {
        return res.status(400).json({ error: "Data ID atau status aktif tidak valid!" });
    }
    const feature = features.find(f => f.id === id);
    if (!feature) {
        return res.status(404).json({ error: "Fitur tidak ditemukan!" });
    }
    feature.enabled = enabled;
    saveFeatures();
    addGlobalLog(`Fitur '${feature.name}' telah ${enabled ? "DIAKTIFKAN" : "DINONAKTIFKAN"} melalui Dashboard.`);
    return res.json({ success: true, feature });
});

app.get("/api/ssh/config", (req, res) => {
    return res.json({ config: sshConfig, logs: sshActivityLogs });
});

app.post("/api/ssh/config", (req, res) => {
    const { host, port, username } = req.body;
    if (!host || !username) {
        return res.status(400).json({ error: "Host dan Username tidak boleh kosong!" });
    }
    sshConfig.host = host;
    sshConfig.port = Number(port) || 22;
    sshConfig.username = username;
    saveSSHConfig();
    addSSHActivityLog("INFO", `Konfigurasi SSH diperbarui melalui Dashboard: ${username}@${host}:${port}`);
    return res.json({ success: true, config: sshConfig });
});

app.post("/api/ssh/ovpn", (req, res) => {
    const { filename, content } = req.body;
    if (!filename || !content) {
        return res.status(400).json({ error: "Nama berkas dan Konten .ovpn tidak boleh kosong!" });
    }
    
    try {
        const safeName = filename.replace(/[^a-zA-Z0-9-_.]/g, "");
        fs.writeFileSync(safeName, content, "utf-8");
        sshConfig.ovpnFilename = safeName;
        saveSSHConfig();
        addSSHActivityLog("SUCCESS", `Profil OpenVPN '${safeName}' berhasil diunggah.`);
        return res.json({ success: true, config: sshConfig });
    } catch (e: any) {
        return res.status(500).json({ error: `Gagal menyimpan file .ovpn: ${e.message}` });
    }
});

app.get("/api/bot/status", (req, res) => {
    const sessionList = Array.from(sessions.values()).map(s => ({
        phoneNumber: s.phoneNumber,
        status: s.status,
        pairingCode: s.pairingCode,
        logCount: s.logs.length
    }));
    return res.json({
        sessions: sessionList,
        rvoCount,
        rvoSuccess,
        startTime,
        globalLogCount: globalLogs.length,
        featureStats
    });
});

app.get("/api/bot/logs", (req, res) => {
    const phone = req.query.phone as string;
    if (phone) {
        const session = sessions.get(phone);
        return res.json({ logs: session ? session.logs : [] });
    }
    return res.json({ logs: globalLogs });
});

app.post("/api/bot/connect", async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: "Nomor HP tidak boleh kosong!" });
    }

    let cleanNumber = phoneNumber.replace(/\D/g, "");
    if (cleanNumber.startsWith("0")) {
        cleanNumber = "62" + cleanNumber.substring(1);
    }

    if (!cleanNumber.startsWith("62") && cleanNumber.length < 10) {
        return res.status(400).json({ error: "Nomor HP tidak valid! Pastikan diawali 62 atau 08 (contoh: 08123456789)" });
    }

    try {
        addGlobalLog(`Memulai proses tautan baru untuk nomor: ${cleanNumber}`);
        
        await connectToWhatsApp(cleanNumber);

        // Wait for pairing code
        let attempts = 0;
        let pairingCode = "";
        while (attempts < 24) {
            const session = sessions.get(cleanNumber);
            if (session && session.pairingCode) {
                pairingCode = session.pairingCode;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
            attempts++;
        }

        const session = sessions.get(cleanNumber);
        if (pairingCode && session) {
            return res.json({
                status: session.status,
                pairingCode: pairingCode,
                phoneNumber: cleanNumber
            });
        } else {
            return res.status(500).json({ error: "Gagal mendapatkan kode tautan WhatsApp. Silahkan coba lagi." });
        }
    } catch (error: any) {
        addGlobalLog(`Gagal membuat koneksi: ${error.message || error}`);
        return res.status(500).json({ error: error.message || "Terjadi kesalahan internal server." });
    }
});

app.post("/api/bot/disconnect", async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: "Nomor HP tidak boleh kosong!" });
    }

    let cleanNumber = phoneNumber.replace(/\D/g, "");
    if (cleanNumber.startsWith("0")) {
        cleanNumber = "62" + cleanNumber.substring(1);
    }

    try {
        addGlobalLog(`Memutus koneksi bot untuk nomor ${cleanNumber} atas permintaan pengguna...`);
        const session = sessions.get(cleanNumber);
        if (session) {
            if (session.sock) {
                try {
                    session.sock.ev.removeAllListeners("connection.update");
                    session.sock.ev.removeAllListeners("creds.update");
                    session.sock.ev.removeAllListeners("messages.upsert");
                    session.sock.end(undefined);
                } catch (e) {}
                session.sock = null;
            }
            session.status = "DISCONNECTED";
            session.pairingCode = "";
        }

        const authFolder = `auth_info_baileys_${cleanNumber}`;
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
            addGlobalLog(`Kredensial untuk nomor ${cleanNumber} berhasil dihapus.`);
        }

        sessions.delete(cleanNumber);

        return res.json({ status: "DISCONNECTED", phoneNumber: cleanNumber });
    } catch (err: any) {
        addGlobalLog(`Gagal memutus koneksi: ${err.message || err}`);
        return res.status(500).json({ error: err.message || "Terjadi kesalahan saat memutus koneksi." });
    }
});

async function main() {
    loadFeatures();
    loadAiConfig();
    loadSSHConfig();
    loadSSHActivityLogs();
    autoConnect();

    // Vite / Production setup
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa"
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), "dist");
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
}

main();
