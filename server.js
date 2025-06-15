const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path =path.join(__dirname, 'public');
const axios = require('axios');
const mqtt = require('mqtt'); // Import MQTT

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let ipWebcamUrl = null;
let questViewers = new Set();
let mobileConfigurator = null;
let connectedClientsToProxy = 0;

// --- MQTT Configuration ---
// IMPORTANT: Replace with your actual HiveMQ Cloud details
const MQTT_BROKER_URL = 'mqtts://d20951d2e2aa49e98e82561d859007d3.s1.eu.hivemq.cloud:8883'; // e.g., mqtts://abcdef123.s1.eu.hivemq.cloud:8883
const MQTT_OPTIONS = {
  username: 'lunar', // Your HiveMQ username
  password: 'Rover123', // Your HiveMQ password
  clientId: 'render_server_' + Math.random().toString(16).substring(2, 10), // Unique client ID
  connectTimeout: 4000, // Time to wait for a CONNACK
  reconnectPeriod: 1000, // Milliseconds to wait before resubscribing
};
const MQTT_ROVER_CONTROL_TOPIC = 'quest/rover/control';
let mqttClient;

function connectMqtt() {
    if (MQTT_BROKER_URL.includes('YOUR_CLUSTER_URL')) {
        console.warn('MQTT: Broker URL is not configured. MQTT will not connect.');
        return;
    }
    console.log(`MQTT: Attempting to connect to broker: ${MQTT_BROKER_URL}`);
    mqttClient = mqtt.connect(MQTT_BROKER_URL, MQTT_OPTIONS);

    mqttClient.on('connect', () => {
        console.log('MQTT: Successfully connected to broker.');
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT: Connection error:', err.message);
    });

    mqttClient.on('reconnect', () => {
        console.log('MQTT: Reconnecting to broker...');
    });

    mqttClient.on('close', () => {
        console.log('MQTT: Connection to broker closed.');
    });

    mqttClient.on('offline', () => {
        console.log('MQTT: Client is offline.');
    });
}
// Attempt to connect to MQTT broker on server start
connectMqtt();
// --- End MQTT Configuration ---


app.get('/proxied-stream', async (req, res) => {
    if (!ipWebcamUrl) {
        return res.status(404).contentType('text/plain').send('IP Webcam URL not set on server.');
    }
    console.log(`Proxy: Client connected. Requesting stream from: ${ipWebcamUrl}`);
    connectedClientsToProxy++;
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=--jpgboundary',
        'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache'
    });
    let currentRequestToIpCam;
    try {
        currentRequestToIpCam = await axios({
            method: 'get',
            url: ipWebcamUrl,
            responseType: 'stream',
            timeout: 10000,
        });
        currentRequestToIpCam.data.pipe(res);
        currentRequestToIpCam.data.on('error', (err) => {
            console.error('Proxy: Error in stream from IP Webcam:', err.message);
            if (!res.headersSent) {
                res.status(502).contentType('text/plain').send('Error streaming from IP Webcam.');
            } else {
                res.end();
            }
        });
        currentRequestToIpCam.data.on('end', () => {
            console.log('Proxy: Stream from IP Webcam ended.');
            res.end();
        });
    } catch (error) {
        console.error('Proxy: Failed to connect to IP Webcam:', error.message);
        if (!res.headersSent) {
            if (error.code === 'ECONNREFUSED') {
                 res.status(502).contentType('text/plain').send('Proxy: Could not connect to IP Webcam (Connection Refused).');
            } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                 res.status(504).contentType('text/plain').send('Proxy: Connection to IP Webcam timed out.');
            } else {
                 res.status(500).contentType('text/plain').send('Proxy: Error connecting to IP Webcam.');
            }
        } else {
            res.end();
        }
        return;
    }
    req.on('close', () => {
        connectedClientsToProxy--;
        console.log(`Proxy: Client disconnected. Remaining proxy clients: ${connectedClientsToProxy}`);
        if (currentRequestToIpCam && typeof currentRequestToIpCam.request?.abort === 'function') {
            currentRequestToIpCam.request.abort();
        } else if (currentRequestToIpCam && typeof currentRequestToIpCam.data?.destroy === 'function') {
            currentRequestToIpCam.data.destroy();
        }
    });
});

wss.on('connection', (ws) => {
    console.log('WebSocket: Client connected');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('WebSocket: Invalid JSON message:', message.toString());
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format' }));
            return;
        }
        // console.log(`WebSocket: Received from ${ws.role || 'unknown'}:`, data.type); // Less verbose logging

        switch (data.type) {
            case 'register_mobile_configurator':
                console.log('WebSocket: Mobile configurator registered');
                if (mobileConfigurator && mobileConfigurator !== ws && mobileConfigurator.readyState === WebSocket.OPEN) {
                    mobileConfigurator.close(1000, "New configurator connected, closing old session.");
                }
                mobileConfigurator = ws;
                ws.role = 'mobile_configurator';
                if (ipWebcamUrl) {
                    ws.send(JSON.stringify({ type: 'url_ack', url: ipWebcamUrl, message: 'Retrieved current URL from server' }));
                } else {
                     ws.send(JSON.stringify({ type: 'url_ack', url: null, message: 'No URL set on server yet' }));
                }
                break; 

            case 'register_quest_viewer':
                console.log('WebSocket: Quest viewer registered');
                questViewers.add(ws);
                ws.role = 'quest_viewer';
                if (ipWebcamUrl) {
                    ws.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl, useProxy: true }));
                } else {
                    ws.send(JSON.stringify({ type: 'no_stream_url_set' }));
                }
                break;

            case 'set_ip_webcam_url':
                if (ws.role !== 'mobile_configurator') {
                    ws.send(JSON.stringify({type: 'error', message: 'Not authorized to set URL'}));
                } else {
                    const newUrl = data.url;
                    if (typeof newUrl === 'string' && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
                        ipWebcamUrl = newUrl;
                        console.log('WebSocket: IP Webcam URL set to:', ipWebcamUrl);
                        ws.send(JSON.stringify({ type: 'url_ack', url: ipWebcamUrl, message: 'URL successfully updated on server' }));
                        
                        questViewers.forEach(viewerWs => {
                            if (viewerWs.readyState === WebSocket.OPEN) {
                                viewerWs.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl, useProxy: true }));
                            }
                        });
                    } else {
                        console.log('WebSocket: Invalid IP Webcam URL received:', newUrl);
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid URL format. Must start with http:// or https://' }));
                    }
                }
                break;
            
            case 'rover_stick_input': // New message type from Quest client
                if (ws.role === 'quest_viewer') {
                    // console.log('WebSocket: Received rover_stick_input:', data.input); // Can be very verbose
                    if (mqttClient && mqttClient.connected) {
                        const payload = JSON.stringify(data.input); // data.input should be { pressed, x, y }
                        mqttClient.publish(MQTT_ROVER_CONTROL_TOPIC, payload, { qos: 0, retain: false }, (err) => {
                            if (err) {
                                console.error('MQTT: Failed to publish message:', err);
                            }
                            // else { console.log(`MQTT: Published to ${MQTT_ROVER_CONTROL_TOPIC}`); } // Verbose
                        });
                    } else {
                        console.warn('MQTT: Client not connected or not configured, cannot send rover input.');
                    }
                } else {
                    console.log("WebSocket: Rover input from non-Quest client, ignoring.");
                }
                break;

            case 'controller_input': // This is the generic one, Quest client will decide if it sends this additionally.
                if (ws.role !== 'quest_viewer') {
                    console.log("WebSocket: Controller input from non-Quest client, ignoring.");
                } else {
                     // This is general controller data, primarily for display on the Quest page itself.
                     // The Quest client could echo this back to itself, or server can do it.
                     // For simplicity, if Quest sends it, server just acknowledges or ignores.
                     // For now, let's assume if it's sent, it's for some other purpose or debugging.
                    // console.log("WebSocket: Received general controller_input (for display/debug):", data.input);
                }
                break;

            default:
                console.log('WebSocket: Unknown message type:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${data.type}` }));
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket: Client disconnected. Role: ${ws.role || 'unknown'}`);
        if (ws.role === 'quest_viewer') {
            questViewers.delete(ws);
            console.log('WebSocket: Quest viewer count:', questViewers.size);
        } else if (ws === mobileConfigurator) {
            mobileConfigurator = null;
            console.log('WebSocket: Mobile configurator disconnected.');
        }
    });

    ws.onerror = (error) => {
        console.error(`WebSocket error (Role: ${ws.role || 'unknown'}):`, error.message);
    };
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access application at: http://localhost:${PORT}/ (or your Render URL)`);
    if (MQTT_BROKER_URL.includes('YOUR_CLUSTER_URL')) {
        console.warn("*********************************************************************");
        console.warn("WARNING: MQTT Broker is not configured in server.js.");
        console.warn("Rover control via MQTT will not function until you update MQTT_BROKER_URL, MQTT_OPTIONS.username, and MQTT_OPTIONS.password.");
        console.warn("*********************************************************************");
    }
});
