const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const terminalQR = require('qrcode-terminal');
const webQR = require('qrcode');
const pino = require('pino');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURATION ==========
const GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwd8juhd2QyCd0ElkyxMMKw4GYOV21a0hJYUl8mMuG65FQKuTopYcjN9BW-Suu7oKuDKA/exec";

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ========== TWILIO CLIENT ==========
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ========== WHATSAPP AUTOMATION SYSTEM ==========

// Global variables
let whatsappSocket = null;
let isWhatsAppConnected = false;
let qrCode = null;
let connectionError = null;
let isConnecting = false;
let connectionRetries = 0;
const MAX_CONNECTION_RETRIES = 5;

// ========== CUSTOMER TRACKING & ORDER PROCESSING ==========

// Store active orders and customer history in memory
const activeOrders = new Map();
const customerHistory = new Map(); // Track customer order history

// Enhanced Bethlehem delivery validation with more comprehensive area coverage
const BETHLEHEM_KEYWORDS = [
  'bethlehem', 'free state', 'fs', '9700', '9701', '9702', '9703', '9704', '9705', '9706', '9707', '9708', '9709',
  'mlangeni', 'old location', 'bohlokong', 'cbd', 'central', 'boitumelo', 'reitz', 'ficksburg', 'clarens', 'fouriesburg',
  'rosendal', 'paul roux', 'senekal', 'marquard', 'ventersburg', 'winburg', 'brandfort', 'welkom', 'kroonstad', 'harrismith'
];
const NON_DELIVERY_AREAS = [
  'johannesburg', 'jhb', 'pretoria', 'pta', 'durban', 'cpt', 'cape town', 'bloemfontein', 'bloem', 'gauteng', 
  'kwazulu', 'kzn', 'western cape', 'eastern cape', 'mpumalanga', 'limpopo', 'north west', 'namibia', 'botswana',
  'lesotho', 'swaziland', 'eswatini', 'port elizabeth', 'east london', 'kimberley', 'rustenburg', 'nelspruit', 'polokwane'
];

class OrderManager {
  static startOrder(phone, name) {
    const order = {
      phone: phone,
      name: name,
      step: 'quantity',
      quantity: null,
      address: null,
      instructions: null,
      location: null,
      orderId: this.generateOrderId(),
      createdAt: new Date(),
      isReturningCustomer: this.isReturningCustomer(phone)
    };
    
    activeOrders.set(phone, order);
    return order;
  }

  static getOrder(phone) {
    return activeOrders.get(phone);
  }

  static updateOrder(phone, updates) {
    const order = activeOrders.get(phone);
    if (order) {
      Object.assign(order, updates);
      activeOrders.set(phone, order);
      return order;
    }
    return null;
  }

  static completeOrder(phone) {
    const order = activeOrders.get(phone);
    if (order) {
      // Add to customer history
      this.addToCustomerHistory(phone, order);
      activeOrders.delete(phone);
      return order;
    }
    return null;
  }

  static generateOrderId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 5);
    return `ICE-${timestamp}-${random}`.toUpperCase();
  }

  static isReturningCustomer(phone) {
    return customerHistory.has(phone);
  }

  static addToCustomerHistory(phone, order) {
    if (!customerHistory.has(phone)) {
      customerHistory.set(phone, {
        firstOrder: new Date(),
        lastOrder: new Date(),
        totalOrders: 0,
        totalSpent: 0
      });
    }
    
    const history = customerHistory.get(phone);
    history.lastOrder = new Date();
    history.totalOrders += 1;
    history.totalSpent += (order.quantity * 8) + 15;
  }

  static getCustomerGreeting(phone, name) {
    if (this.isReturningCustomer(phone)) {
      const history = customerHistory.get(phone);
      return `👋 Welcome back, ${name}! 🧊\n\nGreat to see you again! Ready for more refreshing ice?`;
    } else {
      return `🧊 Hello ${name}! Welcome to Ice Men! ❄️\n\nI'm here to help you order premium ice with quick delivery.`;
    }
  }

  // Enhanced location validation with comprehensive geocoding
  static async validateDeliveryArea(address, coordinates = null) {
    if (!address && !coordinates) {
      return { valid: false, reason: 'no_location', message: 'Please provide your delivery address or location.' };
    }
    
    let addressText = address || '';
    let detailedLocation = null;
    
    // If we have coordinates, try to geocode them for detailed address
    if (coordinates && !address) {
      try {
        const geocodedData = await this.reverseGeocodeWithOSM(coordinates.lat, coordinates.lng);
        if (geocodedData) {
          addressText = geocodedData.display_name;
          detailedLocation = geocodedData;
        }
      } catch (error) {
        console.error('Geocoding error:', error);
      }
    }
    
    // If we have address text but no coordinates, try forward geocoding
    if (address && !coordinates) {
      try {
        const geocodedData = await this.forwardGeocodeWithOSM(address);
        if (geocodedData && geocodedData.length > 0) {
          detailedLocation = geocodedData[0];
          // Use the detailed address from geocoding
          addressText = detailedLocation.display_name;
        }
      } catch (error) {
        console.error('Forward geocoding error:', error);
      }
    }
    
    const addressLower = addressText.toLowerCase();
    
    // Enhanced validation: Check if it's clearly outside delivery area
    const isNonDeliveryArea = NON_DELIVERY_AREAS.some(area => 
      addressLower.includes(area.toLowerCase())
    );
    
    if (isNonDeliveryArea) {
      return { 
        valid: false, 
        reason: 'outside_area',
        message: `🚫 *Delivery Area Notice*\n\nWe currently only deliver within *Bethlehem, Free State* and surrounding areas.\n\nYour location appears to be outside our delivery zone.\n\n📍 *Walk-in Store:*\n496 Mlangeni St, Old Location, Bethlehem, 9701\n\n📱 *Contact Us:*\n063 138 8803 (Andile)\n067 293 9603 (Kutlwano) \n081 287 3600 (Tony)\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/\n\nPlease contact us for bulk orders or alternative arrangements.`
      };
    }
    
    // Enhanced validation: Check if it's in Bethlehem area with more comprehensive matching
    const isInBethlehem = this.checkBethlehemArea(addressText, detailedLocation);
    
    if (isInBethlehem.valid) {
      return { 
        valid: true, 
        reason: 'bethlehem_area', 
        address: addressText,
        areaType: isInBethlehem.areaType
      };
    }
    
    // If unsure, ask for clarification with enhanced messaging
    return { 
      valid: false, 
      reason: 'unclear_location',
      message: `📍 *Location Check*\n\nWe need to confirm your delivery area. Please specify that you're in *Bethlehem, Free State* or let us know your exact location so we can check if delivery is available in your area.\n\n📍 *Walk-in Store:*\n496 Mlangeni St, Old Location, Bethlehem, 9701\n\n📱 *Contact Us:*\n063 138 8803 (Andile)\n067 293 9603 (Kutlwano)\n081 287 3600 (Tony)\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/`
    };
  }

  // Enhanced Bethlehem area checking with geographic coordinates
  static checkBethlehemArea(addressText, detailedLocation = null) {
    const addressLower = addressText.toLowerCase();
    
    // Check for explicit Bethlehem keywords
    const hasExplicitBethlehem = BETHLEHEM_KEYWORDS.some(keyword => 
      addressLower.includes(keyword.toLowerCase())
    );
    
    if (hasExplicitBethlehem) {
      return { valid: true, areaType: 'explicit_match' };
    }
    
    // If we have detailed location data, check geographic bounds
    if (detailedLocation && detailedLocation.lat && detailed.location) {
      const lat = parseFloat(detailedLocation.lat);
      const lon = parseFloat(detailedLocation.lon);
      
      // Approximate geographic bounds for Bethlehem area
      const isInBethlehemBounds = 
        lat >= -28.35 && lat <= -28.10 && // Latitude bounds
        lon >= 28.20 && lon <= 28.45;     // Longitude bounds
        
      if (isInBethlehemBounds) {
        return { valid: true, areaType: 'geographic_match' };
      }
    }
    
    // Check for Free State province
    if (addressLower.includes('free state') || addressLower.includes('free-state')) {
      return { valid: true, areaType: 'free_state' };
    }
    
    return { valid: false, areaType: 'unknown' };
  }

  // Enhanced reverse geocoding with OpenStreetMap Nominatim
  static async reverseGeocodeWithOSM(lat, lng) {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
      );
      
      if (!response.ok) {
        throw new Error('Geocoding failed');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Reverse geocoding error:', error);
      return null;
    }
  }

  // Forward geocoding for address validation
  static async forwardGeocodeWithOSM(address) {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address + ', Free State, South Africa')}&countrycodes=za&limit=1`
      );
      
      if (!response.ok) {
        throw new Error('Forward geocoding failed');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Forward geocoding error:', error);
      return null;
    }
  }

  // Extract location details from geocoded data
  static extractLocationDetails(geocodedData) {
    if (!geocodedData || !geocodedData.address) return null;
    
    const address = geocodedData.address;
    const details = {
      suburb: address.suburb || address.neighbourhood || address.city_district,
      city: address.city || address.town || address.village || address.municipality,
      province: address.state || address.region,
      postalCode: address.postcode,
      country: address.country,
      fullAddress: geocodedData.display_name
    };
    
    return details;
  }
}

// ========== RESPONSE MESSAGES ==========

const responses = {
  // Dynamic greeting based on returning customer
  getGreeting: (phone, name) => OrderManager.getCustomerGreeting(phone, name) + `

I can help you with:
• 🧊 Ice orders & pricing (R8/bag)
• 🚚 Delivery information (R15 Bethlehem area)  
• 📦 Minimum orders (10 bags)
• ❓ General questions

Quick commands:
"price" - See ice pricing
"order" - Start ice order process  
"delivery" - Delivery areas & times
"help" - More options

What would you like to know? 😊`,

  price: `💰 *Ice Pricing Information*

🧊 *Standard Ice 2kg Bags:*
• Price: R8.00 per bag
• Minimum Order: 10 bags
• Delivery Fee: R15.00 (Bethlehem area)

💵 *Example Orders:*
• 10 bags: R80 + R15 = R95 total
• 20 bags: R160 + R15 = R175 total  
• 50 bags: R400 + R15 = R415 total

🌐 *Visit our website:*
https://icemengroup.com/

To start an order, type: "order"`,

  help: `🧊 Thanks for messaging Ice Men!

I'm here to help with:
• Ice orders and pricing (R8/bag, 10 min)
• Delivery information (R15 Bethlehem)
• Order processing
• Connecting with our team

Quick help: 
Type "price" for pricing
Type "order" to start order process  
Type "delivery" for delivery info
Type "agent" to speak with human

🌐 *Visit our website:*
https://icemengroup.com/

We're here to keep you cool! ❄️`,

  minimum: `📦 *Minimum Order Information*

We have a minimum order of *10 ice bags* at R8.00 each.

This helps us ensure efficient delivery service throughout Bethlehem.

🧊 *10 bags = R80.00 + R15 delivery = R95.00 total*

📍 *Walk-in Store:*
Orders below 10 bags can be purchased directly at our store:
496 Mlangeni St, Old Location, Bethlehem, 9701

🌐 *Visit our website:*
https://icemengroup.com/

Ready to order? Just type "order" to start!`,

  delivery: `🚚 *Delivery Information*

We deliver throughout *Bethlehem, Free State* and surrounding areas with a R15.00 delivery fee.

📍 *Delivery Areas:*
• Bethlehem CBD & Central
• Bohlokong
• Old Location & Mlangeni St
• All surrounding areas in Bethlehem

🚫 *Currently Not Delivering To:*
• Johannesburg/Pretoria areas
• Cape Town/Durban areas
• Other provinces

⏰ *Delivery Times:*
We'll contact you to arrange the best delivery time after you place your order.

🌐 *Visit our website:*
https://icemengroup.com/

To start an order, type "order"`,

  default: `🤖 *Ice Men Assistant*

I can help you with:
🧊 Ice orders & pricing
🚚 Delivery information 
📞 Contacting our team
❓ General questions

*Quick Commands:*
• "price" - See ice pricing
• "order" - Start ice order process
• "delivery" - Delivery info  
• "help" - More options
• "agent" - Speak with human

🌐 *Visit our website:*
https://icemengroup.com/

What would you like to know? 😊`,

  agent: `👨‍💼 *Connecting to Agent*

Thank you! Our team will contact you shortly.

📱 *Contact Numbers:*
• 063 138 8803 (Andile)
• 067 293 9603 (Kutlwano)
• 081 287 3600 (Tony)

📍 *Location:*
496 Mlangeni St, Old Location, Bethlehem, 9701

🌐 *Visit our website:*
https://icemengroup.com/

For immediate ordering, type "order" to start the automated process.`,

  // New responses for unsupported content
  unsupportedContent: `🤖 *I can't understand that*

I'm designed to handle text messages and location sharing for ice orders.

If you sent a photo, sticker, or other media, I can't process it.

Would you like to:
• Type your message instead
• Speak with a human agent
• Start an ice order

🌐 *Visit our website:*
https://icemengroup.com/

Just type "help" to see all options!`,

  // Cancel response for any point in conversation
  cancelled: `❌ *Order Cancelled*

Your order has been cancelled. No problem!

If you change your mind, just type "order" to start again.

📍 *Walk-in Store:*
496 Mlangeni St, Old Location, Bethlehem, 9701

📱 *Contact Us:*
063 138 8803 (Andile)
067 293 9603 (Kutlwano)
081 287 3600 (Tony)

🌐 *Visit our website:*
https://icemengroup.com/

For any questions, type "help" or "agent" to speak with our team.`
};

// ========== ORDER PROCESS MESSAGES ==========

const orderResponses = {
  start: (isReturning = false) => {
    const welcome = isReturning ? "🛒 *Welcome Back!* Let's get your ice order started!" : "🛒 *Starting Your Ice Order*";
    return `${welcome}

I'll guide you through a few quick questions.

🧊 *Pricing:*
• R8.00 per 2kg ice bag
• Minimum: 10 bags
• Delivery: R15.00 (Bethlehem)

💰 *Example:*
10 bags = R80 + R15 delivery = R95 total

📍 *Walk-in Store:*
Orders below 10 bags can be purchased directly at:
496 Mlangeni St, Old Location, Bethlehem, 9701

🌐 *Visit our website:*
https://icemengroup.com/

*How many ice bags would you like to order?*
Please enter a number (minimum 10):`;
  },

  quantityInvalid: `❌ *Invalid Quantity*

Please enter a number of 10 or more for your ice order.

Examples:
• "10" for 10 bags (R95 total)
• "20" for 20 bags (R175 total)
• "50" for 50 bags (R415 total)

📍 *Walk-in Store:*
Orders below 10 bags can be purchased directly at:
496 Mlangeni St, Old Location, Bethlehem, 9701

🌐 *Visit our website:*
https://icemengroup.com/

*How many ice bags would you like?*`,

  address: `📍 *Delivery Address*

Great! {quantity} ice bags = R{amount}

Now, please provide your *delivery address* in Bethlehem:

*You can:*
• Type your full address with street and area
• OR share your location:
  📱 Tap the 📎 paperclip icon
  📍 Select "Location" 
  🗺️ Choose "Share Live Location" or "Send your current location"

*Important: We only deliver in Bethlehem, Free State and surrounding areas*

📍 *Walk-in Store:*
496 Mlangeni St, Old Location, Bethlehem, 9701

🌐 *Visit our website:*
https://icemengroup.com/`,

  instructions: `📝 *Delivery Instructions*

Thank you! Delivery to:
{address}

Now, any special *delivery instructions*?

Examples:
• "Leave at gate"
• "Call when arriving"
• "Safe place: behind fence"
• "No instructions"

If no special instructions, just type "none" or "no":`,

  confirmation: `✅ *Order Summary - Please Confirm*

🧊 *Order Details:*
Order #: {orderId}
Quantity: {quantity} ice bags
Subtotal: R{subtotal}
Delivery: R15.00
*Total: R{total}*

📍 *Delivery:*
{address}

📝 *Instructions:*
{instructions}

💳 *Payment:*
Cash or EFT on delivery

📱 *Contact:*
063 138 8803 (Andile)
067 293 9603 (Kutlwano)
081 287 3600 (Tony)

🌐 *Website:*
https://icemengroup.com/

To *CONFIRM* your order, please type: "confirm"
To cancel, type: "cancel"

Your ice will be delivered to your address in Bethlehem! ❄️`,

  confirmed: (orderId, quantity, total, address, instructions) => {
    const now = new Date();
    const deliveryTime = new Date(now.getTime() + 40 * 60000); // Add 40 minutes
    
    return `🎉 *Order Confirmed!*

Thank you for your order! Here are your details:

📦 *Order #:* ${orderId}
🧊 *Quantity:* ${quantity} ice bags
💰 *Total:* R${total}
📍 *Delivery:* ${address}
📝 *Instructions:* ${instructions}

⏰ *Latest Arrival:* ${deliveryTime.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}

💳 *Payment:* Cash or EFT on delivery

📱 *Contact Numbers:*
• 063 138 8803 (Andile)
• 067 293 9603 (Kutlwano) 
• 081 287 3600 (Tony)

🌐 *Visit our website:*
https://icemengroup.com/

We'll contact you shortly to confirm delivery timing.

Thank you for choosing Ice Men! ❄️`;
  },

  cancelled: responses.cancelled
};

// ========== MESSAGE PROCESSING ==========

class MessageProcessor {
  static extractMessageContent(message) {
    // Text content
    let text = null;
    if (message.message?.conversation) {
      text = message.message.conversation.trim().toLowerCase();
    }
    if (message.message?.extendedTextMessage?.text) {
      text = message.message.extendedTextMessage.text.trim().toLowerCase();
    }
    if (message.message?.imageMessage?.caption) {
      text = message.message.imageMessage.caption.trim().toLowerCase();
    }

    // Location content
    let location = null;
    if (message.message?.locationMessage) {
      location = {
        latitude: message.message.locationMessage.degreesLatitude,
        longitude: message.message.locationMessage.degreesLongitude,
        name: message.message.locationMessage.name || '',
        address: message.message.locationMessage.address || ''
      };
    }

    // Check for unsupported content types
    const hasUnsupportedContent = 
      message.message?.imageMessage && !message.message.imageMessage.caption ||
      message.message?.videoMessage ||
      message.message?.documentMessage ||
      message.message?.stickerMessage ||
      message.message?.audioMessage;

    return { text, location, hasUnsupportedContent };
  }

  static async processMessage(messageContent, senderJid, senderName, senderPhone) {
    const { text, location, hasUnsupportedContent } = messageContent;
    
    // Handle unsupported content first
    if (hasUnsupportedContent && !text) {
      return responses.unsupportedContent;
    }

    // Check for cancel command at any point
    if (text && this.isCancelCommand(text)) {
      OrderManager.completeOrder(senderPhone);
      return responses.cancelled;
    }
    
    // Check if user has an active order first
    const activeOrder = OrderManager.getOrder(senderPhone);
    if (activeOrder) {
      return await this.handleOrderStep(activeOrder, text, location, senderJid, senderPhone);
    }

    // Regular message processing
    return this.handleRegularMessage(text, senderJid, senderName, senderPhone);
  }

  static isCancelCommand(text) {
    const cancelWords = ['cancel', 'stop', 'nevermind', 'never mind', 'forget it', 'bye', 'exit', 'quit'];
    return cancelWords.some(word => text.includes(word));
  }

  static async handleOrderStep(order, text, location, senderJid, senderPhone) {
    // Check for cancel command in order flow
    if (text && this.isCancelCommand(text)) {
      OrderManager.completeOrder(senderPhone);
      return responses.cancelled;
    }

    switch (order.step) {
      case 'quantity':
        return await this.handleQuantityStep(order, text, senderJid, senderPhone);
      
      case 'address':
        return await this.handleAddressStep(order, text, location, senderJid, senderPhone);
      
      case 'instructions':
        return await this.handleInstructionsStep(order, text, senderJid, senderPhone);
      
      case 'confirmation':
        return await this.handleConfirmationStep(order, text, senderJid, senderPhone);
      
      default:
        OrderManager.completeOrder(senderPhone);
        return await sendWhatsAppMessage(senderJid, '❌ Order process error. Please type "order" to start again.');
    }
  }

  static async handleQuantityStep(order, text, senderJid, senderPhone) {
    const quantity = parseInt(text);
    
    if (isNaN(quantity) || quantity < 10) {
      return await sendWhatsAppMessage(senderJid, orderResponses.quantityInvalid);
    }

    const subtotal = quantity * 8;
    OrderManager.updateOrder(senderPhone, {
      step: 'address',
      quantity: quantity,
      subtotal: subtotal,
      total: subtotal + 15
    });

    const response = orderResponses.address
      .replace('{quantity}', quantity)
      .replace('{amount}', subtotal);
    
    return await sendWhatsAppMessage(senderJid, response);
  }

  static async handleAddressStep(order, text, location, senderJid, senderPhone) {
    // Handle location attachment with enhanced geocoding
    if (location) {
      console.log('📍 Processing location attachment:', location);
      
      try {
        // Enhanced geocoding with detailed address extraction
        let addressText = '';
        let detailedLocation = null;
        
        // First, try to get detailed address from coordinates
        const geocodedData = await OrderManager.reverseGeocodeWithOSM(location.latitude, location.longitude);
        
        if (geocodedData) {
          addressText = geocodedData.display_name;
          detailedLocation = geocodedData;
          
          // Extract location details for better validation
          const locationDetails = OrderManager.extractLocationDetails(geocodedData);
          console.log('📍 Extracted location details:', locationDetails);
        } else {
          // Fallback to basic location info
          if (location.name || location.address) {
            addressText = `${location.name || ''} ${location.address || ''}`.trim();
          } else {
            addressText = `📍 Coordinates: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
          }
        }
        
        // Enhanced validation with detailed location data
        const validation = await OrderManager.validateDeliveryArea(
          addressText, 
          { lat: location.latitude, lng: location.longitude }
        );
        
        if (!validation.valid) {
          if (validation.reason === 'outside_area') {
            OrderManager.completeOrder(senderPhone);
            return await sendWhatsAppMessage(senderJid, validation.message);
          } else if (validation.reason === 'unclear_location') {
            return await sendWhatsAppMessage(senderJid, validation.message);
          }
        }
        
        OrderManager.updateOrder(senderPhone, {
          step: 'instructions',
          address: addressText,
          location: {
            lat: location.latitude,
            lng: location.longitude,
            name: location.name,
            address: location.address,
            detailed: detailedLocation
          }
        });

        const response = `📍 *Location Received!*\n\nThank you! We've got your location:\n${addressText}\n\n${orderResponses.instructions.replace('{address}', addressText)}`;
        return await sendWhatsAppMessage(senderJid, response);

      } catch (error) {
        console.error('Error processing location:', error);
        return await sendWhatsAppMessage(senderJid, 
          `❌ Error processing location. Please type your address instead:\n\nStreet, Area, Bethlehem\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/`);
      }
    }

    // Handle text address with enhanced validation
    if (text && text.length < 10) {
      return await sendWhatsAppMessage(senderJid, 
        `❌ Please provide a complete address with street name and area.\n\n*Or you can share your location:*\n📱 Tap the 📎 attachment icon\n📍 Choose "Location"\n🗺️ Share your current location\n\n*We only deliver in Bethlehem, Free State area*\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/`);
    }

    if (text) {
      // Enhanced address validation with forward geocoding
      const validation = await OrderManager.validateDeliveryArea(text);
      if (!validation.valid) {
        if (validation.reason === 'outside_area') {
          OrderManager.completeOrder(senderPhone);
          return await sendWhatsAppMessage(senderJid, validation.message);
        } else if (validation.reason === 'unclear_location') {
          return await sendWhatsAppMessage(senderJid, validation.message);
        }
      }

      OrderManager.updateOrder(senderPhone, {
        step: 'instructions',
        address: text
      });

      const response = orderResponses.instructions.replace('{address}', text);
      return await sendWhatsAppMessage(senderJid, response);
    }

    // If no text or location, ask again with enhanced messaging
    return await sendWhatsAppMessage(senderJid, 
      `📍 *Delivery Address*\n\nPlease provide your delivery address in Bethlehem.\n\n*You can:*\n• Type your full address\n• OR share your location:\n  📱 Tap 📎 → Location → Share\n\n*We deliver throughout Bethlehem, Free State area only!*\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/`);
  }

  static async handleInstructionsStep(order, text, senderJid, senderPhone) {
    const instructions = text === 'none' || text === 'no' ? 'No special instructions' : text;
    
    OrderManager.updateOrder(senderPhone, {
      step: 'confirmation',
      instructions: instructions
    });

    const updatedOrder = OrderManager.getOrder(senderPhone);
    const response = orderResponses.confirmation
      .replace('{orderId}', updatedOrder.orderId)
      .replace('{quantity}', updatedOrder.quantity)
      .replace('{subtotal}', updatedOrder.subtotal)
      .replace('{total}', updatedOrder.total)
      .replace('{address}', updatedOrder.address)
      .replace('{instructions}', updatedOrder.instructions);

    return await sendWhatsAppMessage(senderJid, response);
  }

  static async handleConfirmationStep(order, text, senderJid, senderPhone) {
    if (text === 'confirm') {
      // Save order to Google Sheets
      try {
        const orderData = {
          orderId: order.orderId,
          name: order.name,
          email: "N/A", // Set email as N/A for WhatsApp orders
          phone: order.phone,
          quantity: order.quantity,
          address: order.address,
          instructions: order.instructions,
          subtotal: order.subtotal,
          delivery: 15,
          total: order.total,
          orderStatus: "Pending",
          timestamp: new Date().toISOString(),
          source: "whatsapp",
          isReturningCustomer: order.isReturningCustomer
        };

        // Include enhanced location data if available
        if (order.location) {
          orderData.locationData = JSON.stringify(order.location);
        }

        await callGoogleAppsScript(orderData);
        
        // Send enhanced SMS notification to delivery team
        await sendOrderNotificationSMS(orderData);
        
        const response = orderResponses.confirmed(
          order.orderId,
          order.quantity,
          order.total,
          order.address,
          order.instructions
        );

        OrderManager.completeOrder(senderPhone);
        return await sendWhatsAppMessage(senderJid, response);

      } catch (error) {
        console.error('Order save error:', error);
        OrderManager.completeOrder(senderPhone);
        return await sendWhatsAppMessage(senderJid, 
          `❌ Error saving order. Please try again or contact us directly:\n\n📱 *Contact Numbers:*\n063 138 8803 (Andile)\n067 293 9603 (Kutlwano)\n081 287 3600 (Tony)\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/`);
      }
    } 
    else if (text === 'cancel' || this.isCancelCommand(text)) {
      OrderManager.completeOrder(senderPhone);
      return await sendWhatsAppMessage(senderJid, orderResponses.cancelled);
    }
    else {
      return await sendWhatsAppMessage(senderJid, 
        '❌ Please type "confirm" to place your order or "cancel" to cancel.\n\n🌐 *Visit our website:*\nhttps://icemengroup.com/');
    }
  }

  static handleRegularMessage(text, senderJid, senderName, senderPhone) {
    if (!text) return responses.default;

    // Check for cancel command
    if (this.isCancelCommand(text)) {
      OrderManager.completeOrder(senderPhone);
      return responses.cancelled;
    }

    // Greeting triggers - with personalized welcome for returning customers
    if (text.includes('hi') || text.includes('hello') || text.includes('hey') || 
        text.includes('good morning') || text.includes('good afternoon') || text.includes('good evening')) {
      return responses.getGreeting(senderPhone, senderName);
    }

    // Order triggers - START ORDER PROCESS
    if (text.includes('order')) {
      OrderManager.startOrder(senderPhone, senderName);
      const isReturning = OrderManager.isReturningCustomer(senderPhone);
      return orderResponses.start(isReturning);
    }

    // Price triggers
    if (text.includes('price') || text.includes('cost') || text.includes('how much') || text.includes('r8') || text.includes('rate')) {
      return responses.price;
    }

    // Help triggers
    if (text.includes('help') || text.includes('support') || text.includes('what can you do')) {
      return responses.help;
    }

    // Minimum order triggers
    if (text.includes('minimum') || text.includes('min order') || text.includes('least') || text.includes('smallest')) {
      return responses.minimum;
    }

    // Delivery triggers
    if (text.includes('delivery') || text.includes('deliver') || text.includes('where do you deliver') || text.includes('bethlehem') || text.includes('area')) {
      return responses.delivery;
    }

    // Agent triggers
    if (text.includes('agent') || text.includes('human') || text.includes('person') || text.includes('talk to someone') || text.includes('representative')) {
      return responses.agent;
    }

    // Website triggers
    if (text.includes('website') || text.includes('site') || text.includes('online') || text.includes('web')) {
      return `🌐 *Ice Men Website*\n\nVisit our website for more information:\nhttps://icemengroup.com/\n\nYou can view our products, learn more about us, and place orders online!\n\nFor immediate ordering via WhatsApp, type "order" to start.`;
    }

    // Contact triggers
    if (text.includes('contact') || text.includes('number') || text.includes('phone') || text.includes('call')) {
      return `📱 *Contact Ice Men*\n\n*Team Members:*\n• 063 138 8803 (Andile)\n• 067 293 9603 (Kutlwano)\n• 081 287 3600 (Tony)\n\n📍 *Store Location:*\n496 Mlangeni St, Old Location, Bethlehem, 9701\n\n🌐 *Website:*\nhttps://icemengroup.com/\n\nFor immediate ordering, type "order" to start the automated process.`;
    }

    // Default response for anything else
    return responses.default;
  }

  static async processIncomingMessage(message, senderJid, senderName, senderPhone) {
    const messageContent = this.extractMessageContent(message);
    return await this.processMessage(messageContent, senderJid, senderName, senderPhone);
  }
}

// ========== GOOGLE SHEETS INTEGRATION ==========

async function callGoogleAppsScript(payload) {
  try {
    const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      return await response.json();
    } else {
      throw new Error(`Google Sheets error: ${response.status}`);
    }
  } catch (error) {
    console.error('Google Apps Script error:', error);
    throw error;
  }
}

// ========== SMS NOTIFICATION ==========

async function sendOrderNotificationSMS(orderData) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('⚠️ Twilio not configured - skipping SMS notification');
    return;
  }

  try {
    const now = new Date();
    const deliveryTime = new Date(now.getTime() + 40 * 60000);
    
    const message = `🧊 NEW WHATSAPP ORDER #${orderData.orderId}
    
Customer: ${orderData.name}
Phone: ${orderData.phone}
Quantity: ${orderData.quantity} ice bags
Total: R${orderData.total}

Delivery: ${orderData.address}
${orderData.instructions !== 'No special instructions' ? `Instructions: ${orderData.instructions}` : ''}

Latest Arrival: ${deliveryTime.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
Payment: Cash/EFT on delivery

${orderData.isReturningCustomer ? '🔄 RETURNING CUSTOMER' : '👋 NEW CUSTOMER'}

Team Contacts:
• 063 138 8803 (Andile)
• 067 293 9603 (Kutlwano) 
• 081 287 3600 (Tony)`;

    await twilioClient.messages.create({
      body: message,
      to: '+27672939603', // Your delivery team number
      from: process.env.TWILIO_NUMBER,
    });

    console.log('✅ SMS notification sent for order:', orderData.orderId);
  } catch (error) {
    console.error('❌ Failed to send SMS notification:', error.message);
  }
}

// ========== WHATSAPP MESSAGE SENDER ==========

async function sendWhatsAppMessage(jid, message) {
  if (!whatsappSocket || !isWhatsAppConnected) {
    throw new Error('WhatsApp not connected');
  }

  if (!jid.includes('@s.whatsapp.net')) {
    jid = `${jid}@s.whatsapp.net`;
  }

  await whatsappSocket.sendMessage(jid, { text: message });
}

// ========== WHATSAPP CONNECTION ==========

async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⏳ WhatsApp connection already in progress...');
    return;
  }

  isConnecting = true;
  connectionError = null;

  try {
    console.log('🔄 Initializing WhatsApp connection...');
    
    const authDir = './baileys_auth_info';
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const logger = pino({ level: 'silent' });

    whatsappSocket = makeWASocket({
      version,
      logger: logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['Ice Men Server', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    isConnecting = false;

    // Handle connection updates
    whatsappSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCode = qr;
        console.log('📱 WhatsApp QR Code received - scan with your phone');
        terminalQR.generate(qr, { small: true });
        console.log('🔗 Visit /whatsapp/qr to scan the QR code');
      }

      if (connection === 'close') {
        isWhatsAppConnected = false;
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        const errorMsg = lastDisconnect?.error?.message || 'unknown reason';
        console.log(`⚠️ WhatsApp connection closed: ${errorMsg}`);
        
        if (shouldReconnect && connectionRetries < MAX_CONNECTION_RETRIES) {
          connectionRetries++;
          connectionError = errorMsg;
          console.log(`🔄 Reconnecting... Attempt ${connectionRetries}/${MAX_CONNECTION_RETRIES}`);
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          connectionError = 'Logged out - please scan QR code again';
          console.log('❌ Max retries reached or logged out');
          connectionRetries = 0;
          qrCode = null;
          whatsappSocket = null;
        }
      } else if (connection === 'open') {
        isWhatsAppConnected = true;
        qrCode = null;
        connectionError = null;
        connectionRetries = 0;
        console.log('✅ WhatsApp connected successfully!');
        console.log('🤖 Ice Men bot is now LIVE and ready to take orders!');
        console.log('📊 Enhanced Features: Advanced location geocoding, Multiple agent contacts, Website integration');
      }
    });

    whatsappSocket.ev.on('creds.update', saveCreds);

    // Handle incoming WhatsApp messages
    whatsappSocket.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        
        if (message.key.fromMe || !message.message || message.message.protocolMessage) return;

        const senderJid = message.key.remoteJid;
        const senderPhone = senderJid?.replace('@s.whatsapp.net', '');
        const senderName = message.pushName || 'Customer';

        console.log('📱 New message from:', senderPhone, 'Name:', senderName, 'Returning:', OrderManager.isReturningCustomer(senderPhone));

        const response = await MessageProcessor.processIncomingMessage(message, senderJid, senderName, senderPhone);
        if (response) {
          await sendWhatsAppMessage(senderJid, response);
          console.log('🤖 Sent response to:', senderPhone);
        }

      } catch (error) {
        console.error('❌ Error processing WhatsApp message:', error);
      }
    });

  } catch (error) {
    isConnecting = false;
    connectionError = error.message;
    console.error('❌ Error connecting to WhatsApp:', error.message);
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

// ========== AUTO-PING SYSTEM ==========

let pingInterval = null;
let lastPingTime = null;

async function pingServer() {
  try {
    const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://icemenserver.onrender.com';
    const response = await fetch(`${externalUrl}/ping`);
    const result = await response.text();
    lastPingTime = new Date().toISOString();
    console.log(`🔄 Auto-ping successful to ${externalUrl}: ${result} at ${lastPingTime}`);
    return true;
  } catch (error) {
    console.error('❌ Auto-ping failed:', error.message);
    return false;
  }
}

function startAutoPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingServer();
  pingInterval = setInterval(pingServer, 10 * 60 * 1000);
  console.log(`🔄 Auto-ping system started`);
}

function stopAutoPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ========== TWILIO SMS ENDPOINTS ==========

function validatePhoneNumber(phone) {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
}

function validateMessage(message) {
  return message && message.trim().length > 0 && message.length <= 1600;
}

app.post('/send-sms', async (req, res) => {
  const requestId = Date.now();
  console.log(`\n🔵 [${requestId}] NEW SMS REQUEST`);
  
  try {
    const { to, message } = req.body;
    console.log(`📋 [${requestId}] Request:`, { to, messageLength: message?.length });

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: "to" and "message"'
      });
    }

    const recipients = Array.isArray(to) ? to : [to];
    const invalidNumbers = recipients.filter(num => !validatePhoneNumber(num));
    
    if (invalidNumbers.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid phone number(s): ${invalidNumbers.join(', ')}`
      });
    }

    if (!validateMessage(message)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid message'
      });
    }

    const results = [];
    for (const recipient of recipients) {
      try {
        const twilioResponse = await twilioClient.messages.create({
          body: message,
          to: recipient,
          from: process.env.TWILIO_NUMBER,
        });

        console.log(`✅ [${requestId}] SMS sent to ${recipient}`);

        results.push({
          to: recipient,
          success: true,
          sid: twilioResponse.sid
        });
      } catch (error) {
        console.error(`❌ [${requestId}] Failed:`, error.message);
        results.push({
          to: recipient,
          success: false,
          error: error.message
        });
      }
    }

    const allFailed = results.every(r => !r.success);
    if (allFailed) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send to all recipients',
        details: results
      });
    }

    res.json({
      success: true,
      message: 'Messages sent',
      results: results
    });

  } catch (error) {
    console.error(`❌ [${requestId}] Error:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/messages', async (req, res) => {
  try {
    const messages = await twilioClient.messages.list({ limit: 20 });
    res.json({
      success: true,
      messages: messages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== WHATSAPP ENDPOINTS ==========

app.get('/whatsapp/qr', async (req, res) => {
  try {
    if (!whatsappSocket && !isConnecting && !connectionError) {
      connectToWhatsApp();
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="UTF-8"><title>Initializing WhatsApp</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <div class="spinner" style="width: 50px; height: 50px; border: 5px solid #f3f3f3; border-top: 5px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto;"></div>
            <h2>Starting Ice Men WhatsApp Bot</h2>
            <p>Initializing your automated ice order system...</p>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
          </body>
        </html>
      `);
    }

    if (isWhatsAppConnected) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="UTF-8"><title>WhatsApp Connected</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <div style="color: #25d366; font-size: 48px;">✅</div>
            <h2>Ice Men WhatsApp Bot is LIVE! 🧊</h2>
            <p>Your automated ice order system is running and ready!</p>
            <p><strong>Enhanced Features:</strong></p>
            <ul style="text-align: left; display: inline-block;">
              <li>📍 Advanced location geocoding & validation</li>
              <li>🛑 Cancel detection at any point</li>
              <li>🏪 Store information for small orders</li>
              <li>⏰ 40-minute delivery estimate</li>
              <li>💳 Cash/EFT payment information</li>
              <li>📱 Sticker/photo detection</li>
              <li>👋 Returning customer recognition</li>
              <li>📞 Multiple agent contacts</li>
              <li>🌐 Website integration</li>
            </ul>
            <p><em>Orders automatically save to Google Sheets</em></p>
          </body>
        </html>
      `);
    }

    if (connectionError) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="UTF-8"><title>Connection Error</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <div style="color: #dc3545; font-size: 48px;">❌</div>
            <h2>Connection Error</h2>
            <p>${connectionError}</p>
            <button onclick="location.reload()" style="background: #25d366; color: white; border: none; padding: 12px 30px; border-radius: 5px; cursor: pointer;">🔄 Retry Connection</button>
          </body>
        </html>
      `);
    }

    if (qrCode) {
      webQR.toString(qrCode, { type: 'svg' }, (err, svg) => {
        if (err) return res.status(500).send('<h2>Failed to generate QR code</h2>');
        
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>Connect Ice Men WhatsApp</title>
              <style>
                body { font-family: Arial; text-align: center; padding: 20px; background: #f0f2f5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              </style>
            </head>
            <body>
              <div class="container">
                <h2>🧊 Connect Ice Men WhatsApp</h2>
                <p><strong>Scan this QR code with your phone to link your WhatsApp Business number</strong></p>
                <div style="margin: 20px 0;">${svg}</div>
                <p><strong>Instructions:</strong></p>
                <ol style="text-align: left;">
                  <li>Open WhatsApp on your phone</li>
                  <li>Tap ⋯ (Menu) → Linked Devices</li>
                  <li>Tap "Link a Device"</li>
                  <li>Scan the QR code above</li>
                </ol>
                <p><small>This links your number once - then the bot runs 24/7 on the server!</small></p>
              </div>
            </body>
          </html>
        `);
      });
    } else {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta http-equiv="refresh" content="3"><title>Initializing</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <div class="spinner" style="width: 50px; height: 50px; border: 5px solid #f3f3f3; border-top: 5px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto;"></div>
            <h2>Generating QR Code...</h2>
            <p>Setting up your Ice Men automation system</p>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('❌ Error in /whatsapp/qr:', error);
    res.status(500).send('<h2>Error</h2>');
  }
});

app.post('/whatsapp/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ success: false, error: 'Missing to or message' });
  if (!whatsappSocket || !isWhatsAppConnected) return res.status(503).json({ success: false, error: 'WhatsApp not connected' });

  try {
    await sendWhatsAppMessage(to, message);
    res.json({ success: true, message: 'Message sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/whatsapp/status', (req, res) => {
  res.json({
    success: true,
    connected: isWhatsAppConnected,
    activeOrders: activeOrders.size,
    totalCustomers: customerHistory.size,
    business: 'Ice Men Bethlehem',
    status: isWhatsAppConnected ? 'LIVE - Taking Orders' : 'Offline',
    timestamp: new Date().toISOString(),
    features: [
      'Advanced location geocoding',
      'Multiple agent contacts',
      'Website integration',
      'Cancel detection',
      'Returning customer tracking'
    ]
  });
});

// ========== UTILITY ENDPOINTS ==========

app.get('/ping', (req, res) => {
  const response = {
    pong: true,
    timestamp: new Date().toISOString(),
    server: 'Dual SMS/WhatsApp Server',
    status: 'active',
    autoPing: {
      enabled: true,
      interval: '10 minutes',
      lastPing: lastPingTime,
      nextPing: lastPingTime ? new Date(new Date(lastPingTime).getTime() + 10 * 60 * 1000).toISOString() : null
    },
    whatsapp: {
      connected: isWhatsAppConnected,
      status: isWhatsAppConnected ? 'connected' : 'disconnected',
      activeOrders: activeOrders.size,
      totalCustomers: customerHistory.size
    },
    twilio: {
      configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    }
  };
  
  console.log(`🏓 Ping received`);
  res.json(response);
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    whatsappStatus: isWhatsAppConnected ? 'connected' : 'disconnected',
    googleSheets: 'connected',
    activeOrders: activeOrders.size,
    totalCustomers: customerHistory.size,
    features: [
      'Advanced location geocoding & validation',
      'Cancel detection at any point',
      'Store information integration',
      '40-minute delivery estimates',
      'Payment information',
      'Sticker/photo detection',
      'Returning customer tracking',
      'Multiple agent contacts',
      'Website integration'
    ]
  });
});

app.get('/debug', (req, res) => {
  res.json({
    server: 'running',
    nodeVersion: process.version,
    uptime: process.uptime(),
    whatsapp: {
      connected: isWhatsAppConnected,
      connecting: isConnecting,
      qrAvailable: !!qrCode,
      error: connectionError,
      socketExists: !!whatsappSocket,
      activeOrders: activeOrders.size,
      customerHistory: customerHistory.size
    },
    twilio: {
      configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Dual SMS/WhatsApp Server is running!',
    endpoints: {
      'SMS': {
        'POST /send-sms': 'Send SMS',
        'GET /messages': 'Get messages'
      },
      'WhatsApp': {
        'GET /whatsapp/qr': 'Get QR code',
        'POST /whatsapp/send': 'Send WhatsApp message',
        'GET /whatsapp/status': 'Check status'
      },
      'Utility': {
        'GET /health': 'Health check',
        'GET /ping': 'Ping server',
        'GET /debug': 'Debug info'
      }
    },
    currentStatus: {
      whatsappConnected: isWhatsAppConnected,
      twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      activeOrders: activeOrders.size,
      totalCustomers: customerHistory.size
    }
  });
});

// ========== START SERVER ==========

async function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ========================================');
    console.log(`🚀 Dual SMS/WhatsApp Server running on port ${PORT}`);
    console.log(`📱 Twilio: ${process.env.TWILIO_NUMBER || '⚠️ NOT CONFIGURED'}`);
    console.log(`🤖 WhatsApp Bot: ${isWhatsAppConnected ? '✅ CONNECTED' : '🔗 SCAN QR'}`);
    console.log(`🧊 Ice Men Automation: ✅ ACTIVE`);
    console.log(`📍 Advanced Location Geocoding: ✅ ACTIVE`);
    console.log(`🛑 Cancel Detection: ✅ ACTIVE`);
    console.log(`🏪 Store Info: ✅ ACTIVE`);
    console.log(`⏰ 40-min Delivery: ✅ ACTIVE`);
    console.log(`💳 Payment Info: ✅ ACTIVE`);
    console.log(`📞 Multiple Agent Contacts: ✅ ACTIVE`);
    console.log(`🌐 Website Integration: ✅ ACTIVE`);
    console.log(`🔗 Health: http://localhost:${PORT}/health`);
    console.log(`🔗 WhatsApp QR: http://localhost:${PORT}/whatsapp/qr`);
    console.log('🚀 ========================================\n');
    
    startAutoPing();
    connectToWhatsApp();
  });

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  console.log('\n🔄 Shutting down server...');
  stopAutoPing();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 SIGTERM received...');
  stopAutoPing();
  process.exit(0);
});

console.log('🔵 Starting Dual SMS/WhatsApp server...');
startServer();