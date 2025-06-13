const remoteVideo = document.getElementById('remoteVideo');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');

let peerConnection;
let ws;
let xrSession = null;
let xrRefSpace = null;

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

function updateControllerInfo(data) {
    controllerInfoDiv.textContent = JSON.stringify(data, null, 2);
}

connectButton.addEventListener('click', () => {
    connectButton.disabled = true;
    updateStatus('Connecting to server...');
    setupWebSocket();
});


function setupWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        updateStatus('Connected to server. Registering as Quest...');
        ws.send(JSON.stringify({ type: 'register_quest' }));
        // Now ready to receive offers or candidates
        if (navigator.xr) {
            enterVRButton.style.display = 'inline-block';
        } else {
            updateStatus('WebXR not supported on this browser/device.');
        }
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        updateStatus(`Received: ${data.type}`);
        console.log('Quest WS received:', data);

        switch (data.type) {
            case 'mobile_ready': // Server indicates mobile is connected and likely sent an offer
                updateStatus('Mobile is ready. Waiting for offer.');
                // No specific action here, server will forward the offer
                break;
            case 'offer':
                if (!peerConnection) { // Create PC if not already (e.g. from a previous failed attempt)
                    createPeerConnection();
                }
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
                updateStatus('Remote description (offer) set. Creating answer...');
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                updateStatus('Answer created and local description set. Sending answer...');
                ws.send(JSON.stringify({ type: 'answer', answer: answer }));
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
            case 'controller_input': // Received its own (or other's) controller data
                updateControllerInfo(data.input);
                break;
            case 'mobile_disconnected':
                updateStatus('Mobile disconnected. Stream stopped.');
                if (peerConnection) {
                    peerConnection.close();
                    peerConnection = null;
                }
                remoteVideo.srcObject = null;
                connectButton.disabled = false; // Allow trying to reconnect
                break;
        }
    };

    ws.onclose = () => {
        updateStatus('Disconnected from server. Please refresh to reconnect.');
        connectButton.disabled = false;
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus(`WebSocket error: ${error.message}. Please refresh.`);
        connectButton.disabled = false;
    };
}

function createPeerConnection() {
    updateStatus('Creating PeerConnection...');
    peerConnection = new RTCPeerConnection(stunServers);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            updateStatus('Sending ICE candidate...');
            ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
        }
    };

    peerConnection.ontrack = (event) => {
        updateStatus('Remote track received!');
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        } else {
            // For older browsers
            let inboundStream = new MediaStream();
            inboundStream.addTrack(event.track);
            remoteVideo.srcObject = inboundStream;
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection) {
            updateStatus(`ICE connection state: ${peerConnection.iceConnectionState}`);
             if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                updateStatus('Streaming established!');
            }
            if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
                updateStatus('Streaming failed or disconnected.');
                // Optionally attempt to re-establish or notify user
                if (peerConnection) {
                    peerConnection.close();
                    peerConnection = null;
                }
                remoteVideo.srcObject = null; // Clear video
                connectButton.disabled = false; // Allow trying to reconnect
            }
        }
    };
}

// --- WebXR ---
enterVRButton.addEventListener('click', async () => {
    if (navigator.xr) {
        try {
            // Request an immersive VR session.
            xrSession = await navigator.xr.requestSession('immersive-vr', {
                // optionalFeatures: ['local-floor', 'bounded-floor'] // if you need pose tracking relative to floor
            });
            updateStatus('VR Session Started');
            enterVRButton.textContent = 'Exit VR';

            xrSession.addEventListener('end', () => {
                updateStatus('VR Session Ended');
                xrSession = null;
                enterVRButton.textContent = 'Enter VR';
                controllerInfoDiv.textContent = 'Exited VR. Controller input paused.';
            });

            // Set up a reference space.
            xrRefSpace = await xrSession.requestReferenceSpace('local'); // 'viewer' or 'local' or 'local-floor'

            // Start the render loop.
            xrSession.requestAnimationFrame(onXRFrame);

        } catch (e) {
            console.error('Failed to start XR session:', e);
            updateStatus(`Failed to start XR session: ${e.message}`);
        }
    } else {
        updateStatus('WebXR not available.');
    }
});


function onXRFrame(time, frame) {
    if (!xrSession) return;

    xrSession.requestAnimationFrame(onXRFrame); // Keep the loop going

    const inputSources = xrSession.inputSources;
    let controllerData = {
        timestamp: time,
        inputs: []
    };

    for (const source of inputSources) {
        if (source.gamepad) { // Check if it has gamepad data (controllers do)
            let inputDetail = {
                handedness: source.handedness, // "left", "right", or "none"
                buttons: [],
                axes: Array.from(source.gamepad.axes) // Thumbstick [x, y]
            };

            source.gamepad.buttons.forEach((button, index) => {
                inputDetail.buttons.push({
                    index: index,
                    pressed: button.pressed,
                    touched: button.touched,
                    value: button.value
                });
            });
            controllerData.inputs.push(inputDetail);
        }

        // Example: Detect 'select' event (trigger press)
        // These events are often more reliable than polling gamepad.pressed
        source.addEventListener('selectstart', (event) => handleControllerEvent(event, 'selectstart'));
        source.addEventListener('selectend', (event) => handleControllerEvent(event, 'selectend'));
        source.addEventListener('squeezestart', (event) => handleControllerEvent(event, 'squeezestart'));
        source.addEventListener('squeezeend', (event) => handleControllerEvent(event, 'squeezeend'));
    }

    if (controllerData.inputs.length > 0) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'controller_input', input: controllerData }));
        }
        // updateControllerInfo(controllerData); // Optionally display locally immediately
    }
}

function handleControllerEvent(event, eventType) {
    const source = event.inputSource;
    const data = {
        type: 'controller_event',
        eventType: eventType,
        handedness: source.handedness,
        timestamp: performance.now()
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'controller_input', input: data }));
    }
    // updateControllerInfo(data); // Optionally display locally immediately
}

// Check for HTTPS - required for WebXR
if (location.protocol !== 'https:') {
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        statusDiv.innerHTML = '<b>ERROR: This app requires HTTPS for WebXR. Please deploy to a secure server or enable HTTPS locally.</b>';
        connectButton.disabled = true;
        enterVRButton.disabled = true;
    }
}