const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let ipWebcamUrl = null; // Store the current IP Webcam URL
let questViewers = new Set();
let mobileConfigurator = null;

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON message:', message.toString());
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format' }));
            return;
        }

        console.log(`Received from ${ws.role || 'unknown'}:`, data.type);

        switch (data.type) {
            case 'register_mobile_configurator':
                console.log('Mobile configurator registered');
                if (mobileConfigurator && mobileConfigurator !== ws && mobileConfigurator.readyState === WebSocket.OPEN) {
                    mobileConfigurator.close(1000, "New configurator connected, closing old session.");
                }
                mobileConfigurator = ws;
                ws.role = 'mobile_configurator';
                // Send current URL if already set, so the input field can be populated
                if (ipWebcamUrl) {
                    ws.send(JSON.stringify({ type: 'url_ack', url: ipWebcamUrl, message: 'Retrieved current URL from server' }));
                } else {
                     ws.send(JSON.stringify({ type: 'url_ack', url: null, message: 'No URL set on server yet' }));
                }
                break;

            case 'register_quest_viewer':
                console.log('Quest viewer registered');
                questViewers.add(ws);
                ws.role = 'quest_viewer';
                if (ipWebcamUrl) {
                    ws.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl }));
                } else {
                    ws.send(JSON.stringify({ type: 'no_stream_url_set' }));
                }
                break;

            case 'set_ip_webcam_url':
                if (ws.role !== 'mobile_configurator') {
                    ws.send(JSON.stringify({type: 'error', message: 'Not authorized to set URL'}));
                    return;
                }
                const newUrl = data.url;
                if (typeof newUrl === 'string' && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
                    ipWebcamUrl = newUrl;
                    console.log('IP Webcam URL set to:', ipWebcamUrl);
                    ws.send(JSON.stringify({ type: 'url_ack', url: ipWebcamUrl, message: 'URL successfully updated on server' }));
                    questViewers.forEach(viewerWs => {
                        if (viewerWs.readyState === WebSocket.OPEN) {
                            viewerWs.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl }));
                        }
                    });
                } else {
                    console.log('Invalid IP Webcam URL received:', newUrl);
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid URL format. Must start with http:// or https://' }));
                }
                break;

            case 'controller_input': // From Quest
                if (ws.role !== 'quest_viewer') {
                    console.log("Controller input from non-Quest client. Ignoring.");
                    return;
                }
                // Relay controller input back to the specific Quest client that sent it
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data)); // data already includes type: 'controller_input'
                }
                break;

            default:
                console.log('Unknown message type:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${data.type}` }));
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected. Role: ${ws.role || 'unknown'}`);
        if (ws.role === 'quest_viewer') {
            questViewers.delete(ws);
            console.log('Quest viewer count:', questViewers.size);
        } else if (ws === mobileConfigurator) {
            mobileConfigurator = null;
            console.log('Mobile configurator disconnected.');
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error (Role: ${ws.role || 'unknown'}):`, error.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access application at: http://localhost:${PORT}/ (or your Render URL)`);
});
