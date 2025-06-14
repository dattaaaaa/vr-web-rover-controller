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

let connectedClientsToProxy = 0;


// --- MJPEG Proxy Endpoint ---
app.get('/proxied-stream', async (req, res) => {
    if (!ipWebcamUrl) {
        return res.status(404).contentType('text/plain').send('IP Webcam URL not set on server.');
    }

    console.log(`Proxy: Client connected. Requesting stream from: ${ipWebcamUrl}`);
    connectedClientsToProxy++;

    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=--jpgboundary', // Common boundary
        'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache'
    });

    let currentRequestToIpCam; // To hold the axios request object

    try {
        currentRequestToIpCam = await axios({
            method: 'get',
            url: ipWebcamUrl,
            responseType: 'stream',
            timeout: 10000, // 10-second timeout for initial connection
        });

        currentRequestToIpCam.data.pipe(res);

        currentRequestToIpCam.data.on('error', (err) => {
            console.error('Proxy: Error in stream from IP Webcam:', err.message);
            if (!res.headersSent) {
                // If headers not sent, we can send a proper error status
                res.status(502).contentType('text/plain').send('Error streaming from IP Webcam.');
            } else {
                // If headers already sent, we can only abruptly end the response
                res.end();
            }
        });

        currentRequestToIpCam.data.on('end', () => {
            console.log('Proxy: Stream from IP Webcam ended.');
            res.end(); // Ensure client response is ended
        });

    } catch (error) {
        console.error('Proxy: Failed to connect to IP Webcam:', error.message);
        // Ensure error response is sent only if headers haven't been sent.
        // This catch block is for errors during the *initial* axios request.
        if (!res.headersSent) {
            if (error.code === 'ECONNREFUSED') {
                 res.status(502).contentType('text/plain').send('Proxy: Could not connect to IP Webcam (Connection Refused).');
            } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                 res.status(504).contentType('text/plain').send('Proxy: Connection to IP Webcam timed out.');
            } else {
                 res.status(500).contentType('text/plain').send('Proxy: Error connecting to IP Webcam.');
            }
        } else {
            res.end(); // If headers sent, just end.
        }
        return; // Important: exit after sending error
    }

    req.on('close', () => {
        connectedClientsToProxy--;
        console.log(`Proxy: Client disconnected. Remaining proxy clients: ${connectedClientsToProxy}`);
        // Attempt to abort the connection to the IP webcam
        if (currentRequestToIpCam && typeof currentRequestToIpCam.request?.abort === 'function') {
            console.log('Proxy: Aborting request to IP Webcam as client disconnected.');
            currentRequestToIpCam.request.abort();
        } else if (currentRequestToIpCam && typeof currentRequestToIpCam.data?.destroy === 'function') {
            console.log('Proxy: Destroying stream to IP Webcam as client disconnected.');
            currentRequestToIpCam.data.destroy();
        }
    });
});


// --- WebSocket Logic ---
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
                break; // Added break

            case 'register_quest_viewer':
                console.log('WebSocket: Quest viewer registered');
                questViewers.add(ws);
                ws.role = 'quest_viewer';
                if (ipWebcamUrl) {
                    ws.send(JSON.stringify({ type: 'ip_webcam_url_update', url: ipWebcamUrl, useProxy: true }));
                } else {
                    ws.send(JSON.stringify({ type: 'no_stream_url_set' }));
                }
                break; // Added break

            // THIS IS THE CORRECTED CASE NAME
            case 'set_ip_webcam_url': // *** CHECKED THIS CASE NAME and logic ***
                if (ws.role !== 'mobile_configurator') {
                    ws.send(JSON.stringify({type: 'error', message: 'Not authorized to set URL'}));
                    return; // Return early if not authorized
                }
                const newUrl = data.url;
                if (typeof newUrl === 'string' && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
                    // const oldUrl = ipWebcamUrl; // Not strictly needed here
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
                break; // Added break, this was likely the culprit if missing

            case 'controller_input':
                if (ws.role !== 'quest_viewer') {
                     // Optionally log or handle this case
                    console.log("WebSocket: Controller input from non-Quest client, ignoring.");
                    return; // Return early
                }
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data)); // Forward data as is
                }
                break; // Added break

            default:
                console.log('WebSocket: Unknown message type:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${data.type}` }));
                // No break needed here as it's the last case in the switch.
        } // End of switch
    }); // End of ws.on('message')

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
}); // End of wss.on('connection')  <--- This is line 196 in the previous version, or around it.

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access application at: http://localhost:${PORT}/ (or your Render URL)`);
});
