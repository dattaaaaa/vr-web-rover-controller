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

// Initialize MQTT Client
function initMQTT() {
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
    reconnectPeriod: 1000,
    rejectUnauthorized: false
  });

  mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT broker');
  });

  mqttClient.on('error', (error) => {
    console.error('❌ MQTT connection error:', error);
  });

  mqttClient.on('disconnect', () => {
    console.log('🔌 Disconnected from MQTT broker');
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

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    mqtt: mqttClient ? mqttClient.connected : false,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rover/control', (req, res) => {
  const { action, data } = req.body;
  
  if (!mqttClient || !mqttClient.connected) {
    return res.status(503).json({ error: 'MQTT not connected' });
  }

  try {
    const topic = 'rover/control';
    const payload = JSON.stringify({ action, data, timestamp: Date.now() });
    
    mqttClient.publish(topic, payload, { qos: 1 }, (error) => {
      if (error) {
        console.error('MQTT publish error:', error);
        return res.status(500).json({ error: 'Failed to send command' });
      }
      
      console.log(`📡 Sent: ${action} - ${JSON.stringify(data)}`);
      res.json({ success: true, action, data });
    });
  } catch (error) {
    console.error('Error sending rover command:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize MQTT and start server
initMQTT();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VR Rover Controller running on port ${PORT}`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
