// --- START OF FILE server.js ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws'); // For client (Quest, Mobile) to this server
const path = require('path');
const axios = require('axios');
const mqtt = require('mqtt'); // MQTT client

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
// !!! USER: Replace with your HiveMQ Cloud details !!!
const MQTT_BROKER_URL = 'mqtts://d20951d2e2aa49e98e82561d859007d3.s1.eu.hivemq.cloud:8883'; // e.g., 'mqtts://random123.s1.eu.hivemq.cloud:8883'
const MQTT_USERNAME = 'lunar';        // From HiveMQ Access Management
const MQTT_PASSWORD = 'Rover123';        // From HiveMQ Access Management
const MQTT_CONTROL_TOPIC = 'quest/rover/control'; // Topic to publish controller data to

let mqttClient;
const mqttOptions = {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    connectTimeout: 10000, // 10 seconds
    // keepalive: 60, // Default is 60 seconds
    // reconnectPeriod: 1000, // Default, ms between reconnect attempts
};

function connectToMqttBroker() {
    if (!MQTT_BROKER_URL.includes("hivemq.cloud")) {
        console.warn("MQTT: Broker URL seems to be a placeholder or not a HiveMQ cloud URL. Please update it in server.js.");
    }
    if (mqttClient && mqttClient.connected) {
        console.log('MQTT: Already connected to broker.');
        return;
    }

    console.log(`MQTT: Attempting to connect to broker at ${MQTT_BROKER_URL}...`);
    mqttClient = mqtt.connect(MQTT_BROKER_URL, mqttOptions);

    mqttClient.on('connect', () => {
        console.log('MQTT: Successfully connected to MQTT broker.');
        // You could subscribe to topics here if the server needed to receive messages
        // mqttClient.subscribe('esp/rover/status', (err) => {
        // if (!err) {
        // console.log('MQTT: Subscribed to ESP status topic.');
        // }
        // });
    });

    mqttClient.on('reconnect', () => {
        console.log('MQTT: Reconnecting to MQTT broker...');
    });

    mqttClient.on('error', (error) => {
        console.error('MQTT: Connection error:', error.message);
        // The client will attempt to reconnect automatically based on reconnectPeriod
    });

    mqttClient.on('close', () => {
        console.log('MQTT: Disconnected from MQTT broker.');
        // The client will attempt to reconnect automatically
    });

    // mqttClient.on('message', (topic, message) => {
        // Handle incoming messages if subscribed
        // console.log(`MQTT: Received message on topic ${topic}: ${message.toString()}`);
    // });
}
// --- END MQTT Configuration ---


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

let lastMqttSendTime = 0;
const MQTT_SEND_INTERVAL = 100; // milliseconds, send updates to ESP via MQTT every 100ms

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
        // console.log(`WebSocket: Received from ${ws.role || 'unknown'}:`, data.type); // Less verbose

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

            case 'controller_input':
                if (ws.role !== 'quest_viewer') {
                    // console.log("WebSocket: Controller input from non-Quest client, ignoring."); // Can be noisy
                    return;
                }

                // Echo back to the Quest client for its own UI display
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data));
                }

                // Process and send to ESP8266 via MQTT
                if (data.input && data.input.inputs) {
                    let rightStickX = 0;
                    let rightStickY = 0;
                    let rightControllerFound = false;

                    for (const controller of data.input.inputs) {
                        if (controller.handedness === 'right') {
                            if (controller.axes && controller.axes.length >= 4) { // Standard Quest controllers
                                rightStickX = controller.axes[2]; // Right stick X
                                rightStickY = controller.axes[3]; // Right stick Y
                                rightControllerFound = true;
                                break; 
                            }
                        }
                    }
                    
                    if (!rightControllerFound && data.input.inputs.length > 0) {
                        const firstController = data.input.inputs[0];
                         if (firstController.axes && firstController.axes.length >= 4) {
                            console.log("WebSocket: Right controller not explicitly found, using first available controller's axes [2] and [3]. Handedness:", firstController.handedness);
                            rightStickX = firstController.axes[2];
                            rightStickY = firstController.axes[3];
                        } else if (firstController.axes && firstController.axes.length >= 2) {
                            console.log("WebSocket: Controller has only 2 axes. Assuming axes [0] and [1] for control (X, Y). Handedness:", firstController.handedness);
                            rightStickX = firstController.axes[0]; 
                            rightStickY = firstController.axes[1];
                        }
                    }

                    if (mqttClient && mqttClient.connected) {
                        const now = Date.now();
                        if (now - lastMqttSendTime > MQTT_SEND_INTERVAL) {
                            const payloadToEsp = { stickX: rightStickX, stickY: rightStickY };
                            const payloadString = JSON.stringify(payloadToEsp);
                            mqttClient.publish(MQTT_CONTROL_TOPIC, payloadString, (err) => {
                                if (err) {
                                    console.error('MQTT: Failed to publish message:', err);
                                } else {
                                    // console.log(`MQTT: Sent to ${MQTT_CONTROL_TOPIC}: ${payloadString}`); // Can be verbose
                                }
                            });
                            lastMqttSendTime = now;
                        }
                    } else {
                        // console.log("MQTT: Broker not connected, cannot send controller data."); // Can be verbose
                    }
                }
                break;

            default:
                console.log('WebSocket: Unknown message type:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${data.type}` }));
        }
    });

    ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'No reason given';
        console.log(`WebSocket: Client disconnected (Code: ${code}, Reason: ${reasonStr}). Role: ${ws.role || 'unknown'}`);
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
    console.log("Ensure ESP8266 is configured for MQTT and HiveMQ details are correct in server.js.");
    connectToMqttBroker(); // Initial attempt to connect to MQTT broker
});
// --- END OF FILE server.js ---
