const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// WhatsApp Bot State
let whatsappSocket = null;
let isWhatsAppConnected = false;
let qrCode = null;
let connectionError = null;
let isConnecting = false;

// WhatsApp Message Handler - UPDATED WITH PROPER LOGGER
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⏳ WhatsApp connection already in progress...');
    return;
  }

  isConnecting = true;
  connectionError = null;

  try {
    console.log('🔄 Initializing WhatsApp connection...');
    
    // Create auth state directory if it doesn't exist
    const authDir = './baileys_auth_info';
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
      console.log('📁 Created auth directory:', authDir);
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`📦 Using Baileys version: ${version.join('.')}`);
    
    // Create a proper logger that Baileys expects
    const logger = {
      level: 'silent',
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger // Return itself for child loggers
    };

    // Updated socket configuration for new Baileys version
    whatsappSocket = makeWASocket({
      version,
      logger: logger,
      auth: {
        creds: state.creds,
        keys: state.keys,
      },
      browser: ['Baileys Bot', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000, // 60 seconds timeout
    });

    isConnecting = false;

    // Handle connection updates
    whatsappSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Handle QR code generation
      if (qr) {
        qrCode = qr;
        console.log('📱 WhatsApp QR Code received - scan with your phone');
        qrcode.generate(qr, { small: true });
        console.log(`🔗 Visit /whatsapp/qr to scan`);
      }

      if (connection === 'close') {
        isWhatsAppConnected = false;
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        const errorMsg = lastDisconnect?.error?.message || 'unknown reason';
        console.log(`⚠️ WhatsApp connection closed due to ${errorMsg}, reconnecting ${shouldReconnect}`);
        
        if (shouldReconnect) {
          connectionError = errorMsg;
          setTimeout(() => connectToWhatsApp(), 5000);
        } else {
          connectionError = 'Logged out - please scan QR code again';
          console.log('❌ WhatsApp logged out, please scan QR code again');
          qrCode = null; // Clear old QR
        }
      } else if (connection === 'open') {
        isWhatsAppConnected = true;
        qrCode = null;
        connectionError = null;
        console.log('✅ WhatsApp connected successfully!');
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
      }
    });

    // Save credentials whenever they're updated
    whatsappSocket.ev.on('creds.update', saveCreds);

    // Handle incoming WhatsApp messages
    whatsappSocket.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        
        // Only process messages that are not from the bot itself and are not status updates
        if (message.key.fromMe || !message.message || message.message.protocolMessage) return;

        const messageText = getMessageText(message);
        console.log('📱 New WhatsApp message:', {
          from: message.key.remoteJid,
          message: messageText,
          timestamp: new Date(message.messageTimestamp * 1000).toISOString()
        });

        // Forward to your n8n webhook or process here
        if (process.env.N8N_WEBHOOK_URL) {
          await forwardToN8n(message);
        }

        // Auto-reply example
        await handleIncomingMessage(message);
      } catch (error) {
        console.error('❌ Error processing WhatsApp message:', error);
      }
    });

  } catch (error) {
    isConnecting = false;
    connectionError = error.message;
    console.error('❌ Error connecting to WhatsApp:', error.message);
    console.error('Stack:', error.stack);
    // Retry after 10 seconds
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

// Helper function to extract message text from different message types
function getMessageText(message) {
  if (message.message?.conversation) {
    return message.message.conversation;
  }
  if (message.message?.extendedTextMessage?.text) {
    return message.message.extendedTextMessage.text;
  }
  if (message.message?.imageMessage?.caption) {
    return message.message.imageMessage.caption;
  }
  if (message.message?.videoMessage?.caption) {
    return message.message.videoMessage.caption;
  }
  if (message.message?.documentMessage?.caption) {
    return message.message.documentMessage.caption;
  }
  return 'Unsupported message type';
}

// Forward message to n8n
async function forwardToN8n(message) {
  try {
    const messageText = getMessageText(message);
    const payload = {
      platform: 'whatsapp',
      from: message.key.remoteJid,
      message: messageText,
      timestamp: new Date(message.messageTimestamp * 1000).toISOString(),
      messageId: message.key.id
    };

    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('✅ Message forwarded to n8n');
    }
  } catch (error) {
    console.error('❌ Error forwarding to n8n:', error);
  }
}

// Handle incoming WhatsApp messages
async function handleIncomingMessage(message) {
  const jid = message.key.remoteJid;
  const text = getMessageText(message).toLowerCase() || '';

  try {
    // Simple auto-reply logic
    if (text.includes('hello') || text.includes('hi') || text.includes('hola')) {
      await sendWhatsAppMessage(jid, 'Hello! 👋 Thanks for messaging us. How can I help you today?');
    } else if (text.includes('help')) {
      await sendWhatsAppMessage(jid, 'I can help you with:\n• Order information\n• Support requests\n• General inquiries\n\nType "agent" to speak with a human.');
    } else if (text.includes('agent')) {
      await sendWhatsAppMessage(jid, 'A human agent will contact you shortly. Please wait...');
      // Here you can trigger email/notification to owner
    } else if (text.includes('order') || text.includes('price') || text.includes('cost')) {
      await sendWhatsAppMessage(jid, 'For order and pricing information, please visit our website or type "agent" to speak with a sales representative.');
    } else {
      await sendWhatsAppMessage(jid, 'Thanks for your message! Our team will get back to you soon.');
    }
  } catch (error) {
    console.error('❌ Error handling WhatsApp message:', error);
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(jid, text) {
  if (!whatsappSocket || !isWhatsAppConnected) {
    throw new Error('WhatsApp is not connected');
  }

  try {
    await whatsappSocket.sendMessage(jid, { text: text });
    console.log(`✅ WhatsApp message sent to ${jid}`);
    return true;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error);
    throw error;
  }
}

// ========== WHATSAPP ENDPOINTS ==========

// GET /whatsapp/qr - Get QR code for WhatsApp connection
app.get('/whatsapp/qr', (req, res) => {
  // Set timeout to prevent infinite loading
  res.setTimeout(30000);

  if (isWhatsAppConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WhatsApp Connected</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { color: #25d366; font-size: 48px; margin-bottom: 20px; }
            h2 { color: #333; }
            .status { background: #d4edda; color: #155724; padding: 15px; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅</div>
            <h2>WhatsApp Connected!</h2>
            <p>Your WhatsApp is already connected and ready to send messages.</p>
            <div class="status">Status: Active Connection</div>
            <p style="margin-top: 30px; color: #666;">
              <a href="/whatsapp/status" style="color: #25d366;">Check Status</a> | 
              <a href="/" style="color: #25d366;">API Docs</a>
            </p>
          </div>
        </body>
      </html>
    `);
  }

  if (connectionError) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WhatsApp Connection Error</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .error { color: #dc3545; font-size: 48px; margin-bottom: 20px; }
            .error-msg { background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; margin-top: 20px; }
            button { background: #25d366; color: white; border: none; padding: 12px 30px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 20px; }
            button:hover { background: #128c7e; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">❌</div>
            <h2>Connection Error</h2>
            <p>There was a problem connecting to WhatsApp:</p>
            <div class="error-msg">${connectionError}</div>
            <button onclick="location.reload()">🔄 Retry Connection</button>
            <p style="margin-top: 30px; color: #666;">
              <a href="/whatsapp/status" style="color: #25d366;">Check Status</a>
            </p>
          </div>
        </body>
      </html>
    `);
  }

  if (qrCode) {
    // Return QR code as SVG for web display
    qrcode.toString(qrCode, { type: 'svg' }, (err, svg) => {
      if (err) {
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>QR Code Error</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
              </style>
            </head>
            <body>
              <div class="container">
                <h2>Failed to generate QR code</h2>
                <p style="color: red;">${err.message}</p>
                <button onclick="location.reload()" style="background: #25d366; color: white; border: none; padding: 12px 30px; border-radius: 5px; cursor: pointer;">Retry</button>
              </div>
            </body>
          </html>
        `);
      }
      
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp QR Code</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f0f2f5; }
              .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              h2 { color: #333; margin-bottom: 10px; }
              .qr-container { margin: 30px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; }
              .instructions { text-align: left; margin: 20px 0; padding: 20px; background: #e7f3ff; border-left: 4px solid #2196F3; border-radius: 5px; }
              .instructions ol { margin: 10px 0; padding-left: 20px; }
              .instructions li { margin: 8px 0; }
              .status { display: inline-block; padding: 8px 16px; background: #fff3cd; color: #856404; border-radius: 20px; font-size: 14px; margin-top: 20px; }
              .loading { display: inline-block; width: 12px; height: 12px; border: 2px solid #856404; border-radius: 50%; border-top-color: transparent; animation: spin 1s linear infinite; margin-left: 8px; }
              @keyframes spin { to { transform: rotate(360deg); } }
              .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 14px; }
              button { background: #25d366; color: white; border: none; padding: 12px 30px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 10px; }
              button:hover { background: #128c7e; }
            </style>
            <script>
              // Auto-refresh every 10 seconds to check connection status
              let refreshCount = 0;
              const maxRefreshes = 30; // Stop after 5 minutes (30 * 10s)
              
              setInterval(() => {
                refreshCount++;
                if (refreshCount < maxRefreshes) {
                  fetch('/whatsapp/status')
                    .then(r => r.json())
                    .then(data => {
                      if (data.connected) {
                        location.reload();
                      }
                    });
                }
              }, 10000);
            </script>
          </head>
          <body>
            <div class="container">
              <h2>📱 Scan WhatsApp QR Code</h2>
              <p style="color: #666;">Connect your WhatsApp account to start sending messages</p>
              
              <div class="qr-container">
                ${svg}
              </div>
              
              <div class="instructions">
                <strong>How to connect:</strong>
                <ol>
                  <li>Open <strong>WhatsApp</strong> on your phone</li>
                  <li>Tap <strong>Menu</strong> (⋮) or <strong>Settings</strong></li>
                  <li>Select <strong>Linked Devices</strong></li>
                  <li>Tap <strong>Link a Device</strong></li>
                  <li>Point your phone at this screen to scan the code</li>
                </ol>
              </div>
              
              <div class="status">
                ⏳ Waiting for scan<span class="loading"></span>
              </div>
              
              <div>
                <button onclick="location.reload()">🔄 Refresh QR Code</button>
              </div>
              
              <div class="footer">
                This page will automatically update when connected<br>
                <a href="/whatsapp/status" style="color: #25d366;">Check Connection Status</a>
              </div>
            </div>
          </body>
        </html>
      `);
    });
  } else {
    // QR code not yet generated
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="refresh" content="3">
          <title>Initializing WhatsApp</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .spinner { width: 50px; height: 50px; border: 5px solid #f3f3f3; border-top: 5px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .status { background: #fff3cd; color: #856404; padding: 15px; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="spinner"></div>
            <h2>Initializing WhatsApp Connection</h2>
            <p>Please wait while we generate your QR code...</p>
            <div class="status">
              ${isConnecting ? 'Connecting to WhatsApp servers...' : 'Starting connection process...'}
            </div>
            <p style="margin-top: 20px; color: #666; font-size: 14px;">This page will refresh automatically</p>
          </div>
        </body>
      </html>
    `);
  }
});

// POST /whatsapp/send - Send WhatsApp message
app.post('/whatsapp/send', async (req, res) => {
  const requestId = Date.now();
  console.log(`\n📱 [${requestId}] NEW WHATSAPP MESSAGE REQUEST`);
  
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: "to" and "message" are required'
      });
    }

    if (!isWhatsAppConnected) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp is not connected. Please scan QR code first at /whatsapp/qr'
      });
    }

    // Ensure phone number has @s.whatsapp.net suffix
    const formattedTo = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    await sendWhatsAppMessage(formattedTo, message);
    
    res.json({
      success: true,
      message: 'WhatsApp message sent successfully',
      to: formattedTo
    });

  } catch (error) {
    console.error(`❌ [${requestId}] Error sending WhatsApp message:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to send WhatsApp message: ' + error.message
    });
  }
});

// GET /whatsapp/status - Check WhatsApp connection status
app.get('/whatsapp/status', (req, res) => {
  res.json({
    success: true,
    connected: isWhatsAppConnected,
    status: isWhatsAppConnected ? 'connected' : (isConnecting ? 'connecting' : 'disconnected'),
    qrAvailable: !!qrCode,
    error: connectionError,
    timestamp: new Date().toISOString()
  });
});

// POST /whatsapp/reconnect - Manually trigger WhatsApp reconnection
app.post('/whatsapp/reconnect', async (req, res) => {
  console.log('🔄 Manual reconnection requested');
  
  if (isWhatsAppConnected) {
    return res.json({
      success: true,
      message: 'WhatsApp is already connected'
    });
  }

  if (isConnecting) {
    return res.json({
      success: false,
      message: 'Connection already in progress, please wait...'
    });
  }

  try {
    // Reset state
    qrCode = null;
    connectionError = null;
    
    // Trigger connection
    connectToWhatsApp();
    
    res.json({
      success: true,
      message: 'WhatsApp reconnection initiated. Check /whatsapp/qr for QR code.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== EXISTING TWILIO ENDPOINTS ==========

// Input validation function
function validatePhoneNumber(phone) {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
}

function validateMessage(message) {
  return message && message.trim().length > 0 && message.length <= 1600;
}

// POST /send-sms endpoint
app.post('/send-sms', async (req, res) => {
  const requestId = Date.now();
  console.log(`\n🔵 [${requestId}] NEW SMS REQUEST`);
  
  try {
    const { to, message } = req.body;
    console.log(`📋 [${requestId}] Request details:`, { to, messageLength: message?.length });

    // Input validation
    if (!to || !message) {
      console.log(`❌ [${requestId}] Validation failed: Missing required fields`);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: "to" and "message" are required'
      });
    }

    // Validate phone number(s)
    const recipients = Array.isArray(to) ? to : [to];
    const invalidNumbers = recipients.filter(num => !validatePhoneNumber(num));
    
    if (invalidNumbers.length > 0) {
      console.log(`❌ [${requestId}] Invalid phone numbers:`, invalidNumbers);
      return res.status(400).json({
        success: false,
        error: `Invalid phone number(s): ${invalidNumbers.join(', ')}`
      });
    }

    // Validate message
    if (!validateMessage(message)) {
      console.log(`❌ [${requestId}] Invalid message: Empty or too long`);
      return res.status(400).json({
        success: false,
        error: 'Message must be non-empty and less than 1600 characters'
      });
    }

    console.log(`✅ [${requestId}] Validation passed. Sending to ${recipients.length} recipient(s)...`);

    // Send SMS to all recipients
    const results = [];
    for (const recipient of recipients) {
      try {
        console.log(`📤 [${requestId}] Sending SMS to ${recipient}...`);
        
        const twilioResponse = await client.messages.create({
          body: message,
          to: recipient,
          from: process.env.TWILIO_NUMBER,
        });

        console.log(`✅ [${requestId}] SMS sent to ${recipient}:`, {
          sid: twilioResponse.sid,
          status: twilioResponse.status,
          dateSent: twilioResponse.dateCreated
        });

        results.push({
          to: recipient,
          success: true,
          sid: twilioResponse.sid,
          status: twilioResponse.status
        });
      } catch (error) {
        console.error(`❌ [${requestId}] Failed to send SMS to ${recipient}:`, {
          error: error.message,
          code: error.code,
          status: error.status
        });

        results.push({
          to: recipient,
          success: false,
          error: error.message
        });
      }
    }

    // Check if all messages failed
    const allFailed = results.every(result => !result.success);
    if (allFailed) {
      console.log(`❌ [${requestId}] All messages failed`);
      return res.status(500).json({
        success: false,
        error: 'Failed to send SMS to all recipients',
        details: results
      });
    }

    // Check if some messages failed
    const someFailed = results.some(result => !result.success);
    if (someFailed) {
      console.log(`⚠️ [${requestId}] Some messages failed`);
      return res.status(207).json({
        success: true,
        message: 'Some messages failed to send',
        results: results
      });
    }

    // All messages successful
    console.log(`✅ [${requestId}] All messages sent successfully`);
    res.json({
      success: true,
      message: recipients.length > 1 ? 'All messages sent successfully' : 'Message sent successfully',
      results: results
    });

  } catch (error) {
    console.error(`❌ [${requestId}] Unexpected error:`, {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// GET /messages endpoint
app.get('/messages', async (req, res) => {
  console.log('\n📋 Fetching message history...');
  try {
    const messages = await client.messages.list({
      limit: 20
    });

    const formattedMessages = messages.map(msg => ({
      sid: msg.sid,
      to: msg.to,
      body: msg.body,
      status: msg.status,
      dateSent: msg.dateSent,
      from: msg.from,
      direction: msg.direction
    }));

    console.log(`✅ Retrieved ${formattedMessages.length} messages`);
    res.json({
      success: true,
      messages: formattedMessages
    });

  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch messages: ' + error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('💚 Health check');
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_NUMBER),
    whatsappStatus: isWhatsAppConnected ? 'connected' : (isConnecting ? 'connecting' : 'disconnected'),
    whatsappError: connectionError || null
  });
});

// Simple ping endpoint for monitoring
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Dual SMS/WhatsApp Server is running!',
    endpoints: {
      'SMS': {
        'POST /send-sms': 'Send SMS via Twilio',
        'GET /messages': 'Get last 20 SMS messages'
      },
      'WhatsApp': {
        'GET /whatsapp/qr': 'Get QR code for WhatsApp connection',
        'POST /whatsapp/send': 'Send WhatsApp message',
        'GET /whatsapp/status': 'Check WhatsApp connection status',
        'POST /whatsapp/reconnect': 'Manually trigger WhatsApp reconnection'
      },
      'GET /health': 'Health check'
    },
    currentStatus: {
      whatsappConnected: isWhatsAppConnected,
      whatsappConnecting: isConnecting,
      qrAvailable: !!qrCode,
      hasError: !!connectionError
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server and initialize WhatsApp
async function startServer() {
  try {
    // Start Express server FIRST (so it can respond to health checks)
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n🚀 ========================================');
      console.log(`🚀 Dual SMS/WhatsApp Server running on port ${PORT}`);
      console.log(`📱 Twilio Number: ${process.env.TWILIO_NUMBER || '⚠️ NOT CONFIGURED'}`);
      console.log(`🤖 WhatsApp Status: Initializing...`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🔗 WhatsApp QR: http://localhost:${PORT}/whatsapp/qr`);
      console.log('🚀 ========================================\n');
      
      // Initialize WhatsApp connection AFTER server is running
      // Don't await - let it run in background
      connectToWhatsApp().catch(err => {
        console.error('❌ WhatsApp initialization error:', err);
        connectionError = err.message;
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - keep server running
});

startServer();