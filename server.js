const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// MQTT Configuration
const MQTT_CONFIG = {
  host: 'd20951d2e2aa49e98e82561d859007d3.s1.eu.hivemq.cloud',
  port: 8883,
  username: 'lunar',
  password: 'Rover123',
  protocol: 'mqtts'
};

let mqttClient = null;
let mqttConnected = false;

// Initialize MQTT Client with robust reconnect
function initMQTT() {
  console.log('🔌 Initializing MQTT connection...');
  
  const clientId = `vr-rover-${Math.random().toString(16).substr(2, 8)}`;
  
  mqttClient = mqtt.connect({
    host: MQTT_CONFIG.host,
    port: MQTT_CONFIG.port,
    protocol: MQTT_CONFIG.protocol,
    username: MQTT_CONFIG.username,
    password: MQTT_CONFIG.password,
    clientId: clientId,
    clean: true,
    connectTimeout: 30000,
    reconnectPeriod: 5000,
    rejectUnauthorized: false
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('✅ MQTT CONNECTED to broker');
    console.log('📡 Subscribing to rover/status');
    mqttClient.subscribe('rover/status', { qos: 1 });
  });

  mqttClient.on('message', (topic, message) => {
    console.log(`📬 MQTT RECEIVED [${topic}]: ${message.toString()}`);
  });

  mqttClient.on('error', (error) => {
    console.error('❌ MQTT ERROR:', error.message);
    mqttConnected = false;
  });

  mqttClient.on('offline', () => {
    console.log('⚠️ MQTT OFFLINE');
    mqttConnected = false;
  });

  mqttClient.on('reconnect', () => {
    console.log('🔄 MQTT RECONNECTING...');
  });

  mqttClient.on('close', () => {
    console.log('🔌 MQTT CONNECTION CLOSED');
    mqttConnected = false;
  });

  mqttClient.on('disconnect', (packet) => {
    console.log(`⚠️ MQTT DISCONNECTED: ${packet ? packet.reasonCode : 'unknown'}`);
    mqttConnected = false;
  });
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "wss:", "ws:"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"]
    }
  }
}));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.path}`);
  next();
});

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Routes
app.get('/', (req, res) => {
  console.log('📄 Serving index.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  console.log('🔍 Status check - MQTT:', mqttConnected ? 'Connected' : 'Disconnected');
  res.json({
    status: 'online',
    mqtt: mqttConnected,
    timestamp: new Date().toISOString(),
    rover: {
      lastStatus: Date.now() - (Math.floor(Math.random() * 10000) // Simulated freshness
    }
  });
});

app.post('/api/rover/control', (req, res) => {
  const { action, data } = req.body;
  console.log(`🤖 Received command: ${action}`, data);

  if (!mqttConnected) {
    console.error('❌ Command rejected: MQTT not connected');
    return res.status(503).json({ error: 'MQTT not connected' });
  }

  try {
    const topic = 'rover/control';
    const payload = JSON.stringify({ 
      action, 
      data,
      timestamp: Date.now(),
      source: 'vr-controller'
    });
    
    mqttClient.publish(topic, payload, { qos: 1 }, (error) => {
      if (error) {
        console.error('❌ MQTT PUBLISH ERROR:', error.message);
        return res.status(500).json({ error: 'Failed to send command' });
      }
      
      console.log(`📡 MQTT PUBLISH: ${action} - ${JSON.stringify(data)}`);
      res.json({ success: true, action, data });
    });
  } catch (error) {
    console.error('🚨 COMMAND PROCESSING ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize MQTT and start server
initMQTT();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 VR ROVER CONTROLLER SERVER`);
  console.log(`⏱️ Started at: ${new Date().toLocaleString()}`);
  console.log(`🔊 Listening on port: ${PORT}`);
  console.log('---------------------------------------');
  console.log('🔍 TROUBLESHOOTING TIPS:');
  console.log('1. If MQTT fails to connect, verify credentials');
  console.log('2. Check firewall settings for port 8883');
  console.log('3. Test MQTT connection with:');
  console.log(`   mqtt sub -t 'rover/#' -h ${MQTT_CONFIG.host} \\`);
  console.log(`   -p ${MQTT_CONFIG.port} -u ${MQTT_CONFIG.username} \\`);
  console.log(`   -P '${MQTT_CONFIG.password}' --insecure`);
  console.log('---------------------------------------');
});
