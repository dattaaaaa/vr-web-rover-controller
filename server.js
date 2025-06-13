const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Store clients. For simplicity, we assume one mobile and one quest.
// In a more robust app, you'd use rooms or session IDs.
let mobileClient = null;
let questClient = null;

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON message:', message);
            return;
        }

        console.log('Received:', data.type);

        switch (data.type) {
            case 'register_mobile':
                console.log('Mobile registered');
                mobileClient = ws;
                ws.role = 'mobile';
                break;
            case 'register_quest':
                console.log('Quest registered');
                questClient = ws;
                ws.role = 'quest';
                // If mobile is already waiting, notify quest
                if (mobileClient && mobileClient.readyState === WebSocket.OPEN) {
                    questClient.send(JSON.stringify({ type: 'mobile_ready' }));
                }
                break;
            case 'offer':
                // Forward offer from mobile to quest
                if (questClient && questClient.readyState === WebSocket.OPEN) {
                    console.log('Forwarding offer to Quest');
                    questClient.send(JSON.stringify(data));
                } else {
                    console.log('Quest not ready for offer');
                }
                break;
            case 'answer':
                // Forward answer from quest to mobile
                if (mobileClient && mobileClient.readyState === WebSocket.OPEN) {
                    console.log('Forwarding answer to Mobile');
                    mobileClient.send(JSON.stringify(data));
                } else {
                    console.log('Mobile not ready for answer');
                }
                break;
            case 'candidate':
                // Forward ICE candidate to the other client
                if (ws.role === 'mobile' && questClient && questClient.readyState === WebSocket.OPEN) {
                    console.log('Forwarding candidate from Mobile to Quest');
                    questClient.send(JSON.stringify(data));
                } else if (ws.role === 'quest' && mobileClient && mobileClient.readyState === WebSocket.OPEN) {
                    console.log('Forwarding candidate from Quest to Mobile');
                    mobileClient.send(JSON.stringify(data));
                }
                break;
            case 'controller_input':
                // Broadcast controller input to Quest client (for display)
                // In this setup, the Quest client itself is displaying its own input.
                // If other clients needed to see it, you'd broadcast more widely.
                if (questClient && questClient.readyState === WebSocket.OPEN) {
                    console.log('Sending controller input back to Quest');
                    questClient.send(JSON.stringify(data));
                }
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected. Role:', ws.role);
        if (ws.role === 'mobile') {
            mobileClient = null;
            if (questClient && questClient.readyState === WebSocket.OPEN) {
                questClient.send(JSON.stringify({ type: 'mobile_disconnected' }));
            }
        } else if (ws.role === 'quest') {
            questClient = null;
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT}/mobile.html on your phone`);
    console.log(`Open http://localhost:${PORT}/quest.html on your Quest`);
});