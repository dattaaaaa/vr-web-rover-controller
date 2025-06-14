const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios'); // For making HTTP requests to the IP Webcam

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let ipWebcamUrl = null; // Store the current IP Webcam URL (e.g., http://PHONE_IP:8080/video)
let questViewers = new Set();
let mobileConfigurator = null;

// Store the active connection to the IP webcam to avoid multiple connections
// and to allow proper cleanup.
let ipWebcamStreamRequest = null;
let connectedClientsToProxy = 0;


// --- MJPEG Proxy Endpoint ---
app.get('/proxied-stream', async (req, res) => {
    if (!ipWebcamUrl) {
        return res.status(404).contentType('text/plain').send('IP Webcam URL not set on server.');
    }

    console.log(`Proxy: Client connected. Requesting stream from: ${ipWebcamUrl}`);
    connectedClientsToProxy++;

    // Set headers for MJPEG stream
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
            responseType: 'stream', // Crucial for handling the stream
            timeout: 10000, // 10 second timeout for initial connection
        });

        // Pipe the stream from the IP webcam directly to the client's response
        currentRequestToIpCam.data.pipe(res);

        currentRequestToIpCam.data.on('error', (err) => {
            console.error('Proxy: Error in stream from IP Webcam:', err.message);
            if (!res.headersSent) {
                res.status(502).contentType('text/plain').send('Error streaming from IP Webcam.');
            } else {
                res.end(); // End the client response if already started
            }
        });

        currentRequestToIpCam.data.on('end', () => {
            console.log('Proxy: Stream from IP Webcam ended.');
            res.end(); // Ensure client response is ended
        });

    } catch (error) {
        console.error('Proxy: Failed to connect to IP Webcam:', error.message);
        if (error.code === 'ECONNREFUSED') {
             return res.status(502).contentType('text/plain').send('Proxy: Could not connect to IP Webcam (Connection Refused).');
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
             return res.status(504).contentType('text/plain').send('Proxy: Connection to IP Webcam timed out.');
        }
        return res.status(500).contentType('text/plain').send('Proxy: Error connecting to IP Webcam.');
    }

    // Handle client disconnection from the proxy
    req.on('close', () => {
        connectedClientsToProxy--;
        console.log(`Proxy: Client disconnected. Remaining proxy clients: ${connectedClientsToProxy}`);
        if (currentRequestToIpCam && typeof currentRequestToIpCam.request?.abort === 'function') {
            console.log('Proxy: Aborting request to IP Webcam as client disconnected.');
            currentRequestToIpCam.request.abort(); // Abort the underlying HTTP request
        } else if (currentRequestToIpCam && typeof currentRequestToIpCam.data?.destroy === 'function') {
            // For streams that might not have .request.abort() directly on the axios response
            console.log('Proxy: Destroying stream to IP Webcam as client disconnected.');
            currentRequestToIpCam.data.destroy();
        }
    });
});


// --- WebSocket Logic (largely unchanged) ---
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

        console.log(`WebSocket: Received from ${ws.role || 'unknown'}:`, data.type);

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
                    // Inform client about the original URL, but it will use the proxied path
                    ws.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl, useProxy: true }));
                } else {
                    ws.send(JSON.stringify({ type: 'no_stream_url_set' }));
                }
                break;

            case 'set_ip_webcam_.url':
                if (ws.role !== 'mobile_configurator') {
                    ws.send(JSON.stringify({type: 'error', message: 'Not authorized to set URL'}));
                    return;
                }
                const newUrl = data.url;
                if (typeof newUrl === 'string' && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
                    const oldUrl = ipWebcamUrl;
                    ipWebcamUrl = newUrl;
                    console.log('WebSocket: IP Webcam URL set to:', ipWebcamUrl);
                    ws.send(JSON.stringify({ type: 'url_ack', url: ipWebcamUrl, message: 'URL successfully updated on server' }));
                    
                    // Notify all Quest viewers about the URL change
                    questViewers.forEach(viewerWs => {
                        if (viewerWs.readyState === WebSocket.OPEN) {
                            viewerWs.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl, useProxy: true }));
                        }
                    });

                    // If URL changed and there was an active stream, it should naturally be re-established
                    // by clients re-requesting the /proxied-stream endpoint.
                    // The old axios request for the old ipWebcamUrl would have been aborted by client disconnect
                    // or will eventually time out or error out.

                } else {
                    console.log('WebSocket: Invalid IP Webcam URL received:', newUrl);
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid URL format. Must start with http:// or https://' }));
                }
                break;

            case 'controller_input':
                if (ws.role !== 'quest_viewer') return;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data));
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
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access application at: http://localhost:${PORT}/ (or your Render URL)`);
});
