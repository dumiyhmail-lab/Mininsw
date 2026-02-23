const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require("yt-search");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
} = require('baileys');

// ---------------- CONFIG ---------------- 
const config = {
  // Bot Identity
  BOT_NAME: '🔥 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃 🔥',
  BOT_VERSION: '2.0.0',
  OWNER_NAME: 'Your Name',
  OWNER_NUMBER: process.env.OWNER_NUMBER || '94789227570',
  PREFIX: '.',
  
  // Group Settings
  GROUP_INVITE_LINK: '', // Add your group link here
  AUTO_JOIN_GROUP: 'false', // true/false
  
  // Status Settings
  AUTO_VIEW_STATUS: 'false',
  AUTO_LIKE_STATUS: 'false',
  AUTO_LIKE_EMOJI: ['❤️', '🔥', '👍', '🎉'],
  AUTO_RECORDING: 'false',
  
  // Images
  LOGO_URL: 'https://files.catbox.moe/3e7u52.jpg',
  BUTTON_IMAGES: { ALIVE: 'https://files.catbox.moe/3e7u52.jpg' },
  
  // Newsletter Settings
  NEWSLETTER_JID: '',
  
  // General
  MAX_RETRIES: 3,
  OTP_EXPIRY: 300000
};

// ---------------- STORAGE (File-Based Instead of MongoDB) ----------------
const sessionsDir = path.join(__dirname, 'sessions');
const dataDir = path.join(__dirname, 'bot_data');

// Ensure directories exist
fs.ensureDirSync(sessionsDir);
fs.ensureDirSync(dataDir);

const sessionFiles = {
  sessions: path.join(dataDir, 'sessions.json'),
  numbers: path.join(dataDir, 'numbers.json'),
  admins: path.join(dataDir, 'admins.json'),
  newsletters: path.join(dataDir, 'newsletters.json'),
  userConfigs: path.join(dataDir, 'user_configs.json'),
  settings: path.join(dataDir, 'settings.json')
};

// Initialize storage files
Object.values(sessionFiles).forEach(file => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
});

// Storage helper functions
function readJSON(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Session management
async function saveCredsToFile(number, creds, keys = null) {
  const data = readJSON(sessionFiles.sessions);
  const sanitized = number.replace(/[^0-9]/g, '');
  data[sanitized] = { creds, keys, updatedAt: new Date().toISOString() };
  writeJSON(sessionFiles.sessions, data);
  console.log(`Saved session for ${sanitized}`);
}

async function loadCredsFromFile(number) {
  const data = readJSON(sessionFiles.sessions);
  const sanitized = number.replace(/[^0-9]/g, '');
  return data[sanitized] || null;
}

async function removeSessionFromFile(number) {
  const data = readJSON(sessionFiles.sessions);
  const sanitized = number.replace(/[^0-9]/g, '');
  delete data[sanitized];
  writeJSON(sessionFiles.sessions, data);
  
  // Also remove from numbers
  const numbers = readJSON(sessionFiles.numbers);
  delete numbers[sanitized];
  writeJSON(sessionFiles.numbers, numbers);
  console.log(`Removed session for ${sanitized}`);
}

async function addNumberToFile(number) {
  const data = readJSON(sessionFiles.numbers);
  const sanitized = number.replace(/[^0-9]/g, '');
  data[sanitized] = { addedAt: new Date().toISOString() };
  writeJSON(sessionFiles.numbers, data);
}

async function getAllNumbersFromFile() {
  const data = readJSON(sessionFiles.numbers);
  return Object.keys(data);
}

// Admin management
async function loadAdminsFromFile() {
  const data = readJSON(sessionFiles.admins);
  return Object.keys(data);
}

async function addAdminToFile(jidOrNumber) {
  const data = readJSON(sessionFiles.admins);
  data[jidOrNumber] = { addedAt: new Date().toISOString() };
  writeJSON(sessionFiles.admins, data);
}

async function removeAdminFromFile(jidOrNumber) {
  const data = readJSON(sessionFiles.admins);
  delete data[jidOrNumber];
  writeJSON(sessionFiles.admins, data);
}

// User config management
async function setUserConfigInFile(number, conf) {
  const data = readJSON(sessionFiles.userConfigs);
  const sanitized = number.replace(/[^0-9]/g, '');
  data[sanitized] = { ...data[sanitized], ...conf, updatedAt: new Date().toISOString() };
  writeJSON(sessionFiles.userConfigs, data);
}

async function loadUserConfigFromFile(number) {
  const data = readJSON(sessionFiles.userConfigs);
  const sanitized = number.replace(/[^0-9]/g, '');
  return data[sanitized] || {};
}

// Newsletter management
async function addNewsletterToFile(jid, emojis = []) {
  const data = readJSON(sessionFiles.newsletters);
  data[jid] = { jid, emojis, addedAt: new Date().toISOString() };
  writeJSON(sessionFiles.newsletters, data);
}

async function removeNewsletterFromFile(jid) {
  const data = readJSON(sessionFiles.newsletters);
  delete data[jid];
  writeJSON(sessionFiles.newsletters, data);
}

async function listNewslettersFromFile() {
  const data = readJSON(sessionFiles.newsletters);
  return Object.values(data);
}

// Global settings
async function getGlobalSetting(key, defaultValue) {
  const data = readJSON(sessionFiles.settings);
  return data[key] !== undefined ? data[key] : defaultValue;
}

async function setGlobalSetting(key, value) {
  const data = readJSON(sessionFiles.settings);
  data[key] = value;
  writeJSON(sessionFiles.settings, data);
}

// ---------------- UTILITIES ----------------
function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getTimestamp() {
  return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

const activeSockets = new Map();
const socketCreationTime = new Map();
const otpStore = new Map();

// Fake contact for meta styling
const fakevcard = {
  key: {
    remoteJid: "status@broadcast",
    participant: "0@s.whatsapp.net",
    fromMe: false,
    id: "META_AI_FAKE_ID"
  },
  message: {
    contactMessage: {
      displayName: config.BOT_NAME,
      vcard: `BEGIN:VCARD
VERSION:3.0
N:${config.BOT_NAME.replace(/\s+/g, ';')};;;;;;;;
FN:${config.BOT_NAME}
ORG:WhatsApp Bot
TEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}
END:VCARD`
    }
  }
};

// ---------------- GROUP FUNCTIONS ----------------
async function joinGroup(socket) {
  if (config.AUTO_JOIN_GROUP !== 'true' || !config.GROUP_INVITE_LINK) {
    return { status: 'skipped', error: 'Auto join disabled or no invite link' };
  }
  
  let retries = config.MAX_RETRIES;
  const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
  if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
  
  const inviteCode = inviteCodeMatch[1];
  while (retries > 0) {
    try {
      const response = await socket.groupAcceptInvite(inviteCode);
      if (response?.gid) return { status: 'success', gid: response.gid };
      throw new Error('No group ID in response');
    } catch (error) {
      retries--;
      let errorMessage = error.message || 'Unknown error';
      if (error.message && error.message.includes('not-authorized')) errorMessage = 'Bot not authorized';
      else if (error.message && error.message.includes('conflict')) errorMessage = 'Already a member';
      else if (error.message && error.message.includes('gone')) errorMessage = 'Invite invalid/expired';
      if (retries === 0) return { status: 'failed', error: errorMessage };
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

// ---------------- STATUS HANDLERS ----------------
async function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    
    try {
      if (config.AUTO_RECORDING === 'true') {
        await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      }
      
      if (config.AUTO_VIEW_STATUS === 'true') {
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try {
            await socket.readMessages([message.key]);
            break;
          } catch (error) {
            retries--;
            await delay(1000 * (config.MAX_RETRIES - retries));
            if (retries === 0) throw error;
          }
        }
      }
      
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try {
            await socket.sendMessage(message.key.remoteJid, {
              react: { text: randomEmoji, key: message.key }
            }, { statusJidList: [message.key.participant] });
            break;
          } catch (error) {
            retries--;
            await delay(1000 * (config.MAX_RETRIES - retries));
            if (retries === 0) throw error;
          }
        }
      }
    } catch (error) {
      console.error('Status handler error:', error);
    }
  });
}

// ---------------- COMMAND HANDLERS ----------------
function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? 
      msg.message.ephemeralMessage.message : msg.message;

    const from = msg.key.remoteJid;
    const sender = from;
    const nowsender = msg.key.fromMe ? 
      (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : 
      (msg.key.participant || msg.key.remoteJid);
    const senderNumber = (nowsender || '').split('@')[0];
    const botNumber = socket.user.id ? socket.user.id.split(':')[0] : '';
    const isOwner = senderNumber === config.OWNER_NUMBER.replace(/[^0-9]/g, '');

    const body = (type === 'conversation') ? msg.message.conversation
      : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
      : (type === 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption
      : (type === 'videoMessage' && msg.message.videoMessage.caption) ? msg.message.videoMessage.caption
      : (type === 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage?.selectedButtonId
      : (type === 'listResponseMessage') ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
      : (type === 'viewOnceMessage') ? (msg.message.viewOnceMessage?.message?.imageMessage?.caption || '') : '';

    if (!body || typeof body !== 'string') return;

    const prefix = config.PREFIX;
    const isCmd = body && body.startsWith && body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    if (!command) return;

    try {
      switch (command) {
        // ============ MAIN MENU ============
        case 'menu':
        case 'help':
        case 'start': {
          await socket.sendMessage(sender, { react: { text: "🎐", key: msg.key } });
          
          const startTime = socketCreationTime.get(number) || Date.now();
          const uptime = Math.floor((Date.now() - startTime) / 1000);
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          
          const userCfg = await loadUserConfigFromFile(number);
          const botName = userCfg.botName || config.BOT_NAME;
          const logo = userCfg.logo || config.LOGO_URL;
          
          const text = `
╭─「 🤖 ${botName} 」─➤  
│
│ 👤 Owner: ${config.OWNER_NAME}
│ ✏️ Prefix: ${config.PREFIX}
│ 🧬 Version: ${config.BOT_VERSION}
│ ⏰ Uptime: ${hours}h ${minutes}m ${seconds}s
│
╰──────●●➤

╭────────￫
│ 🔧 Features                  
│ [1] 👑 Owner Commands                         
│ [2] 📥 Download Menu                           
│ [3] 🛠️ Tools & Utilities                             
│ [4] ⚙️ Settings & Config                       
│ [5] 🎨 Creative Features                             
╰───────￫

🎯 Tap a category below!
`.trim();

          const buttons = [
            { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 Owner" }, type: 1 },
            { buttonId: `${config.PREFIX}download`, buttonText: { displayText: "📥 Download" }, type: 1 },
            { buttonId: `${config.PREFIX}tools`, buttonText: { displayText: "🛠️ Tools" }, type: 1 },
            { buttonId: `${config.PREFIX}settings`, buttonText: { displayText: "⚙️ Settings" }, type: 1 },
            { buttonId: `${config.PREFIX}creative`, buttonText: { displayText: "🎨 Creative" }, type: 1 }
          ];

          let imagePayload = String(logo).startsWith('http') ? { url: logo } : fs.readFileSync(logo);
          
          await socket.sendMessage(sender, {
            image: imagePayload,
            caption: text,
            footer: `▶ ${botName}`,
            buttons,
            headerType: 4
          }, { quoted: fakevcard });
          break;
        }

        // ============ OWNER MENU ============
        case 'owner': {
          await socket.sendMessage(sender, { react: { text: "👑", key: msg.key } });
          
          const text = `
\`👑 Owner Menu\`

╭─ 🤖 Bot Management
│ ✦ ${config.PREFIX}setname [name]
│ ✦ ${config.PREFIX}setlogo [url]
│ ✦ ${config.PREFIX}deleteme
│ ✦ ${config.PREFIX}bots
╰────────

╭─ 👥 User Management
│ ✦ ${config.PREFIX}addadmin [number]
│ ✦ ${config.PREFIX}removeadmin [number]
│ ✦ ${config.PREFIX}listadmins
╰────────

╭─ ⚙️ System
│ ✦ ${config.PREFIX}restart
│ ✦ ${config.PREFIX}stats
╰────────
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "👑 Owner Commands",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ DOWNLOAD MENU ============
        case 'download': {
          await socket.sendMessage(sender, { react: { text: "📥", key: msg.key } });
          
          const text = `
\`📥 Download Menu\`

╭─ 🎵 Music
│ ✦ ${config.PREFIX}song [query]
│ ✦ ${config.PREFIX}ytmp3 [url]
╰────────

╭─ 🎬 Video
│ ✦ ${config.PREFIX}tiktok [url]
│ ✦ ${config.PREFIX}ytmp4 [url]
╰────────

╭─ 📱 Apps & Files
│ ✦ ${config.PREFIX}mediafire [url]
│ ✦ ${config.PREFIX}apksearch [app]
╰────────
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "📥 Download Commands",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 },
              { buttonId: `${config.PREFIX}creative`, buttonText: { displayText: "🎨 Creative" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ TOOLS MENU ============
        case 'tools': {
          await socket.sendMessage(sender, { react: { text: "🔧", key: msg.key } });
          
          const text = `
\`🛠️ Tools Menu\`

╭─ 📊 Bot Status
│ ✦ ${config.PREFIX}ping
│ ✦ ${config.PREFIX}alive
│ ✦ ${config.PREFIX}speed
╰────────

╭─ 🔍 Info Tools
│ ✦ ${config.PREFIX}sticker
│ ✦ ${config.PREFIX}toimg
│ ✦ ${config.PREFIX}quote
╰────────

╭─ 🎯 Utilities
│ ✦ ${config.PREFIX}calc [expression]
│ ✦ ${config.PREFIX}weather [city]
╰────────
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "🔧 Tools & Utilities",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 },
              { buttonId: `${config.PREFIX}settings`, buttonText: { displayText: "⚙️ Settings" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ SETTINGS MENU ============
        case 'settings': {
          await socket.sendMessage(sender, { react: { text: "⚙️", key: msg.key } });
          
          const text = `
\`⚙️ Settings Menu\`

╭─ 🤖 Bot Customization
│ ✦ ${config.PREFIX}setname [name]
│ ✦ ${config.PREFIX}setlogo [url]
│ ✦ ${config.PREFIX}resetconfig
╰────────

╭─ 🔧 Feature Settings
│ ✦ ${config.PREFIX}autostatus [on/off]
│ ✦ ${config.PREFIX}autorecord [on/off]
│ ✦ ${config.PREFIX}autogroup [on/off]
╰────────

╭─ 🗑️ Session Management
│ ✦ ${config.PREFIX}deleteme
│ ✦ ${config.PREFIX}restart
╰────────
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "⚙️ Settings Commands",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 },
              { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 Owner" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ CREATIVE MENU ============
        case 'creative': {
          await socket.sendMessage(sender, { react: { text: "🎨", key: msg.key } });
          
          const text = `
\`🎨 Creative Menu\`

╭─ 🤖 AI Features
│ ✦ ${config.PREFIX}ai [message]
│ ✦ ${config.PREFIX}gpt [prompt]
│ ✦ ${config.PREFIX}bard [question]
╰────────

╭─ ✍️ Text Tools
│ ✦ ${config.PREFIX}fancy [text]
│ ✦ ${config.PREFIX}glitch [text]
│ ✦ ${config.PREFIX}font [text]
╰────────

╭─ 🖼️ Image Tools
│ ✦ ${config.PREFIX}sticker
│ ✦ ${config.PREFIX}circle
│ ✦ ${config.PREFIX}blur
╰────────
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "🎨 Creative Commands",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 },
              { buttonId: `${config.PREFIX}download`, buttonText: { displayText: "📥 Download" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ BOT CUSTOMIZATION ============
        case 'setname': {
          if (!args[0]) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}setname [new bot name]` 
            }, { quoted: msg });
            break;
          }
          
          const newName = args.join(' ');
          await setUserConfigInFile(number, { botName: newName });
          
          await socket.sendMessage(sender, {
            text: `✅ Bot name changed to: *${newName}*`
          }, { quoted: fakevcard });
          break;
        }

        case 'setlogo': {
          if (!args[0]) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}setlogo [image url]` 
            }, { quoted: msg });
            break;
          }
          
          const logoUrl = args[0];
          await setUserConfigInFile(number, { logo: logoUrl });
          
          await socket.sendMessage(sender, {
            text: `✅ Bot logo changed!`
          }, { quoted: fakevcard });
          break;
        }

        case 'resetconfig': {
          await setUserConfigInFile(number, {});
          
          await socket.sendMessage(sender, {
            text: `✅ Bot configuration reset to default!`
          }, { quoted: fakevcard });
          break;
        }

        // ============ FEATURE SETTINGS ============
        case 'autostatus': {
          const state = args[0]?.toLowerCase();
          if (state === 'on' || state === 'off') {
            config.AUTO_VIEW_STATUS = state === 'on' ? 'true' : 'false';
            config.AUTO_LIKE_STATUS = state === 'on' ? 'true' : 'false';
            
            await socket.sendMessage(sender, {
              text: `✅ Auto Status set to: *${state}*`
            }, { quoted: fakevcard });
          } else {
            await socket.sendMessage(sender, {
              text: `Usage: ${config.PREFIX}autostatus [on/off]`
            }, { quoted: msg });
          }
          break;
        }

        case 'autorecord': {
          const state = args[0]?.toLowerCase();
          if (state === 'on' || state === 'off') {
            config.AUTO_RECORDING = state === 'on' ? 'true' : 'false';
            
            await socket.sendMessage(sender, {
              text: `✅ Auto Recording set to: *${state}*`
            }, { quoted: fakevcard });
          } else {
            await socket.sendMessage(sender, {
              text: `Usage: ${config.PREFIX}autorecord [on/off]`
            }, { quoted: msg });
          }
          break;
        }

        case 'autogroup': {
          const state = args[0]?.toLowerCase();
          if (state === 'on' || state === 'off') {
            config.AUTO_JOIN_GROUP = state === 'on' ? 'true' : 'false';
            
            await socket.sendMessage(sender, {
              text: `✅ Auto Group Join set to: *${state}*`
            }, { quoted: fakevcard });
          } else {
            await socket.sendMessage(sender, {
              text: `Usage: ${config.PREFIX}autogroup [on/off]`
            }, { quoted: msg });
          }
          break;
        }

        // ============ DOWNLOAD COMMANDS ============
        case 'song': {
          const query = args.join(' ');
          if (!query) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}song [song name]` 
            }, { quoted: msg });
            break;
          }
          
          try {
            await socket.sendMessage(sender, { react: { text: "🎵", key: msg.key } });
            await socket.sendMessage(sender, { text: '*Searching for song...*' }, { quoted: fakevcard });
            
            const search = await yts(query);
            if (!search?.videos?.length) {
              await socket.sendMessage(sender, { text: '❌ No results found!' }, { quoted: fakevcard });
              break;
            }
            
            const video = search.videos[0];
            const api = `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`;
            const res = await axios.get(api, { timeout: 60000 });
            
            if (!res?.data?.result?.download) throw "API_FAILED";
            
            await socket.sendMessage(sender, {
              audio: { url: res.data.result.download },
              mimetype: "audio/mpeg",
              ptt: false
            }, { quoted: fakevcard });
            
            await socket.sendMessage(sender, {
              text: `✅ *${video.title}*\n⏱️ ${video.timestamp}`
            }, { quoted: fakevcard });
            
          } catch (err) {
            console.error("song error:", err);
            await socket.sendMessage(sender, { text: '❌ Failed to download song.' }, { quoted: fakevcard });
          }
          break;
        }

        case 'tiktok': {
          const url = args[0];
          if (!url || !url.includes("tiktok.com")) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}tiktok [tiktok url]` 
            }, { quoted: msg });
            break;
          }
          
          try {
            await socket.sendMessage(sender, { react: { text: "🎵", key: msg.key } });
            await socket.sendMessage(sender, { text: '*Downloading TikTok...*' }, { quoted: fakevcard });
            
            const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(apiUrl);
            
            if (!data.status || !data.data) {
              await socket.sendMessage(sender, { text: '❌ Failed to fetch TikTok.' }, { quoted: fakevcard });
              break;
            }
            
            const videoUrl = data.data.meta.media.find(v => v.type === "video").org;
            
            await socket.sendMessage(sender, {
              video: { url: videoUrl },
              caption: `✅ TikTok Download\n👤 ${data.data.author.nickname}\n👍 ${data.data.like}`
            }, { quoted: fakevcard });
            
          } catch (err) {
            console.error("tiktok error:", err);
            await socket.sendMessage(sender, { text: '❌ Failed to download TikTok.' }, { quoted: fakevcard });
          }
          break;
        }

        case 'mediafire': {
          const url = args[0];
          if (!url) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}mediafire [mediafire url]` 
            }, { quoted: msg });
            break;
          }
          
          try {
            await socket.sendMessage(sender, { react: { text: "📥", key: msg.key } });
            await socket.sendMessage(sender, { text: '*Fetching MediaFire file...*' }, { quoted: fakevcard });
            
            const api = `https://tharuzz-ofc-apis.vercel.app/api/download/mediafire?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            if (!data.success || !data.result) {
              await socket.sendMessage(sender, { text: '❌ Failed to fetch file.' }, { quoted: fakevcard });
              break;
            }
            
            await socket.sendMessage(sender, {
              document: { url: data.result.url },
              fileName: data.result.filename,
              caption: `📁 ${data.result.filename}\n📏 ${data.result.size}`
            }, { quoted: fakevcard });
            
          } catch (err) {
            console.error("mediafire error:", err);
            await socket.sendMessage(sender, { text: '❌ Failed to download file.' }, { quoted: fakevcard });
          }
          break;
        }

        // ============ AI COMMANDS ============
        case 'ai':
        case 'chat':
        case 'gpt': {
          const prompt = args.join(' ');
          if (!prompt) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}ai [your message]` 
            }, { quoted: msg });
            break;
          }
          
          try {
            await socket.sendMessage(sender, { react: { text: "🤖", key: msg.key } });
            await socket.sendMessage(sender, { text: '*AI thinking...*' }, { quoted: fakevcard });
            
            const apiUrl = `https://api.malvin.gleeze.com/ai/openai?text=${encodeURIComponent(prompt)}`;
            const response = await axios.get(apiUrl, { timeout: 30000 });
            
            const aiReply = response?.data?.result || response?.data?.response || 'No response from AI';
            
            await socket.sendMessage(sender, {
              text: aiReply,
              footer: "🤖 AI Response"
            }, { quoted: fakevcard });
            
          } catch (err) {
            console.error("AI error:", err);
            await socket.sendMessage(sender, { text: '❌ AI service unavailable.' }, { quoted: fakevcard });
          }
          break;
        }

        // ============ SESSION MANAGEMENT ============
        case 'deleteme': {
          const sanitized = number.replace(/[^0-9]/g, '');
          
          // Permission check
          if (!isOwner && senderNumber !== sanitized) {
            await socket.sendMessage(sender, { 
              text: '❌ Permission denied.' 
            }, { quoted: msg });
            break;
          }
          
          try {
            // Remove session
            await removeSessionFromFile(sanitized);
            
            // Cleanup temp
            const sessionPath = path.join(sessionsDir, `session_${sanitized}`);
            if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
            
            // Close socket
            try { socket.ws?.close(); } catch(e) {}
            activeSockets.delete(sanitized);
            socketCreationTime.delete(sanitized);
            
            await socket.sendMessage(sender, {
              text: '✅ Session deleted successfully!'
            }, { quoted: fakevcard });
            
          } catch (err) {
            console.error('deleteme error:', err);
            await socket.sendMessage(sender, { text: '❌ Failed to delete session.' }, { quoted: msg });
          }
          break;
        }

        case 'bots': {
          // Owner/admin only
          const admins = await loadAdminsFromFile();
          if (!isOwner && !admins.includes(senderNumber) && !admins.includes(nowsender)) {
            await socket.sendMessage(sender, { 
              text: '❌ Permission denied.' 
            }, { quoted: msg });
            break;
          }
          
          const activeCount = activeSockets.size;
          const activeNumbers = Array.from(activeSockets.keys());
          
          let text = `*🤖 Active Sessions*\n\n`;
          text += `📊 Total Active: ${activeCount}\n\n`;
          
          if (activeCount > 0) {
            text += `📱 Active Numbers:\n`;
            activeNumbers.forEach((num, index) => {
              text += `${index + 1}. ${num}\n`;
            });
          } else {
            text += `⚠️ No active sessions`;
          }
          
          await socket.sendMessage(sender, {
            text,
            footer: `🕒 ${getTimestamp()}`
          }, { quoted: fakevcard });
          break;
        }

        // ============ ADMIN MANAGEMENT ============
        case 'addadmin': {
          if (!isOwner) {
            await socket.sendMessage(sender, { 
              text: '❌ Owner only command.' 
            }, { quoted: msg });
            break;
          }
          
          const target = args[0];
          if (!target) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}addadmin [number]` 
            }, { quoted: msg });
            break;
          }
          
          await addAdminToFile(target);
          await socket.sendMessage(sender, {
            text: `✅ Admin added: ${target}`
          }, { quoted: fakevcard });
          break;
        }

        case 'removeadmin': {
          if (!isOwner) {
            await socket.sendMessage(sender, { 
              text: '❌ Owner only command.' 
            }, { quoted: msg });
            break;
          }
          
          const target = args[0];
          if (!target) {
            await socket.sendMessage(sender, { 
              text: `Usage: ${config.PREFIX}removeadmin [number]` 
            }, { quoted: msg });
            break;
          }
          
          await removeAdminFromFile(target);
          await socket.sendMessage(sender, {
            text: `✅ Admin removed: ${target}`
          }, { quoted: fakevcard });
          break;
        }

        case 'listadmins': {
          const admins = await loadAdminsFromFile();
          
          let text = `*👥 Admin List*\n\n`;
          if (admins.length > 0) {
            admins.forEach((admin, index) => {
              text += `${index + 1}. ${admin}\n`;
            });
          } else {
            text += `No admins added yet`;
          }
          
          await socket.sendMessage(sender, {
            text,
            footer: "👑 Admin Management"
          }, { quoted: fakevcard });
          break;
        }

        // ============ BOT STATUS ============
        case 'alive': {
          const userCfg = await loadUserConfigFromFile(number);
          const botName = userCfg.botName || config.BOT_NAME;
          const logo = userCfg.logo || config.LOGO_URL;
          
          const startTime = socketCreationTime.get(number) || Date.now();
          const uptime = Math.floor((Date.now() - startTime) / 1000);
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          
          const text = `
*🤖 ${botName} - ALIVE ✅*

╭─「 Status Details 」─➤  
│ 👤 Owner: ${config.OWNER_NAME}
│ ✏️ Prefix: ${config.PREFIX}
│ 🧬 Version: ${config.BOT_VERSION}
│ ⏰ Uptime: ${hours}h ${minutes}m ${seconds}s
│ 📊 Platform: ${process.platform}
╰──────●●➤

> ${botName}
`.trim();

          let imagePayload = String(logo).startsWith('http') ? { url: logo } : fs.readFileSync(logo);
          
          await socket.sendMessage(sender, {
            image: imagePayload,
            caption: text,
            footer: `✅ ${botName} is running`,
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 },
              { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: "⚡ Ping" }, type: 1 }
            ],
            headerType: 4
          }, { quoted: fakevcard });
          break;
        }

        case 'ping': {
          const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
          
          const text = `
*📡 Bot Ping*

◈ 🛠️ Latency: ${latency}ms
◈ 🕒 Server Time: ${new Date().toLocaleString()}
◈ 📊 Active Sessions: ${activeSockets.size}
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "🏓 Pong!",
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 Menu" }, type: 1 }
            ]
          }, { quoted: fakevcard });
          break;
        }

        // ============ RESTART ============
        case 'restart': {
          if (!isOwner) {
            await socket.sendMessage(sender, { 
              text: '❌ Owner only command.' 
            }, { quoted: msg });
            break;
          }
          
          await socket.sendMessage(sender, {
            text: '🔄 Restarting bot...'
          }, { quoted: fakevcard });
          
          setTimeout(() => {
            process.exit(0);
          }, 2000);
          break;
        }

        // ============ STATS ============
        case 'stats': {
          const userCfg = await loadUserConfigFromFile(number);
          const botName = userCfg.botName || config.BOT_NAME;
          
          const allNumbers = await getAllNumbersFromFile();
          const admins = await loadAdminsFromFile();
          const newsletters = await listNewslettersFromFile();
          
          const text = `
*📊 Bot Statistics*

🤖 Bot Name: ${botName}
👥 Registered Numbers: ${allNumbers.length}
👑 Admins: ${admins.length}
📰 Newsletters: ${newsletters.length}
⚡ Active Sessions: ${activeSockets.size}
🕒 Uptime: ${Math.floor((Date.now() - (socketCreationTime.get(number) || Date.now())) / 1000)}s
📅 Server Time: ${getTimestamp()}
`.trim();

          await socket.sendMessage(sender, {
            text,
            footer: "📈 Bot Statistics"
          }, { quoted: fakevcard });
          break;
        }

        // ============ DEFAULT ============
        default:
          // Unknown command
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      try {
        await socket.sendMessage(sender, {
          text: '❌ An error occurred while processing your command.'
        }, { quoted: fakevcard });
      } catch(e) {}
    }
  });
}

// ---------------- MESSAGE HANDLERS ----------------
function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
    
    if (config.AUTO_RECORDING === 'true') {
      try {
        await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
      } catch (e) {}
    }
  });
}

// ---------------- SESSION SETUP ----------------
async function setupBotSession(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(sessionsDir, `session_${sanitizedNumber}`);
  
  // Check if already active
  if (activeSockets.has(sanitizedNumber)) {
    if (!res.headersSent) res.send({ status: 'already_connected' });
    return;
  }
  
  // Load saved creds if any
  const savedCreds = await loadCredsFromFile(sanitizedNumber);
  if (savedCreds?.creds) {
    fs.ensureDirSync(sessionPath);
    fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(savedCreds.creds, null, 2));
    if (savedCreds.keys) {
      fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(savedCreds.keys, null, 2));
    }
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  
  try {
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, { level: 'silent' })
      },
      printQRInTerminal: false,
      logger: { level: 'silent' },
      browser: Browsers.macOS('Safari')
    });
    
    socketCreationTime.set(sanitizedNumber, Date.now());
    
    // Setup handlers
    setupStatusHandlers(socket);
    setupCommandHandlers(socket, sanitizedNumber);
    setupMessageHandlers(socket);
    
    // Request pairing code if not registered
    if (!socket.authState.creds.registered) {
      try {
        const code = await socket.requestPairingCode(sanitizedNumber);
        if (!res.headersSent) res.send({ code });
      } catch (error) {
        if (!res.headersSent) res.status(500).send({ error: 'Failed to get pairing code' });
      }
    } else {
      if (!res.headersSent) res.send({ status: 'already_registered' });
    }
    
    // Save creds when updated
    socket.ev.on('creds.update', async () => {
      await saveCreds();
      const fileContent = fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf8');
      const credsObj = JSON.parse(fileContent);
      await saveCredsToFile(sanitizedNumber, credsObj, state.keys || null);
    });
    
    // Connection updates
    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      
      if (connection === 'open') {
        try {
          await delay(2000);
          
          // Add to active sockets
          activeSockets.set(sanitizedNumber, socket);
          
          // Add to numbers list
          await addNumberToFile(sanitizedNumber);
          
          // Join group if enabled
          const groupResult = await joinGroup(socket);
          
          // Load user config
          const userCfg = await loadUserConfigFromFile(sanitizedNumber);
          const botName = userCfg.botName || config.BOT_NAME;
          const logo = userCfg.logo || config.LOGO_URL;
          
          // Send welcome message
          const userJid = jidNormalizedUser(socket.user.id);
          const welcomeText = `
*✅ Connected Successfully!*

🤖 Bot: ${botName}
📞 Number: ${sanitizedNumber}
📊 Status: Connected & Active
🕒 Time: ${getTimestamp()}
${groupResult.status === 'success' ? '✅ Joined group successfully!' : ''}
${groupResult.status === 'failed' ? '⚠️ Could not join group' : ''}

Type ${config.PREFIX}menu to see all commands!
`;
          
          try {
            if (String(logo).startsWith('http')) {
              await socket.sendMessage(userJid, {
                image: { url: logo },
                caption: welcomeText
              });
            } else {
              await socket.sendMessage(userJid, {
                text: welcomeText
              });
            }
          } catch (e) {
            await socket.sendMessage(userJid, {
              text: welcomeText
            });
          }
          
          console.log(`✅ Bot connected: ${sanitizedNumber}`);
          
        } catch (e) {
          console.error('Connection open error:', e);
        }
      }
      
      if (connection === 'close') {
        // Cleanup on disconnect
        try {
          if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
          }
        } catch(e) {}
        
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        
        console.log(`❌ Bot disconnected: ${sanitizedNumber}`);
      }
    });
    
    // Auto-restart on logout
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 401) {
          // Logged out, cleanup
          await removeSessionFromFile(sanitizedNumber);
          activeSockets.delete(sanitizedNumber);
          socketCreationTime.delete(sanitizedNumber);
        }
      }
    });
    
  } catch (error) {
    console.error('Session setup error:', error);
    if (!res.headersSent) res.status(500).send({ error: 'Failed to setup session' });
  }
}

// ---------------- API ROUTES ----------------
router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter required' });
  await setupBotSession(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({
    botName: config.BOT_NAME,
    count: activeSockets.size,
    numbers: Array.from(activeSockets.keys()),
    timestamp: getTimestamp()
  });
});

router.get('/ping', (req, res) => {
  res.status(200).send({
    status: 'active',
    botName: config.BOT_NAME,
    message: 'Bot is running',
    activeSessions: activeSockets.size
  });
});

// Admin API routes
router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  await addAdminToFile(jid);
  res.status(200).send({ status: 'ok', jid });
});

router.post('/admin/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  await removeAdminFromFile(jid);
  res.status(200).send({ status: 'ok', jid });
});

router.get('/admin/list', async (req, res) => {
  const list = await loadAdminsFromFile();
  res.status(200).send({ status: 'ok', admins: list });
});

// Newsletter API routes
router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  await addNewsletterToFile(jid, emojis || []);
  res.status(200).send({ status: 'ok', jid });
});

router.post('/newsletter/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  await removeNewsletterFromFile(jid);
  res.status(200).send({ status: 'ok', jid });
});

router.get('/newsletter/list', async (req, res) => {
  const list = await listNewslettersFromFile();
  res.status(200).send({ status: 'ok', channels: list });
});

// Session management API
router.get('/api/sessions', async (req, res) => {
  const data = readJSON(sessionFiles.sessions);
  const sessions = Object.entries(data).map(([number, info]) => ({
    number,
    updatedAt: info.updatedAt
  }));
  res.json({ ok: true, sessions });
});

router.get('/api/active', (req, res) => {
  const keys = Array.from(activeSockets.keys());
  res.json({ ok: true, active: keys, count: keys.length });
});

router.post('/api/session/delete', async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  
  const sanitized = number.replace(/[^0-9]/g, '');
  const running = activeSockets.get(sanitized);
  
  if (running) {
    try { running.ws?.close(); } catch(e) {}
    activeSockets.delete(sanitized);
    socketCreationTime.delete(sanitized);
  }
  
  await removeSessionFromFile(sanitized);
  
  const sessionPath = path.join(sessionsDir, `session_${sanitized}`);
  if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
  
  res.json({ ok: true, message: `Session ${sanitized} removed` });
});

// Auto-reconnect on startup
(async () => {
  try {
    const numbers = await getAllNumbersFromFile();
    for (const number of numbers) {
      if (!activeSockets.has(number)) {
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        await setupBotSession(number, mockRes);
        await delay(1000);
      }
    }
  } catch(e) {
    console.error('Auto-reconnect error:', e);
  }
})();

module.exports = router;