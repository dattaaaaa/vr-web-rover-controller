const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');

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

wss.on('connection', (ws) => { // START OF BLOCK 1
    console.log('WebSocket: Client connected');

    ws.on('message', (message) => { // START OF BLOCK 2
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('WebSocket: Invalid JSON message:', message.toString());
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format' }));
            return;
        }
        console.log(`WebSocket: Received from ${ws.role || 'unknown'}:`, data.type);

        switch (data.type) { // START OF BLOCK 3
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
                    // return; // Using return inside switch case is fine, but break is more conventional if not last op
                } else { // Added else to make sure only one path is taken if authorized
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
                } // End of else block
                break;

            case 'controller_input':
                if (ws.role !== 'quest_viewer') {
                    console.log("WebSocket: Controller input from non-Quest client, ignoring.");
                    // return; // Using return is fine
                } else { // Added else
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(data));
                    }
                }
                break;

            default:
                console.log('WebSocket: Unknown message type:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${data.type}` }));
                // No break needed for default if it's the last case.
        } // END OF BLOCK 3 (switch)
    }); // END OF BLOCK 2 (ws.on('message'))

    ws.on('close', () => { // START OF BLOCK 4
        console.log(`WebSocket: Client disconnected. Role: ${ws.role || 'unknown'}`);
        if (ws.role === 'quest_viewer') {
            questViewers.delete(ws);
            console.log('WebSocket: Quest viewer count:', questViewers.size);
        } else if (ws === mobileConfigurator) {
            mobileConfigurator = null;
            console.log('WebSocket: Mobile configurator disconnected.');
        }
    }); // END OF BLOCK 4 (ws.on('close'))

    ws.onerror = (error) => { // START OF BLOCK 5
        console.error(`WebSocket error (Role: ${ws.role || 'unknown'}):`, error.message);
    }); // END OF BLOCK 5 (ws.onerror)

}); // END OF BLOCK 1 (wss.on('connection'))  <--- THIS IS STILL THE LINE IN QUESTION

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access application at: http://localhost:${PORT}/ (or your Render URL)`);
});
