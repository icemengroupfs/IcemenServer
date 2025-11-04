const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Input validation function
function validatePhoneNumber(phone) {
  // Basic phone validation - you can enhance this as needed
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
}

function validateMessage(message) {
  return message && message.trim().length > 0 && message.length <= 1600;
}

// POST /send-sms endpoint
app.post('/send-sms', async (req, res) => {
  try {
    const { to, message } = req.body;

    // Input validation
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: "to" and "message" are required'
      });
    }

    // Validate phone number(s)
    const recipients = Array.isArray(to) ? to : [to];
    const invalidNumbers = recipients.filter(num => !validatePhoneNumber(num));
    
    if (invalidNumbers.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid phone number(s): ${invalidNumbers.join(', ')}`
      });
    }

    // Validate message
    if (!validateMessage(message)) {
      return res.status(400).json({
        success: false,
        error: 'Message must be non-empty and less than 1600 characters'
      });
    }

    // Send SMS to all recipients
    const results = [];
    for (const recipient of recipients) {
      try {
        const twilioResponse = await client.messages.create({
          body: message,
          to: recipient,
          from: process.env.TWILIO_NUMBER,
          // Alternatively, you can use MessagingServiceSid instead of from:
          // messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID
        });

        // Log successful message
        console.log(`✅ SMS sent to ${recipient}:`, {
          sid: twilioResponse.sid,
          status: twilioResponse.status,
          dateSent: twilioResponse.dateCreated,
          body: message
        });

        results.push({
          to: recipient,
          success: true,
          sid: twilioResponse.sid,
          status: twilioResponse.status
        });
      } catch (error) {
        console.error(`❌ Failed to send SMS to ${recipient}:`, error.message);

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
      return res.status(500).json({
        success: false,
        error: 'Failed to send SMS to all recipients',
        details: results
      });
    }

    // Check if some messages failed
    const someFailed = results.some(result => !result.success);
    if (someFailed) {
      return res.status(207).json({ // 207 Multi-Status
        success: true,
        message: 'Some messages failed to send',
        results: results
      });
    }

    // All messages successful
    res.json({
      success: true,
      message: recipients.length > 1 ? 'All messages sent successfully' : 'Message sent successfully',
      results: results
    });

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// GET /messages endpoint
app.get('/messages', async (req, res) => {
  try {
    // Fetch the last 20 messages sent
    const messages = await client.messages.list({
      limit: 20,
      to: undefined // Remove this filter to get all messages
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
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Twilio Number: ${process.env.TWILIO_NUMBER || 'Not configured'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});