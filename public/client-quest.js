const remoteStreamImg = document.getElementById('remoteStreamImg');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');

let ws;
let xrSession = null;
let xrRefSpace = null;

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

function updateStatus(message, isError = false) {
    console.log(message);
    statusDiv.textContent = `Status: ${message}`;
    statusDiv.style.color = isError ? 'red' : 'inherit';
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already open or connecting.");
        return;
    }
    ws = new WebSocket(WS_URL);
    updateStatus('Attempting to connect to server...');


    ws.onopen = () => {
        updateStatus('Connected to server. Registering as Quest Viewer...');
        ws.send(JSON.stringify({ type: 'register_quest_viewer' }));
        connectButton.style.display = 'none'; // Hide connect button after successful connection
        if (navigator.xr) {
            enterVRButton.style.display = 'inline-block';
        } else {
            updateStatus('WebXR not supported on this browser/device.', true);
        }
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('Quest WS received:', data.type);

        switch (data.type) {
            case 'ip_webcam_url_update':
                if (data.url && typeof data.url === 'string') {
                    updateStatus(`Received IP Webcam URL: ${data.url}`);
                    remoteStreamImg.src = data.url;
                    remoteStreamImg.alt = "Streaming from " + data.url;
                } else {
                    updateStatus('Received invalid or empty IP Webcam URL. Stream will not start.', true);
                    remoteStreamImg.src = "#"; // Clear image or show placeholder
                    remoteStreamImg.alt = "IP Webcam URL not set or invalid.";
                }
                break;
            case 'no_stream_url_set':
                updateStatus('No IP Webcam URL has been set on the server yet. Please use the Mobile Setup page.', true);
                remoteStreamImg.src = "#";
                remoteStreamImg.alt = "IP Webcam URL not set yet on server.";
                break;
            case 'controller_input': // Received its own (or other's) controller data
                updateControllerInfo(data.input);
                break;
            case 'error':
                updateStatus(`Server error: ${data.message}`, true);
                break;
            default:
                console.log("Unknown message from server:", data);
        }
    };

    ws.onclose = (event) => {
        updateStatus(`Disconnected from server (Code: ${event.code}). Please refresh to reconnect.`, true);
        connectButton.disabled = false;
        connectButton.style.display = 'inline-block';
        enterVRButton.style.display = 'none';
        remoteStreamImg.src = "#";
        remoteStreamImg.alt = "Disconnected. Refresh to connect.";
        ws = null;
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
        // onclose will likely be called too
    };
}

// --- WebXR Logic (largely unchanged) ---
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) {
        if (navigator.xr && navigator.xr.isSessionSupported('immersive-vr')) {
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr', {
                    // optionalFeatures: ['local-floor', 'bounded-floor'] // if you need pose tracking relative to floor
                });
                updateStatus('VR Session Started');
                enterVRButton.textContent = 'Exit VR';

                xrSession.addEventListener('end', onXRSessionEnded);
                xrRefSpace = await xrSession.requestReferenceSpace('local');
                xrSession.requestAnimationFrame(onXRFrame);

            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR session: ${e.message}`, true);
            }
        } else {
            updateStatus('Immersive VR not supported or WebXR not available.', true);
        }
    } else {
        await xrSession.end(); // onXRSessionEnded will handle UI updates
    }
});

function onXRSessionEnded() {
    updateStatus('VR Session Ended');
    xrSession = null;
    xrRefSpace = null;
    if (enterVRButton) enterVRButton.textContent = 'Enter VR';
    if (controllerInfoDiv) controllerInfoDiv.textContent = 'Exited VR. Controller input paused.';
}

function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame); // Keep the loop going

    const inputSources = xrSession.inputSources;
    let controllerData = {
        timestamp: time,
        inputs: []
    };

    for (const source of inputSources) {
        if (source.gamepad) {
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
    }

    if (controllerData.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'controller_input', input: controllerData }));
    }
}

// Check for HTTPS if deploying (Render provides this)
// For local IP webcam (HTTP) on an HTTPS page (Render), this can cause mixed content issues.
// The Quest browser might need to allow insecure content for your Render domain if the stream is HTTP.
// Or run everything locally on HTTP for testing.
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    statusDiv.innerHTML = '<b>WARNING: For WebXR features, HTTPS is usually required. This page might not work as expected if not on HTTPS or localhost.</b>';
    // Don't disable buttons, as Render will provide HTTPS.
}
