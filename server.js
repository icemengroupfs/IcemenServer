const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
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

// WhatsApp Message Handler - UPDATED WITH PROPER LOGGER
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
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
    });

    // Handle connection updates
    whatsappSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Handle QR code generation
      if (qr) {
        qrCode = qr;
        console.log('📱 WhatsApp QR Code received - scan with your phone');
        qrcode.generate(qr, { small: true });
        console.log(`🔗 Or visit: http://localhost:${PORT}/whatsapp/qr`);
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log(`⚠️ WhatsApp connection closed due to ${lastDisconnect?.error?.message || 'unknown reason'}, reconnecting ${shouldReconnect}`);
        
        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 5000);
        } else {
          isWhatsAppConnected = false;
          console.log('❌ WhatsApp logged out, please scan QR code again');
        }
      } else if (connection === 'open') {
        isWhatsAppConnected = true;
        qrCode = null;
        console.log('✅ WhatsApp connected successfully!');
      }
    });

    // Save credentials whenever they're updated
    whatsappSocket.ev.on('creds.update', saveCreds);

    // Handle incoming WhatsApp messages
    whatsappSocket.ev.on('messages.upsert', async (m) => {
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
    });

  } catch (error) {
    console.error('❌ Error connecting to WhatsApp:', error);
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
  if (isWhatsAppConnected) {
    return res.json({
      success: true,
      status: 'connected',
      message: 'WhatsApp is already connected'
    });
  }

  if (qrCode) {
    // Return QR code as SVG for web display
    qrcode.toString(qrCode, { type: 'svg' }, (err, svg) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: 'Failed to generate QR code'
        });
      }
      
      res.set('Content-Type', 'image/svg+xml');
      res.send(`
        <div style="text-align: center; font-family: Arial, sans-serif;">
          <h2>Scan WhatsApp QR Code</h2>
          ${svg}
          <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
          <p>Status: Waiting for scan...</p>
        </div>
      `);
    });
  } else {
    res.json({
      success: false,
      status: 'initializing',
      message: 'QR code not generated yet, please try again in a few seconds'
    });
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
    status: isWhatsAppConnected ? 'connected' : 'disconnected',
    qrAvailable: !!qrCode
  });
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
    whatsappStatus: isWhatsAppConnected ? 'connected' : 'disconnected'
  });
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
        'GET /whatsapp/status': 'Check WhatsApp connection status'
      },
      'GET /health': 'Health check'
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
    // Initialize WhatsApp connection
    await connectToWhatsApp();
    
    app.listen(PORT, () => {
      console.log('\n🚀 ========================================');
      console.log(`🚀 Dual SMS/WhatsApp Server running on port ${PORT}`);
      console.log(`📱 Twilio Number: ${process.env.TWILIO_NUMBER || '⚠️ NOT CONFIGURED'}`);
      console.log(`🤖 WhatsApp Status: ${isWhatsAppConnected ? '✅ Connected' : '⏳ Waiting for QR scan'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🔗 WhatsApp QR: http://localhost:${PORT}/whatsapp/qr`);
      console.log('🚀 ========================================\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();