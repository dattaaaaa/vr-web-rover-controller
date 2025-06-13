const localVideo = document.getElementById('localVideo');
const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');

let localStream;
let peerConnection;
let ws;

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const stunServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function updateStatus(message) {
    console.log(message);
    statusDiv.textContent = `Status: ${message}`;
}

async function startStreaming() {
    updateStatus('Requesting camera access...');
    startButton.disabled = true;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
        localVideo.srcObject = localStream;
        updateStatus('Camera access granted. Connecting to server...');
        setupWebSocket();
    } catch (error) {
        console.error('Error accessing media devices.', error);
        updateStatus(`Error accessing media devices: ${error.message}`);
        startButton.disabled = false;
    }
}

function setupWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        updateStatus('Connected to server. Registering as mobile...');
        ws.send(JSON.stringify({ type: 'register_mobile' }));
        // Now wait for Quest to connect and be ready, server will implicitly handle this
        // or we can create an offer immediately if we assume Quest is waiting or will connect soon.
        // For simplicity, let's create offer immediately after Quest signals its ready or is found by server.
        // For now, let's just make the offer once Quest connects (server doesn't explicitly tell mobile).
        // A better flow: Quest registers, server tells mobile "Quest ready", mobile makes offer.
        // Simplified: Mobile makes offer, server holds it or forwards if Quest is there.
        // Let's rely on the server logic: it will forward if Quest is there.
        createPeerConnectionAndOffer();
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        updateStatus(`Received: ${data.type}`);
        console.log('Mobile WS received:', data);

        switch (data.type) {
            case 'answer':
                if (peerConnection) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                    updateStatus('Remote description (answer) set.');
                }
                break;
            case 'candidate':
                if (peerConnection && data.candidate) {
                    try {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                        updateStatus('ICE candidate added.');
                    } catch (e) {
                        console.error('Error adding received ICE candidate', e);
                        updateStatus(`Error adding ICE candidate: ${e.toString()}`);
                    }
                }
                break;
             case 'quest_disconnected': // Example of Quest disconnecting
                updateStatus('Quest disconnected. Stopping stream.');
                stopStreaming();
                break;
        }
    };

    ws.onclose = () => {
        updateStatus('Disconnected from server. Please refresh.');
        startButton.disabled = false;
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus(`WebSocket error: ${error.message}. Please refresh.`);
        startButton.disabled = false;
    };
}

async function createPeerConnectionAndOffer() {
    if (!localStream) {
        updateStatus('Local stream not available.');
        return;
    }
    updateStatus('Creating PeerConnection...');
    peerConnection = new RTCPeerConnection(stunServers);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            updateStatus('Sending ICE candidate...');
            ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection) {
            updateStatus(`ICE connection state: ${peerConnection.iceConnectionState}`);
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                updateStatus('Streaming established!');
            }
             if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
                updateStatus('Streaming failed or disconnected. Retrying or restarting might be needed.');
                // Optionally, try to restart the process or alert the user
            }
        }
    };
    
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });
    updateStatus('Tracks added to PeerConnection.');

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        updateStatus('Offer created and local description set. Sending offer...');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'offer', offer: offer }));
        } else {
            updateStatus('WebSocket not open. Cannot send offer.');
        }
    } catch (error) {
        console.error('Error creating offer:', error);
        updateStatus(`Error creating offer: ${error.message}`);
    }
}

function stopStreaming() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        localVideo.srcObject = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Optionally send a "hangup" or "stop_stream" message
        ws.close(); 
    }
    ws = null;
    updateStatus('Streaming stopped.');
    startButton.disabled = false;
}


startButton.addEventListener('click', startStreaming);

// Check for HTTPS - required for getUserMedia
if (location.protocol !== 'https:') {
    // Only show this warning if not on localhost, as localhost is often trusted
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        statusDiv.innerHTML = '<b>ERROR: This app requires HTTPS to access the camera. Please deploy to a secure server or enable HTTPS locally.</b>';
        startButton.disabled = true;
    }
}