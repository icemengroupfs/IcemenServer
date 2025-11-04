const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
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
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_NUMBER)
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Twilio SMS Server is running!',
    endpoints: {
      'POST /send-sms': 'Send an SMS message',
      'GET /messages': 'Get last 20 messages',
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

// Start server
app.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Twilio Number: ${process.env.TWILIO_NUMBER || '⚠️ NOT CONFIGURED'}`);
  console.log(`🔑 Twilio SID: ${process.env.TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔑 Twilio Token: ${process.env.TWILIO_AUTH_TOKEN ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log('🚀 ========================================\n');
});